// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Usage-accounting regression tests (task #44 follow-up, review fixes #11/#12):
//
//   1. N coalesced callers → one provider call, one usage charge.
//   2. Retry then success → failed-attempt usage + success usage each charged once.
//   3. All attempts fail → all accumulated usage charged despite the thrown taxonomy error.
//   4. Provider success followed by answer-validation failure → usage still charged.
//   5. Provider selection: typesafe-direct is the sole provider; unconfigured TypeSafe fails closed.
//
// Every test inspects DailyBudget.status().tokensUsed — the breaker is the
// single accounting sink.

import test from "node:test";
import assert from "node:assert/strict";
import { Evaluator } from "../janus/evaluate.js";
import { SingleFlight } from "../janus/single_flight.js";
import { DailyBudget } from "../janus/budget_breaker.js";
import { AuditLog } from "../janus/audit.js";
import {
  defaultAdapters,
  ProviderChain,
  ProviderChainError,
  ProviderTransportError,
  type TransportRequest,
} from "../janus/providers.js";
import { gatewayUnavailable, timeoutError } from "../janus/errors.js";
import {
  testConfig,
  testProviders,
  testRetryProviders,
  fakeKeyReader,
  mockAdapter,
  mockChain,
  type MockChainCall,
} from "./helpers.js";

const BODY = {
  state: "shared state",
  questions: [{ type: "boolean", name: "q", question: "ok?" }],
};

const USAGE_120 = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

function noopAudit(): AuditLog {
  return { append: () => {} } as unknown as AuditLog;
}

test("accounting: three coalesced callers → one provider call, ONE usage charge", async () => {
  const calls: MockChainCall[] = [];
  const budget = new DailyBudget(10_000, 0, 0.5);
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget,
    audit: noopAudit(),
    chain: mockChain({
      answers: { q: { type: "boolean", probability: 0.95 } },
      delayMs: 60,
      calls,
      usage: USAGE_120,
    }) as never,
  });
  const [a, b, c] = await Promise.all([
    evaluator.handle(BODY),
    evaluator.handle(BODY),
    evaluator.handle(BODY),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 200);
  assert.equal(calls.length, 1, "identical requests coalesce to one provider call");
  assert.equal(budget.status().tokensUsed, 120, "exactly one charge: 360 would mean double accounting");
});

test("accounting: retry then success → failed + successful attempt usage each charged once", async () => {
  const calls: unknown[] = [];
  let first = true;
  const budget = new DailyBudget(10_000, 0, 0.5);
  const chain = new ProviderChain(
    testRetryProviders(),
    [
      mockAdapter({
        id: "typesafe-direct",
        calls: calls as never,
        usage: USAGE_120,
        answers: { q: { type: "boolean", probability: 0.9 } },
        fail: () => {
          if (first) {
            first = false;
            return new ProviderTransportError("timeout", timeoutError("slow"), {
              inputTokens: 80,
              outputTokens: 20,
              totalTokens: 100,
            });
          }
          return undefined;
        },
      }),
    ],
    fakeKeyReader(),
  );
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget,
    audit: noopAudit(),
    chain,
  });
  const response = await evaluator.handle(BODY);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2, "one failed attempt plus one successful attempt");
  assert.equal(budget.status().tokensUsed, 100 + 120, "failed-attempt usage is charged alongside success usage");
});

test("accounting: all attempts fail → every attempt's usage charged despite the thrown JanusError", async () => {
  let attempt = 0;
  const budget = new DailyBudget(10_000, 0, 0.5);
  const usages = [
    { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    { inputTokens: 40, outputTokens: 40, totalTokens: 80 },
  ];
  const chain = new ProviderChain(
    testRetryProviders(),
    [
      mockAdapter({
        id: "typesafe-direct",
        fail: () => {
          const usage = usages[Math.min(attempt, usages.length - 1)]!;
          attempt += 1;
          return new ProviderTransportError("gateway_unavailable", gatewayUnavailable("down"), usage);
        },
      }),
    ],
    fakeKeyReader(),
  );
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget,
    audit: noopAudit(),
    chain,
  });
  const response = await evaluator.handle(BODY);
  assert.equal(response.status, 503, "terminal chain failure surfaces the taxonomy error");
  assert.equal(response.payload.error, "gateway_unavailable");
  assert.equal(attempt, 2);
  assert.equal(budget.status().tokensUsed, 100 + 80, "failed-attempt usage survives the terminal throw");
});

test("accounting: provider success followed by answer-validation failure → usage still charged", async () => {
  const calls: MockChainCall[] = [];
  const budget = new DailyBudget(10_000, 0, 0.5);
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget,
    audit: noopAudit(),
    // Provider-level success, but no answers → enforceAnswers must fail AFTER
    // the provider tokens are charged.
    chain: mockChain({ answers: {}, usage: USAGE_120, calls }) as never,
  });
  const response = await evaluator.handle(BODY);
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "validation_error");
  assert.equal(calls.length, 1);
  assert.equal(budget.status().tokensUsed, 120, "provider usage is charged even when validation rejects the verdict");
});

test("accounting: terminal chain error carries accumulated usage at the chain boundary", async () => {
  const usage = { inputTokens: 50, outputTokens: 50, totalTokens: 100 };
  const chain = new ProviderChain(
    testRetryProviders(),
    [
      mockAdapter({
        id: "typesafe-direct",
        fail: () => new ProviderTransportError("gateway_unavailable", gatewayUnavailable("down"), usage),
      }),
    ],
    fakeKeyReader(),
  );
  const request: TransportRequest = {
    state: "s",
    questions: [{ name: "q", kind: "boolean", question: "ok?", instructions: "" }],
  };
  await assert.rejects(
    chain.evaluate(request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof ProviderChainError, "terminal failures travel as ProviderChainError");
      assert.equal(error.failure.code, "gateway_unavailable");
      assert.equal(error.failedAttemptUsage.length, 2);
      assert.equal(
        error.failedAttemptUsage.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0),
        200,
      );
      return true;
    },
  );
});

test("accounting: typesafe-direct is the sole adapter — no Vercel/Merge path exists", () => {
  assert.deepEqual(
    defaultAdapters().map((adapter) => adapter.id),
    ["typesafe-direct"],
  );
});

test("accounting: unconfigured TypeSafe fails closed with zero usage charged", async () => {
  const calls: unknown[] = [];
  const budget = new DailyBudget(10_000, 0, 0.5);
  const chain = new ProviderChain(
    testProviders(),
    [mockAdapter({ id: "typesafe-direct", calls: calls as never })],
    fakeKeyReader(new Set(["typesafe-ai"])),
  );
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget,
    audit: noopAudit(),
    chain,
  });
  const response = await evaluator.handle(BODY);
  assert.equal(response.status, 502);
  assert.equal(response.payload.error, "model_unauthorized");
  assert.equal(calls.length, 0, "fail-closed: no provider attempt without a credential");
  assert.equal(budget.status().tokensUsed, 0);
});
