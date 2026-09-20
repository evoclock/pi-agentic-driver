// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared test fixtures: janus config plus provider-chain mocks.
// NO live provider calls anywhere in the test suite — adapters are fully
// mocked and no real credentials are read or used.

import type { JanusConfig, ProviderConfig } from "../janus/config.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChainEvaluateOutcome,
  KeyReader,
  ProviderAdapter,
  TransportRequest,
  TransportResult,
  TransportUsage,
} from "../janus/providers.js";

/** Sole configured provider in tests: direct TypeSafe. */
export function testProviders(overrides: Partial<ProviderConfig>[] = []): ProviderConfig[] {
  const base: ProviderConfig[] = [
    {
      id: "typesafe-direct",
      model: "jev-latest",
      keychain: { account: "typesafe-ai", service: "Typesafe AI" },
    },
  ];
  return base.map((provider, index) => ({ ...provider, ...(overrides[index] ?? {}) }));
}

/**
 * Two provider entries with the sole id (typesafe-direct) — used to exercise
 * the retry/failover slot now that no fallback provider exists.
 */
export function testRetryProviders(overrides: Partial<ProviderConfig>[] = []): ProviderConfig[] {
  const base: ProviderConfig[] = [
    {
      id: "typesafe-direct",
      model: "jev-latest",
      keychain: { account: "typesafe-ai", service: "Typesafe AI" },
    },
    {
      id: "typesafe-direct",
      model: "jev-latest",
      keychain: { account: "typesafe-ai-retry", service: "Typesafe AI" },
    },
  ];
  return base.map((provider, index) => ({ ...provider, ...(overrides[index] ?? {}) }));
}

export function testConfig(overrides: Partial<JanusConfig> = {}): JanusConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    providers: testProviders(),
    defaultModel: "jev-latest",
    maxConcurrent: 4,
    timeoutMs: 30_000,
    requestBudgetTokens: 30_000,
    dailyTokenCeiling: 2_000_000,
    dailyCostCeilingUsd: 10,
    costPerMtokenUsd: 0.5,
    audit: {
      path: join(tmpdir(), `janus-test-audit-${Math.random().toString(36).slice(2)}`),
      maxBytes: 10 * 1024 * 1024,
      retentionDays: 90,
    },
    redactSecrets: true,
    ...overrides,
  };
}

export interface MockAnswer {
  type: "boolean" | "choice" | "score";
  probability?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
}

export interface MockCall {
  state: unknown;
  questions: unknown;
  abortSignal?: AbortSignal;
  /** The adapter that received this call. */
  adapterId?: string;
  /** The API key passed to the adapter (test-only in-memory fake). */
  apiKey?: string;
}

export interface MockAdapterOptions {
  /** Provider id this fake adapter stands in for. */
  id: string;
  answers?: Record<string, MockAnswer>;
  usage?: TransportUsage;
  delayMs?: number;
  /** Return an error to fail the call (raw error → adapter classification). */
  fail?: (call: MockCall) => Error | undefined;
  /** Record every call here. */
  calls?: MockCall[];
  /** Result override for full control (e.g. malformed answers). */
  result?: (call: MockCall) => TransportResult;
}

/** Build a fake ProviderAdapter recording calls and returning canned answers. */
export function mockAdapter(options: MockAdapterOptions): ProviderAdapter {
  return {
    id: options.id as ProviderAdapter["id"],
    async evaluate(request: TransportRequest, key: string, signal: AbortSignal): Promise<TransportResult> {
      const call: MockCall = {
        state: request.state,
        questions: request.questions,
        abortSignal: signal,
        adapterId: options.id,
        apiKey: key,
      };
      options.calls?.push(call);
      const failure = options.fail?.(call);
      if (failure) throw failure;
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const timer = setTimeout(resolvePromise, options.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            rejectPromise(error);
          });
        });
      }
      if (options.result) return options.result(call);
      const usage: TransportUsage = options.usage ?? {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      };
      const answers: Record<string, unknown> = {};
      for (const [name, answer] of Object.entries(options.answers ?? {})) {
        answers[name] = answer;
      }
      return { answers, usage, modelId: `${options.id}-model` };
    },
  };
}

/** A key reader that resolves every configured keychain ref to a fake key. */
export function fakeKeyReader(failFor: Set<string> = new Set()): KeyReader {
  return async (ref) => {
    if (failFor.has(ref.service) || failFor.has(ref.account)) {
      return { status: "missing", reason: "missing (test)" };
    }
    return { status: "resolved", key: `test-key-for-${ref.account}` };
  };
}

export interface MockChainCall extends MockCall {
  providers?: string[];
}

/** Build a ProviderChain replacement that records calls and returns canned outcomes. */
export function mockChain(options: {
  answers?: Record<string, MockAnswer>;
  usage?: TransportUsage;
  delayMs?: number;
  fail?: (call: MockChainCall) => Error | undefined;
  calls?: MockChainCall[];
  provider?: string;
  attempts?: number;
  /** Usage already observed from failed attempts before the successful outcome. */
  failedAttemptUsage?: TransportUsage[];
}) {
  return {
    async evaluate(
      request: TransportRequest,
      signal: AbortSignal,
    ): Promise<ChainEvaluateOutcome> {
      const call: MockChainCall = {
        state: request.state,
        questions: request.questions,
        abortSignal: signal,
      };
      options.calls?.push(call);
      const failure = options.fail?.(call);
      if (failure) throw failure;
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const timer = setTimeout(resolvePromise, options.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            rejectPromise(error);
          });
        });
      }
      const usage: TransportUsage = options.usage ?? {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      };
      const answers: Record<string, unknown> = {};
      for (const [name, answer] of Object.entries(options.answers ?? {})) {
        answers[name] = answer;
      }
      return {
        result: { answers, usage, modelId: `${options.provider ?? "typesafe-direct"}-model` },
        provider: (options.provider ?? "typesafe-direct") as ChainEvaluateOutcome["provider"],
        attempts: options.attempts ?? 1,
        failedAttemptUsage: options.failedAttemptUsage ?? [],
      };
    },
    async readiness(): Promise<{ ready: boolean; reason?: string; providers: { id: string; ready: boolean }[] }> {
      return { ready: true, providers: [{ id: "typesafe-direct", ready: true }] };
    },
  };
}
