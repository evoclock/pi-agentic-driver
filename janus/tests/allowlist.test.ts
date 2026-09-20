// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests: provider selection is configuration-only (M8, review fix #9) —
// request-level model/provider overrides are REJECTED, not merely checked
// against an allowlist. Unknown request fields are rejected (closed schema).

import test from "node:test";
import assert from "node:assert/strict";
import { Evaluator } from "../janus/evaluate.js";
import { SingleFlight } from "../janus/single_flight.js";
import { DailyBudget } from "../janus/budget_breaker.js";
import { AuditLog } from "../janus/audit.js";
import { enforceRequest } from "../janus/schema.js";
import { JanusError } from "../janus/errors.js";
import { testConfig, mockChain } from "./helpers.js";

function makeEvaluator() {
  const auditEntries: unknown[] = [];
  const audit = {
    append: (entry: unknown) => auditEntries.push(entry),
  } as unknown as AuditLog;
  const evaluator = new Evaluator({
    config: testConfig(),
    singleFlight: new SingleFlight(4),
    budget: new DailyBudget(0, 0, 0.5),
    audit,
    chain: mockChain({ answers: { q: { type: "boolean", probability: 0.95 } } }) as never,
  });
  return { evaluator, auditEntries };
}

test("request without model/provider fields is accepted", async () => {
  const { evaluator } = makeEvaluator();
  const response = await evaluator.handle({
    state: "s",
    questions: [{ type: "boolean", name: "q", question: "ok?" }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.provider, "typesafe-direct");
});

test("request-level model override is REJECTED (validation_error, not allowlist check)", async () => {
  const { evaluator } = makeEvaluator();
  for (const model of ["openai/gpt-5", "jev-latest", "typesafe-ai/jev"]) {
    const response = await evaluator.handle({
      state: "s",
      model,
      questions: [{ type: "boolean", name: "q", question: "ok?" }],
    });
    assert.equal(response.status, 400, `model ${model} must be rejected`);
    assert.equal(response.payload.error, "validation_error");
    assert.match(String(response.payload.message), /unknown request field/);
  }
});

test("request-level provider override is REJECTED", async () => {
  const { evaluator } = makeEvaluator();
  const response = await evaluator.handle({
    state: "s",
    provider: "acme-gateway",
    questions: [{ type: "boolean", name: "q", question: "ok?" }],
  });
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "validation_error");
});

test("any other unknown request field is rejected (closed schema, review fix #9)", async () => {
  const { evaluator } = makeEvaluator();
  for (const field of ["apiKey", "maxTokens", "temperature", "stream", "criteria"]) {
    const response = await evaluator.handle({
      state: "s",
      [field]: "x",
      questions: [{ type: "boolean", name: "q", question: "ok?" }],
    });
    assert.equal(response.status, 400);
    assert.equal(response.payload.error, "validation_error");
  }
});

test("schema enforcement rejects unknown per-question fields", () => {
  assert.throws(
    () =>
      enforceRequest({
        state: "s",
        questions: [{ type: "boolean", name: "q", question: "ok?", apiKey: "x" }],
      }),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});

test("schema enforcement rejects unknown top-level fields", () => {
  assert.throws(
    () => enforceRequest({ state: "s", model: "m", questions: [{ type: "boolean", name: "q", question: "ok?" }] }),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});
