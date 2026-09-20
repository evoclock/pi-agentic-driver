// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Provider architecture (§7, review fix #2, authoritative owner decision):
//
//   1. typesafe-direct    — THE SOLE PROVIDER (owner decision): the official
//                           @typesafe-ai/sdk (`TypeSafeClient.systemOne`)
//                           with the owner's direct API key from the macOS
//                           Keychain (account `typesafe-ai`, service
//                           `Typesafe AI`). The Vercel AI Gateway and the
//                           merge gateway are DROPPED — there is no fallback
//                           transport, and an unconfigured TypeSafe Direct
//                           fails closed with the existing error taxonomy.
//
// Invariants enforced here:
//   - The question TEXT is always sent to the provider, verbatim, first.
//     Optional framing instructions are appended in an unambiguous,
//     clearly-delimited block (review fix #1). Missing/blank question text
//     is impossible past schema enforcement (validation_error upstream) —
//     no synthetic `question[i]` placeholder is ever constructed.
//   - Question semantics are IDENTICAL across adapters: every adapter maps
//     the same transport contract (question text + framing + criteria) to
//     its provider's helpers (TypeSafe `noul`/`choice`/`score`; AI SDK
//     evaluation questions). Mapping tests assert shape equality.
//   - Exactly ONE identical-request failover attempt on eligible transport
//     failures (timeout / unavailable / credential). No failover on
//     validation, schema, or budget errors.
//   - Failed-attempt usage is never lost: every terminal chain failure
//     carries ALL accumulated attempt usage (including the terminal
//     attempt) so the Evaluator can charge it exactly once (review fix #12).
//   - SDK-level retries are disabled (maxRetries = 0) so janus owns the
//     retry policy and budget accounting (review fix #12).
//   - Public error messages are FIXED strings; provider/SDK/internal error
//     text never reaches HTTP callers (review fix #5).

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  choice as tsChoice,
  noul as tsNoul,
  score as tsScore,
  type EntryType,
} from "@typesafe-ai/sdk";
import type { ProviderConfig, ProviderId } from "./config.js";
import { gatewayUnavailable, modelUnauthorized, timeoutError, type JanusError } from "./errors.js";

export const TYPESAFE_SDK_VERSION = "0.6.0";

// ---------------------------------------------------------------------------
// Transport contract (provider-independent)
// ---------------------------------------------------------------------------

export interface TransportQuestion {
  /** Stable, non-sensitive question identifier (answer key + audit name). */
  name: string;
  /** Question kind, identical across adapters. */
  kind: "boolean" | "choice" | "score";
  /** The question text — ALWAYS sent to the provider, verbatim. */
  question: string;
  /** Optional framing instructions, appended unambiguously after the question. */
  instructions: string;
  /** choice → candidate set. */
  choices?: string[] | undefined;
  /** boolean → optional true/false criteria labels. */
  sdkCriteria?: { true?: string | null; false?: string | null } | undefined;
}

export interface TransportRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: TransportQuestion[];
}

export interface TransportUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

export interface TransportResult {
  /** Raw provider answers keyed by question NAME. */
  answers: Record<string, unknown>;
  usage: TransportUsage;
  modelId: string;
}

/**
 * A provider adapter. `key` is injected per call (fresh from the Keychain);
 * adapters never persist or log it.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  evaluate(request: TransportRequest, key: string, signal: AbortSignal): Promise<TransportResult>;
}

/**
 * Fixed public failure classification. `message` is always a fixed string —
 * never provider error text.
 */
export interface ClassifiedFailure {
  error: JanusError;
  /** Whether the failover policy may try the next provider once. */
  failoverEligible: boolean;
  /** Usage observed before the failure, when the provider reported any. */
  usage?: TransportUsage | undefined;
}

// ---------------------------------------------------------------------------
// Question composition (review fix #1)
// ---------------------------------------------------------------------------

/**
 * Compose the payload actually sent to the provider. The question text is
 * ALWAYS present and first; framing instructions (when any) are appended in
 * an explicitly delimited block so the model can never confuse framing with
 * the question itself.
 */
export function composeQuestionPayload(
  question: string,
  instructions: string,
): { question: string; framing: string | null } {
  const trimmedQuestion = question;
  if (instructions.length === 0) {
    return { question: trimmedQuestion, framing: null };
  }
  return {
    question: trimmedQuestion,
    framing:
      `[Additional framing instructions — context only, not part of the question:]\n` +
      instructions,
  };
}

/** Full text sent as the provider question: question first, framing after. */
export function providerQuestionText(question: TransportQuestion): string {
  const { question: q, framing } = composeQuestionPayload(question.question, question.instructions);
  return framing === null ? q : `${q}\n\n${framing}`;
}

// ---------------------------------------------------------------------------
// typesafe-direct adapter (PRIMARY) — official @typesafe-ai/sdk
// ---------------------------------------------------------------------------

/** Minimal structural client surface, injectable for tests (no network). */
export interface TypeSafeClientLike {
  systemOne(
    request: {
      state: EntryType;
      questions: Record<string, TypesafeQuestion>;
    },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{
    answers: Record<
      string,
      | { type: "noul"; noul: number }
      | { type: "choice"; choice: string; probabilities?: Record<string, number> }
      | { type: "score"; score: number; probabilities?: Record<string, number> }
    >;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  }>;
}

/** Score vocabulary sent identically by every adapter (§6: 0..5). */
export const SCORE_LABELS = ["0", "1", "2", "3", "4", "5"] as const;

/** Map a transport question to the TypeSafe question shape. */
export function toTypesafeQuestion(question: TransportQuestion): ReturnType<typeof buildTypesafeQuestion> {
  return buildTypesafeQuestion(question);
}

/** Structural question shape accepted by the TypeSafe client (tests inject mocks of this). */
export type TypesafeQuestion =
  | { type: "noul"; instructions?: EntryType; criteria?: { true?: EntryType; false?: EntryType } | null }
  | { type: "choice"; instructions?: EntryType; criteria: Record<string, EntryType> }
  | { type: "score"; instructions?: EntryType; criteria: readonly [EntryType, EntryType, ...EntryType[]] };

function buildTypesafeQuestion(question: TransportQuestion): TypesafeQuestion {
  const instructions = providerQuestionText(question);
  switch (question.kind) {
    case "boolean": {
      const criteria: { true?: EntryType; false?: EntryType } = {};
      if (question.sdkCriteria?.true !== undefined) criteria.true = question.sdkCriteria.true;
      if (question.sdkCriteria?.false !== undefined) criteria.false = question.sdkCriteria.false;
      return Object.keys(criteria).length > 0
        ? tsNoul(instructions, criteria)
        : tsNoul(instructions);
    }
    case "choice": {
      const criteria: Record<string, EntryType> = {};
      for (const option of question.choices ?? []) criteria[option] = null;
      return tsChoice(instructions, criteria);
    }
    case "score":
      return tsScore(instructions, [...SCORE_LABELS] as [EntryType, EntryType, ...EntryType[]]);
  }
}

export class TypesafeDirectAdapter implements ProviderAdapter {
  readonly id = "typesafe-direct" as const;

  constructor(
    /** Injected for tests; defaults to the real official SDK client. */
    private readonly clientFactory: (apiKey: string) => TypeSafeClientLike = (apiKey) =>
      new TypeSafeClient({
        apiKey,
        // janus owns retries and failover (review fix #12): no SDK retries.
        retry: { maxRetries: 0 },
        // No SDK logging of request bodies or error details.
        logLevel: "off",
      }),
  ) {}

  async evaluate(request: TransportRequest, key: string, signal: AbortSignal): Promise<TransportResult> {
    const client = this.clientFactory(key);
    const questions: Record<string, TypesafeQuestion> = {};
    for (const question of request.questions) {
      questions[question.name] = buildTypesafeQuestion(question);
    }
    let result;
    try {
      result = await client.systemOne(
        {
          state: request.state as EntryType,
          questions: questions as Parameters<TypeSafeClientLike["systemOne"]>[0]["questions"],
        },
        { signal },
      );
    } catch (error) {
      throw classifyTypesafeError(error);
    }
    const answers: Record<string, unknown> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      if (answer.type === "noul") {
        answers[name] = { type: "boolean", probability: answer.noul };
      } else if (answer.type === "choice") {
        answers[name] = {
          type: "choice",
          choice: answer.choice,
          ...(answer.probabilities !== undefined ? { probabilities: answer.probabilities } : {}),
        };
      } else {
        answers[name] = {
          type: "score",
          score: answer.score,
          ...(answer.probabilities !== undefined ? { probabilities: answer.probabilities } : {}),
        };
      }
    }
    return {
      answers,
      usage: {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens,
      },
      modelId: result.model,
    };
  }
}

/** Classify a TypeSafe SDK error into a fixed-public-message failure. */
export function classifyTypesafeError(error: unknown): ProviderTransportError {
  if (error instanceof ProviderTransportError) return error;
  if (error instanceof APIUserAbortError) {
    return new ProviderTransportError("timeout", timeoutError("evaluation timed out"));
  }
  if (error instanceof APITimeoutError || error instanceof APIConnectionError) {
    return new ProviderTransportError(
      "gateway_unavailable",
      gatewayUnavailable("provider unreachable or timed out"),
    );
  }
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) {
      return new ProviderTransportError(
        "model_unauthorized",
        modelUnauthorized("provider rejected the credential"),
      );
    }
    if (error.status === 429) {
      return new ProviderTransportError(
        "gateway_unavailable",
        gatewayUnavailable("provider rate limit reached"),
      );
    }
    if (error.status === 404) {
      return new ProviderTransportError(
        "gateway_unavailable",
        gatewayUnavailable("model not available on the provider"),
      );
    }
    return new ProviderTransportError(
      "gateway_unavailable",
      gatewayUnavailable("provider evaluation failed"),
    );
  }
  if (error instanceof TypeSafeError) {
    return new ProviderTransportError(
      "gateway_unavailable",
      gatewayUnavailable("provider evaluation failed"),
    );
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new ProviderTransportError("timeout", timeoutError("evaluation timed out"));
  }
  return new ProviderTransportError(
    "gateway_unavailable",
    gatewayUnavailable("provider evaluation failed"),
  );
}

// ---------------------------------------------------------------------------
// Raw-error classification (fixed public messages)
// ---------------------------------------------------------------------------

/** Classify a raw (non-janus) error into a fixed-public-message failure. */
export function classifyGatewayError(error: unknown): ProviderTransportError {
  if (error instanceof ProviderTransportError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`.toLowerCase();

  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderTransportError("timeout", timeoutError("evaluation timed out"));
  }
  if (/abort/.test(text) && /timeout|timed out|signal is aborted/.test(text)) {
    return new ProviderTransportError("timeout", timeoutError("evaluation timed out"));
  }
  if (/401|unauthorized|invalid api key|authentication|api key/i.test(message)) {
    return new ProviderTransportError(
      "model_unauthorized",
      modelUnauthorized("provider rejected the credential"),
    );
  }
  if (/403|forbidden/i.test(message)) {
    return new ProviderTransportError(
      "model_unauthorized",
      modelUnauthorized("provider refused access"),
    );
  }
  if (/404|not found|no such model|model_not_found/i.test(message)) {
    return new ProviderTransportError(
      "gateway_unavailable",
      gatewayUnavailable("model not available on the provider"),
    );
  }
  if (/429|rate limit|quota/i.test(message)) {
    return new ProviderTransportError(
      "gateway_unavailable",
      gatewayUnavailable("provider rate limit reached"),
    );
  }
  if (/econnrefused|enotfound|etimedout|econnreset|fetch failed|network|socket|dns/i.test(text)) {
    return new ProviderTransportError(
      "gateway_unavailable",
      gatewayUnavailable("provider unreachable"),
    );
  }
  return new ProviderTransportError(
    "gateway_unavailable",
    gatewayUnavailable("provider evaluation failed"),
  );
}

// ---------------------------------------------------------------------------
// Failover chain
// ---------------------------------------------------------------------------

/**
 * Terminal chain failure. Carries the taxonomy error PLUS every failed
 * attempt's accumulated usage (including the terminal attempt) so the
 * Evaluator can charge all real provider consumption exactly once even when
 * the chain ultimately throws (review fix #12).
 */
export class ProviderChainError extends Error {
  constructor(
    readonly failure: JanusError,
    readonly failedAttemptUsage: TransportUsage[],
  ) {
    super(failure.message);
    this.name = "ProviderChainError";
  }
}

/** A transport-level failure carrying its fixed classification. */
export class ProviderTransportError extends Error {
  readonly failure: ClassifiedFailure;

  constructor(code: ClassifiedFailure["error"]["code"], error: JanusError, usage?: TransportUsage) {
    super(error.message);
    this.name = "ProviderTransportError";
    this.failure = { error, failoverEligible: FAILOVER_ELIGIBLE.has(code), usage };
  }
}

/** Failover is allowed ONLY for transport-level failures (review fix #2). */
const FAILOVER_ELIGIBLE: ReadonlySet<string> = new Set([
  "gateway_unavailable",
  "timeout",
  "model_unauthorized",
]);

export interface ChainEvaluateOutcome {
  result: TransportResult;
  /** Provider id that produced the result. */
  provider: ProviderId;
  /** How many provider attempts were consumed (1 = no failover). */
  attempts: number;
  /** Usage observed from failed attempts, when the provider reported any. */
  failedAttemptUsage: TransportUsage[];
}

export interface KeyResolutionLike {
  status: "resolved" | "missing" | "failed";
  key?: string;
  reason?: string;
}

export type KeyReader = (ref: ProviderConfig["keychain"]) => Promise<KeyResolutionLike>;

/** Default key reader: the guarded Keychain capture. */
export const defaultKeyReader: KeyReader = async (ref) => {
  const { readGatewayKey } = await import("./keychain.js");
  const resolution = await readGatewayKey(ref);
  return resolution.status === "resolved"
    ? { status: "resolved", key: resolution.key }
    : { status: resolution.status, reason: resolution.reason };
};

export class ProviderChain {
  private readonly adapters: Map<ProviderId, ProviderAdapter>;

  constructor(
    private readonly configs: readonly ProviderConfig[],
    adapters: readonly ProviderAdapter[],
    private readonly readKey: KeyReader = defaultKeyReader,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  /**
   * Evaluate with exactly one identical-request failover attempt on eligible
   * transport failures. A missing/failed key on one provider counts as that
   * provider being unavailable and moves to the next (so a missing fallback
   * key never blocks a healthy primary, and vice versa).
   */
  async evaluate(
    request: TransportRequest,
    signal: AbortSignal,
    providers: readonly ProviderConfig[] = this.configs,
  ): Promise<ChainEvaluateOutcome> {
    const failedAttemptUsage: TransportUsage[] = [];
    let attempts = 0;
    let lastFailure: ProviderTransportError | undefined;

    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index]!;
      const adapter = this.adapters.get(provider.id);
      if (adapter === undefined) {
        lastFailure = new ProviderTransportError(
          "gateway_unavailable",
          gatewayUnavailable(`no adapter configured for provider ${provider.id}`),
        );
        continue;
      }

      // The failover policy allows exactly ONE failover attempt: the first
      // eligible failure moves to the next provider; a second failure ends
      // the chain even if more providers are configured.
      if (attempts >= 2) break;

      const keyResolution = await this.readKey(provider.keychain);
      if (keyResolution.status !== "resolved" || keyResolution.key === undefined) {
        attempts += 1;
        lastFailure = new ProviderTransportError(
          "model_unauthorized",
          modelUnauthorized(`provider credential unavailable for ${provider.id}`),
        );
        continue;
      }

      attempts += 1;
      try {
        const result = await adapter.evaluate(request, keyResolution.key, signal);
        return { result, provider: provider.id, attempts, failedAttemptUsage };
      } catch (error) {
        const failure =
          error instanceof ProviderTransportError
            ? error
            : // Raw errors from adapters (including test mocks) go through
              // the same fixed-public classification.
              classifyGatewayError(error);
        lastFailure = failure;
        if (failure.failure.usage !== undefined) {
          failedAttemptUsage.push(failure.failure.usage);
        }
        const next = providers[index + 1];
        if (failure.failure.failoverEligible && next !== undefined) {
          continue; // the single failover attempt
        }
        // Terminal: the taxonomy error travels with ALL accumulated attempt
        // usage so nothing is uncharged (review fix #12).
        throw new ProviderChainError(failure.failure.error, failedAttemptUsage);
      }
    }

    throw new ProviderChainError(
      lastFailure?.failure.error ?? gatewayUnavailable("no provider produced a verdict"),
      failedAttemptUsage,
    );
  }

  /**
   * Readiness: ready when at least one configured provider has a resolvable
   * key. The primary being healthy is sufficient on its own — missing
   * fallback keys never block readiness. Reasons are sanitized (provider
   * ids only; never Keychain stderr or key fragments).
   */
  async readiness(
    providers: readonly ProviderConfig[] = this.configs,
  ): Promise<{ ready: boolean; reason?: string; providers: { id: ProviderId; ready: boolean }[] }> {
    const statuses: { id: ProviderId; ready: boolean }[] = [];
    for (const provider of providers) {
      const resolution = await this.readKey(provider.keychain);
      statuses.push({ id: provider.id, ready: resolution.status === "resolved" });
    }
    const ready = statuses.some((entry) => entry.ready);
    if (ready) return { ready, providers: statuses };
    return {
      ready,
      reason: `no provider credential resolvable (checked: ${statuses.map((s) => s.id).join(", ")})`,
      providers: statuses,
    };
  }
}

/** Build the adapter set for a provider chain (production wiring). */
export function defaultAdapters(): ProviderAdapter[] {
  return [new TypesafeDirectAdapter()];
}
