// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// The /evaluate pipeline: schema enforcement → budget → redaction
// (unconditional) → budget breaker → digest + single-flight → provider chain
// (direct TypeSafe primary, configured fallbacks, exactly one identical-
// request failover on eligible transport failures) → verdict enforcement →
// audit. Every failure path lands in the §5 error taxonomy with a request id
// and a FIXED public message — provider/SDK/Keychain/internal error text
// never reaches an HTTP caller (review fix #5).

import { randomUUID } from "node:crypto";
import type { JanusConfig, ProviderConfig } from "./config.js";
import { MAX_STATE_BYTES, MAX_TIMEOUT_MS } from "./config.js";
import { JanusError, timeoutError } from "./errors.js";
import { enforceRequest, type EnforcedQuestion } from "./schema.js";
import { estimateRequestTokens, evalInputDigest } from "./budget.js";
// Shared redaction library (typesafe-secure/lib/redaction, MIT — the canonical
// implementation). Unconditional, no disable knob (SPEC A3.1); markers are
// typed per SPEC A2.2 (`[REDACTED:<type>]`, `[REDACTED:sensitive_key]`).
import { redactValue } from "redaction";
import { SingleFlight } from "./single_flight.js";
import { DailyBudget, type UsageRecord } from "./budget_breaker.js";
import { AuditLog } from "./audit.js";
import { enforceAnswers, type EnforcedVerdict } from "./verdict.js";
import {
  ProviderChain,
  ProviderChainError,
  defaultAdapters,
  defaultKeyReader,
  type TransportQuestion,
  type TransportUsage,
} from "./providers.js";

export interface EvaluateResponse {
  status: number;
  payload: Record<string, unknown>;
}

export interface EvaluatorDeps {
  config: JanusConfig;
  singleFlight: SingleFlight;
  budget: DailyBudget;
  audit: AuditLog;
  /** Overridable for tests; defaults to the real provider chain. */
  chain?: ProviderChain;
  /** Overridable for tests; defaults to the real Keychain read. */
  readKey?: ProviderChain extends never ? never : (typeof defaultKeyReader);
}

/** Build the production provider chain from config. */
export function buildProviderChain(config: JanusConfig): ProviderChain {
  return new ProviderChain(config.providers, defaultAdapters(), defaultKeyReader);
}

function toTransportQuestions(questions: readonly EnforcedQuestion[]): TransportQuestion[] {
  return questions.map((question) => ({
    name: question.name,
    kind: question.kind,
    // The question TEXT is always sent verbatim (review fix #1); schema
    // enforcement guarantees it is nonempty.
    question: question.question,
    instructions: question.instructions,
    ...(question.kind === "choice" ? { choices: question.choices } : {}),
    ...(question.kind === "boolean" ? { sdkCriteria: question.sdkCriteria } : {}),
  }));
}

/**
 * Map an unknown error onto the janus taxonomy with a FIXED public message.
 * Only the abort shape is distinguished (timeout); every other unknown error
 * — including raw provider/SDK text — becomes a fixed gateway_unavailable
 * message (review fix #5).
 */
export function classifyUnknownError(error: unknown): JanusError {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return timeoutError("evaluation timed out");
  }
  const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : String(error);
  if (/abort/.test(text) && /timeout|timed out|signal is aborted/.test(text)) {
    return timeoutError("evaluation timed out");
  }
  return new JanusError("gateway_unavailable", "provider evaluation failed", 503);
}

export class Evaluator {
  private readonly chain: ProviderChain;

  constructor(private readonly deps: EvaluatorDeps) {
    this.chain = deps.chain ?? buildProviderChain(deps.config);
  }

  async handle(body: unknown): Promise<EvaluateResponse> {
    const requestId = randomUUID();
    const { config } = this.deps;
    const startedAt = Date.now();

    try {
      // 1. Schema enforcement (§6, atomic fail-closed). Question text is
      //    required here; a missing/blank question is validation_error —
      //    no synthetic `question[i]` is ever constructed (review fix #1).
      const enforced = enforceRequest(body);

      // 2. Request budget (§2): 30k tokens authoritative; never truncate.
      estimateRequestTokens(
        enforced.state,
        enforced.questions,
        config.requestBudgetTokens,
        MAX_STATE_BYTES,
      );

      // 3. Redaction pass before any external call (§7, M10). Unconditional:
      //    there is no disable knob (review fix #4).
      const state = redactValue(enforced.state);

      // 4. Budget breaker check (M10).
      this.deps.budget.assertWithinBudget();

      // 5. Digest + single-flight (M9). Identical requests coalesce onto one
      //    provider call; the usage is charged exactly once.
      const digest = evalInputDigest(state, enforced.questions);

      const timeoutMs = Math.min(enforced.timeoutMs ?? config.timeoutMs, MAX_TIMEOUT_MS);
      const questionNames = enforced.questions.map((q) => q.name);
      const transportQuestions = toTransportQuestions(enforced.questions);
      let coalescedWaiters = 0;

      const outcome = await this.deps.singleFlight.run(
        digest,
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const flightOutcome = await this.chain.evaluate(
              { state: state as string | Record<string, unknown> | unknown[], questions: transportQuestions },
              controller.signal,
            );
            // Usage accounting (review fixes #11/#12) is owned by the flight
            // OWNER, inside the single-flight operation: each actual provider
            // attempt is charged exactly once, independent of waiter count
            // and independent of answer-validation outcome (success usage is
            // recorded BEFORE verdict enforcement, so a provider result that
            // fails enforceAnswers is still charged).
            this.recordUsage(flightOutcome.result.usage);
            for (const failedUsage of flightOutcome.failedAttemptUsage) {
              this.recordUsage(failedUsage);
            }
            return flightOutcome;
          } catch (error) {
            // Terminal chain failure: the ProviderChainError carries every
            // failed attempt's usage (including the terminal attempt). The
            // owner charges it once, then surfaces the unchanged taxonomy
            // error — waiters share the rejection and never re-charge.
            if (error instanceof ProviderChainError) {
              for (const failedUsage of error.failedAttemptUsage) {
                this.recordUsage(failedUsage);
              }
              throw error.failure;
            }
            throw error;
          } finally {
            clearTimeout(timer);
          }
        },
        ({ waiters }) => {
          coalescedWaiters = waiters;
        },
      );

      // 6. Verdict enforcement (§6, review fix #8): closed answer-shape
      //    checks; any violation fails the whole request validation_error.
      const verdict: EnforcedVerdict = enforceAnswers(
        enforced.questions,
        outcome.result.answers as Record<string, unknown>,
        outcome.result.usage,
      );

      // (Usage accounting happened inside the flight owner above; waiters
      // consume the shared outcome without recording.)
      const probabilities: Record<string, number> = {};
      for (const [name, answer] of Object.entries(verdict.answers)) {
        if (answer.type === "boolean") probabilities[name] = answer.probability;
        if (answer.type === "score") probabilities[name] = answer.score;
      }

      this.deps.audit.append({
        requestId,
        timestamp: new Date().toISOString(),
        event: "evaluate_result",
        questionNames,
        verdictProbabilities: probabilities,
        tokenUsage: verdict.usage,
        durationMs: Date.now() - startedAt,
        providerAttempts: outcome.attempts,
        provider: outcome.provider,
        coalesced: coalescedWaiters > 0,
      });

      return {
        status: 200,
        payload: {
          request_id: requestId,
          verdict: verdict.answers,
          usage: verdict.usage,
          provider: outcome.provider,
          digest,
        },
      };
    } catch (error) {
      const janusError =
        error instanceof JanusError
          ? error
          : classifyUnknownError(error);
      this.deps.audit.append({
        requestId,
        timestamp: new Date().toISOString(),
        event: "evaluate_error",
        questionNames: [],
        errorCode: janusError.code,
        durationMs: Date.now() - startedAt,
      });
      return { status: janusError.status, payload: janusError.body(requestId) };
    }
  }

  /** Charge the breaker for one provider call's usage. */
  private recordUsage(usage: TransportUsage): void {
    this.deps.budget.record(usage as UsageRecord);
  }
}
