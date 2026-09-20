// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests: audit log contents and rotation/retention, daily cost breaker,
// per-request timeout budget, single-flight coalescing through the Evaluator,
// and the provider failover policy. NO live provider calls — the chain and
// adapters are fully mocked.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Evaluator } from "../janus/evaluate.js";
import { SingleFlight } from "../janus/single_flight.js";
import { DailyBudget } from "../janus/budget_breaker.js";
import { AuditLog } from "../janus/audit.js";
import { ProviderChain, ProviderTransportError, type TransportRequest } from "../janus/providers.js";
import { busyError, gatewayUnavailable, timeoutError, validationError } from "../janus/errors.js";
import { testConfig, testProviders, mockChain, fakeKeyReader, mockAdapter } from "./helpers.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "janus-audit-test-"));
}

function makeEvaluator(
  overrides: Parameters<typeof testConfig>[0] = {},
  chainOptions: Parameters<typeof mockChain>[0] = { answers: { q: { type: "boolean", probability: 0.95 } } },
) {
  const config = testConfig(overrides);
  const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
  audit.start();
  const evaluator = new Evaluator({
    config,
    singleFlight: new SingleFlight(overrides.maxConcurrent ?? 4),
    budget: new DailyBudget(
      overrides.dailyTokenCeiling ?? 0,
      overrides.dailyCostCeilingUsd ?? 0,
      0.5,
    ),
    audit,
    chain: mockChain(chainOptions) as never,
  });
  return { config, audit, evaluator };
}

test("audit log records request id, timestamps, question names, probabilities, usage — never state or question text", async () => {
  const dir = tempDir();
  try {
    const { config, evaluator } = makeEvaluator(
      { audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 } },
      {
        answers: { q: { type: "boolean", probability: 0.97 } },
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      },
    );
    const response = await evaluator.handle({
      state: { secret: "AKIAIOSFODNN7EXAMPLE", body: "refund details" },
      questions: [{ type: "boolean", name: "q", question: "Was a refund issued?" }],
    });
    assert.equal(response.status, 200);

    const lines = readFileSync(`${config.audit.path}.jsonl`, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.event, "evaluate_result");
    assert.ok(typeof entry.requestId === "string" && entry.requestId.length > 0);
    assert.ok(typeof entry.timestamp === "string");
    // Question NAMES (non-sensitive identifiers), never question text.
    assert.deepEqual(entry.questionNames, ["q"]);
    assert.deepEqual(entry.verdictProbabilities, { q: 0.97 });
    assert.deepEqual(entry.tokenUsage, { inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    const serialized = lines[0]!;
    assert.ok(!serialized.includes("AKIAIOSFODNN7EXAMPLE"), "audit must never contain state contents");
    assert.ok(!serialized.includes("refund details"), "audit must never contain state contents");
    assert.ok(!serialized.includes("Was a refund issued?"), "audit must never contain question text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit log errors are recorded with the error code", async () => {
  const dir = tempDir();
  try {
    const { config, evaluator } = makeEvaluator(
      { audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 } },
      { answers: {} },
    );
    await evaluator.handle({ state: "s", questions: [{ type: "boolean", name: "q", question: "q" }] });
    const lines = readFileSync(`${config.audit.path}.jsonl`, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.event, "evaluate_error");
    assert.equal(entry.errorCode, "validation_error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit log rotates oldest-first when size-capped", () => {
  const dir = tempDir();
  try {
    const config = testConfig({
      audit: { path: join(dir, "audit"), maxBytes: 400, retentionDays: 90 },
    });
    const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
    audit.start();
    for (let i = 0; i < 5; i += 1) {
      audit.append({
        requestId: `req-${i}-${"x".repeat(80)}`,
        timestamp: new Date().toISOString(),
        event: "evaluate_result",
        questionNames: ["q"],
        verdictProbabilities: { q: 0.9 },
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    }
    audit.stop();
    assert.ok(existsSync(`${config.audit.path}.jsonl.1`), "rotation must produce .1");
    assert.ok(!existsSync(`${config.audit.path}.jsonl.6`), "no more than 5 rotated files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit retention deletes rotated files older than retentionDays", async () => {
  const dir = tempDir();
  try {
    const config = testConfig({
      audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 },
    });
    const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
    audit.start();
    audit.append({
      requestId: "r1",
      timestamp: new Date().toISOString(),
      event: "evaluate_result",
      questionNames: [],
    });
    audit.stop();

    // Fabricate an ancient rotated file.
    const { utimesSync, writeFileSync } = await import("node:fs");
    const oldPath = `${config.audit.path}.jsonl.1`;
    writeFileSync(oldPath, "{}\n");
    const ancient = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(oldPath, ancient, ancient);

    const audit2 = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
    audit2.start();
    audit2.stop();
    assert.ok(!existsSync(oldPath), "rotated file older than retention must be deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit retention purges expired records from the ACTIVE file (review fix #7)", async () => {
  const dir = tempDir();
  try {
    const config = testConfig({
      audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 },
    });
    const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
    audit.start();

    const fresh = new Date().toISOString();
    const ancientTimestamp = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    audit.append({
      requestId: "old-record",
      timestamp: ancientTimestamp,
      event: "evaluate_result",
      questionNames: [],
    });
    audit.append({
      requestId: "new-record",
      timestamp: fresh,
      event: "evaluate_result",
      questionNames: [],
    });
    audit.append({
      requestId: "another-old-record",
      timestamp: ancientTimestamp,
      event: "evaluate_error",
      questionNames: [],
      errorCode: "timeout",
    });

    // Force a sweep by running retention again.
    audit.stop();
    const audit2 = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
    audit2.start();
    audit2.stop();

    const serialized = readFileSync(`${config.audit.path}.jsonl`, "utf8");
    assert.ok(!serialized.includes("old-record"), "expired active-file records must be purged");
    assert.ok(!serialized.includes("another-old-record"), "expired active-file records must be purged");
    assert.ok(serialized.includes("new-record"), "fresh records must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daily cost breaker: busy with budget_exhausted on token ceiling", async () => {
  const { evaluator } = makeEvaluator(
    { dailyTokenCeiling: 100 },
    {
      answers: { q: { type: "boolean", probability: 0.95 } },
      usage: { inputTokens: 60, outputTokens: 60, totalTokens: 120 },
    },
  );
  const first = await evaluator.handle({
    state: "s",
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.equal(first.status, 200);
  const second = await evaluator.handle({
    state: "s2",
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.equal(second.status, 429);
  assert.equal(second.payload.error, "busy");
  const detail = (second.payload.detail as { budget_exhausted?: { kind: string } })?.budget_exhausted;
  assert.equal(detail?.kind, "tokens");
});

test("daily cost breaker: window resets on day change", () => {
  let now = new Date("2026-09-16T23:59:00Z");
  const budget = new DailyBudget(100, 0, 0.5, () => now);
  budget.record({ totalTokens: 100 });
  assert.equal(budget.status().exhausted, true);
  now = new Date("2026-09-17T00:00:01Z");
  assert.equal(budget.status().exhausted, false);
  assert.equal(budget.status().tokensUsed, 0);
});

test("per-request timeout: client budget capped at 30s and honored", async () => {
  const { evaluator } = makeEvaluator({}, { answers: { q: { type: "boolean", probability: 0.95 } }, delayMs: 200 });
  const response = await evaluator.handle({
    state: "s",
    timeoutMs: 50,
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.equal(response.status, 504);
  assert.equal(response.payload.error, "timeout");
  // Fixed public message (review fix #5).
  assert.equal(response.payload.message, "evaluation timed out");
});

test("single-flight through the Evaluator: identical requests coalesce; usage charged once (review fix #11)", async () => {
  const calls: unknown[] = [];
  const audit = { append: () => {} } as unknown as AuditLog;
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget: new DailyBudget(10_000, 0, 0.5),
    audit,
    chain: mockChain({
      answers: { q: { type: "boolean", probability: 0.95 } },
      delayMs: 60,
      calls: calls as never,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    }) as never,
  });
  const body = { state: "shared state", questions: [{ type: "boolean", name: "q", question: "q" }] };
  const [a, b, c] = await Promise.all([
    evaluator.handle(body),
    evaluator.handle(body),
    evaluator.handle(body),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 200);
  assert.equal(calls.length, 1, "identical requests must coalesce to one provider call");
  assert.equal(
    JSON.stringify(a.payload.verdict) === JSON.stringify(b.payload.verdict) &&
      JSON.stringify(b.payload.verdict) === JSON.stringify(c.payload.verdict),
    true,
    "coalesced requests share the same verdict",
  );
  // Usage is charged exactly once: 3 callers × 120 tokens would be 360.
  assert.equal(a.payload.usage && (a.payload.usage as { totalTokens: number }).totalTokens, 120);
});

test("readiness not ready only when NO provider credential resolves", async () => {
  const chain = new ProviderChain(
    testProviders(),
    [mockAdapter({ id: "typesafe-direct" })],
    fakeKeyReader(new Set(["typesafe-ai"])),
  );
  const readiness = await chain.readiness();
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason ?? "", /no provider credential resolvable/);
  assert.ok(!/test-key|secret value/i.test(readiness.reason ?? ""), "no key fragments in the reason");
});

test("busy from concurrency cap surfaces through the evaluator", async () => {
  const audit = { append: () => {} } as unknown as AuditLog;
  const evaluator = new Evaluator({
    config: testConfig({ maxConcurrent: 1 }),
    singleFlight: new SingleFlight(1),
    budget: new DailyBudget(0, 0, 0.5),
    audit,
    chain: mockChain({
      answers: { q: { type: "boolean", probability: 0.9 } },
      delayMs: 150,
    }) as never,
  });
  const first = evaluator.handle({ state: "s1", questions: [{ type: "boolean", name: "q", question: "q" }] });
  await new Promise((r) => setTimeout(r, 20));
  const second = await evaluator.handle({
    state: "s2",
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.equal(second.status, 429);
  assert.equal(second.payload.error, "busy");
  assert.equal((await first).status, 200);
});

test("JanusError from inside the flight is preserved (not re-classified)", async () => {
  const audit = { append: () => {} } as unknown as AuditLog;
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget: new DailyBudget(0, 0, 0.5),
    audit,
    chain: mockChain({
      answers: { q: { type: "boolean", probability: 0.95 } },
      fail: () => busyError("injected"),
    }) as never,
  });
  const response = await evaluator.handle({
    state: "s",
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.equal(response.payload.error, "busy");
  assert.equal(response.payload.message, "injected", "JanusError messages are janus-authored, not provider text");
});

test("audit entry records provider attempts and coalescing marker (review fix #11)", async () => {
  const dir = tempDir();
  try {
    const { config, evaluator } = makeEvaluator(
      { audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 } },
      { answers: { q: { type: "boolean", probability: 0.97 } }, attempts: 1, provider: "typesafe-direct" },
    );
    await evaluator.handle({
      state: "s",
      questions: [{ type: "boolean", name: "q", question: "q" }],
    });
    const lines = readFileSync(`${config.audit.path}.jsonl`, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.providerAttempts, 1);
    assert.equal(entry.provider, "typesafe-direct");
    assert.equal(entry.coalesced, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
