// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests: the secrets/PII redaction pass (§7, M10) and the token budget
// with state_too_large rejection (§2).

import test from "node:test";
import assert from "node:assert/strict";
import { redactString, redactValue } from "../janus/redact.js";
import { estimateRequestTokens, estimateStringTokens, evalInputDigest, canonicalJson } from "../janus/budget.js";
import { JanusError } from "../janus/errors.js";
import { enforceRequest } from "../janus/schema.js";
import { testConfig } from "./helpers.js";
import { Evaluator } from "../janus/evaluate.js";
import { SingleFlight } from "../janus/single_flight.js";
import { DailyBudget } from "../janus/budget_breaker.js";
import { AuditLog } from "../janus/audit.js";

test("redaction: API keys and tokens", () => {
  assert.equal(redactString("key AKIAIOSFODNN7EXAMPLE in config"), "key [REDACTED] in config");
  assert.equal(redactString("ghp_abcdefghijklmnopqrstuvwxyzyx"), "[REDACTED]");
  assert.equal(redactString("sk-proj-abcdefghijklmnopqrst"), "[REDACTED]");
  assert.equal(redactString("xoxb-123456789-abcdef"), "[REDACTED]");
  assert.equal(redactString("AIzaSyA1234567890abcdefghijklmnopqrstuv"), "[REDACTED]");
});

test("redaction: JWTs and bearer headers", () => {
  assert.equal(
    redactString("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c done"),
    "auth [REDACTED] done",
  );
  assert.equal(
    redactString("Authorization: Bearer abc123.def456"),
    "Authorization: [REDACTED]",
  );
});

test("redaction: private key blocks", () => {
  const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactString(text), "[REDACTED]");
});

test("redaction: assigned secrets keep the key name, drop the value", () => {
  assert.equal(redactString('password: "hunter2secret"'), "password: [REDACTED]");
  assert.equal(redactString("api_key=abcd1234efgh"), "api_key: [REDACTED]");
});

test("redaction: emails and SSNs", () => {
  assert.equal(redactString("contact jane.doe@example.com now"), "contact [REDACTED] now");
  assert.equal(redactString("ssn 123-45-6789"), "ssn [REDACTED]");
});

test("redaction: credit-card-shaped digits masked, benign numbers kept", () => {
  assert.equal(redactString("card 4111 1111 1111 1111"), "card •••• •••• •••• ••••");
  assert.equal(redactString("count 42"), "count 42");
  assert.equal(redactString("version 1.2.3"), "version 1.2.3");
});

test("redaction: recursive over objects and arrays; sensitive keys dropped", () => {
  const input = {
    user: "jane.doe@example.com",
    password: "hunter2secret",
    nested: { apiKey: "sk-proj-abcdefghijklmnopqrst", note: "clean" },
    list: ["token=abcd1234efgh", 5, null],
  };
  const output = redactValue(input) as Record<string, unknown>;
  assert.equal(output.user, "[REDACTED]");
  assert.equal(output.password, "[REDACTED]");
  const nested = output.nested as Record<string, unknown>;
  assert.equal(nested.apiKey, "[REDACTED]");
  assert.equal(nested.note, "clean");
  assert.equal((output.list as unknown[])[0], "token: [REDACTED]");
  assert.equal((output.list as unknown[])[1], 5);
});

test("redaction: sensitive-key values dropped regardless of shape (review fix #4)", () => {
  const input = {
    credentials: { user: "u", password: "p" },
    token: ["a", "b"],
    apiKey: 12345,
    private_key: true,
    authorization: null,
    secret: { nested: { deeper: ["x"] } },
  };
  const output = redactValue(input) as Record<string, unknown>;
  assert.equal(output.credentials, "[REDACTED]");
  assert.equal(output.token, "[REDACTED]");
  assert.equal(output.apiKey, "[REDACTED]");
  assert.equal(output.private_key, "[REDACTED]");
  assert.equal(output.authorization, "[REDACTED]");
  assert.equal(output.secret, "[REDACTED]");
  // Nested objects under non-sensitive keys still get traversed.
  const wrapper = redactValue({ meta: { password: "leak" } }) as Record<string, unknown>;
  assert.equal((wrapper.meta as Record<string, unknown>).password, "[REDACTED]");
});

test("budget: conservative bound dominates chars/4 for CJK, emoji, and dense JSON (review fix #3)", () => {
  const cjk = "国境の長いトンネルを抜けると雪国であった".repeat(10);
  const emoji = "🔒🔐🔑🗝️🧿🪬🧸🪙".repeat(10);
  const denseJson = JSON.stringify({ payload: Buffer.from("dense").toString("base64").repeat(50) });
  for (const text of [cjk, emoji, denseJson]) {
    const bytes = Buffer.byteLength(text, "utf8");
    const estimated = estimateStringTokens(text);
    const charsOver4 = Math.ceil(text.length / 4);
    assert.equal(estimated, Math.ceil(bytes / 2), "bound is bytes/2");
    assert.ok(
      estimated >= charsOver4,
      `bytes/2 (${estimated}) must be >= chars/4 (${charsOver4}) for dense/multibyte content`,
    );
  }
});

test("budget: CJK state rejected at the 30k budget where chars/4 would undercount (review fix #3)", () => {
  // 21k CJK chars = 63k UTF-8 bytes → 31.5k tokens under bytes/2 (rejected),
  // but only ~5.25k under chars/4 (wrongly accepted). The conservative bound
  // must over-reject, never materially undercount.
  const request = enforceRequest({
    state: "雪".repeat(21_000),
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.throws(
    () => estimateRequestTokens(request.state, request.questions, 30_000, 4_000_000),
    (error: unknown) => error instanceof JanusError && error.code === "state_too_large",
  );
});

test("budget: requests within the 30k budget pass", () => {
  const request = enforceRequest({
    state: "x".repeat(1000),
    questions: [{ type: "boolean", name: "q", question: "q", instructions: "i".repeat(100) }],
  });
  const size = estimateRequestTokens(request.state, request.questions, 30_000, 4_000_000);
  assert.ok(size.estimatedTokens > 0 && size.estimatedTokens < 30_000);
});

test("budget: oversized state rejected with state_too_large, never truncated", () => {
  const request = enforceRequest({
    state: "x".repeat(200_000),
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  try {
    estimateRequestTokens(request.state, request.questions, 30_000, 4_000_000);
    assert.fail("expected state_too_large");
  } catch (error) {
    assert.ok(error instanceof JanusError);
    assert.equal(error.code, "state_too_large");
    assert.match(error.message, /never truncated silently/);
  }
});

test("budget: byte ceiling rejects pathological state before token math", () => {
  const request = enforceRequest({
    state: "x".repeat(5_000_000),
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.throws(
    () => estimateRequestTokens(request.state, request.questions, 30_000, 4_000_000),
    (error: unknown) => error instanceof JanusError && error.code === "state_too_large",
  );
});

test("evalInputDigest is stable and input-sensitive", () => {
  const request = enforceRequest({
    state: { a: 1, b: 2 },
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  const d1 = evalInputDigest(request.state, request.questions);
  const d2 = evalInputDigest(request.state, request.questions);
  assert.equal(d1, d2);
  const d3 = evalInputDigest({ b: 2, a: 1 }, request.questions);
  assert.equal(d1, d3, "key order must not change the digest");
  const d4 = evalInputDigest({ a: 1, b: 3 }, request.questions);
  assert.notEqual(d1, d4);
});

test("canonicalJson sorts keys deterministically", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
});

test("end-to-end: redaction runs before the SDK call", async () => {
  const seen: { state: unknown }[] = [];
  const audit = { append: () => {} } as unknown as AuditLog;
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget: new DailyBudget(0, 0, 0.5),
    audit,
    chain: {
      async evaluate(request: { state: unknown }) {
        seen.push({ state: request.state });
        return {
          result: {
            answers: { q: { type: "boolean", probability: 0.99 } },
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            modelId: "jev-latest",
          },
          provider: "typesafe-direct",
          attempts: 1,
          failedAttemptUsage: [],
        };
      },
      readiness: async () => ({ ready: true, providers: [] }),
    } as never,
  });
  const response = await evaluator.handle({
    state: { note: "email jane.doe@example.com", password: "hunter2secret" },
    questions: [{ type: "boolean", name: "q", question: "q" }],
  });
  assert.equal(response.status, 200);
  const state = seen[0]?.state as Record<string, unknown>;
  assert.equal(state.note, "email [REDACTED]");
  assert.equal(state.password, "[REDACTED]");
});
