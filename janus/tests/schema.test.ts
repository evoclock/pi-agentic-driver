// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests: question schema contract v1 enforcement (§6), atomic
// fail-closed semantics, and the boolean threshold contract.

import test from "node:test";
import assert from "node:assert/strict";
import { enforceRequest } from "../janus/schema.js";
import { JanusError } from "../janus/errors.js";
import { enforceAnswers } from "../janus/verdict.js";

function expectValidationError(fn: () => unknown, fragment?: string): void {
  try {
    fn();
    assert.fail("expected validation_error");
  } catch (error) {
    assert.ok(error instanceof JanusError);
    assert.equal(error.code, "validation_error");
    if (fragment) assert.match(error.message, new RegExp(fragment));
  }
}

test("boolean: default threshold is 0.9 with >= comparison", () => {
  const request = enforceRequest({
    state: "hello",
    questions: [{ type: "boolean", name: "refund", question: "Was a refund issued?" }],
  });
  assert.equal(request.questions.length, 1);
  const q = request.questions[0]!;
  assert.equal(q.kind, "boolean");
  assert.equal((q as { threshold: number }).threshold, 0.9);
});

test("boolean: custom threshold accepted within [0,1]", () => {
  const request = enforceRequest({
    state: "hello",
    questions: [{ type: "boolean", name: "q", question: "q", threshold: 0.5 }],
  });
  assert.equal((request.questions[0] as { threshold: number }).threshold, 0.5);
});

test("boolean: threshold out of range is validation_error", () => {
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [{ type: "boolean", name: "q", question: "q", threshold: 1.5 }],
    }),
  );
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [{ type: "boolean", name: "q", question: "q", threshold: "high" }],
    }),
  );
});

test("choice: choices array is REQUIRED (§6)", () => {
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "choice", name: "route", question: "route" }] }),
  );
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "choice", name: "route", question: "route", choices: [] }] }),
  );
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [{ type: "choice", name: "route", question: "route", choices: ["a", "a"] }],
    }),
  );
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [{ type: "choice", name: "route", question: "route", choices: ["a", 3] }],
    }),
  );
});

test("choice: valid choices accepted", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "choice", name: "route", question: "route", choices: ["billing", "tech", "other"] }],
  });
  assert.deepEqual((request.questions[0] as { choices: string[] }).choices, [
    "billing",
    "tech",
    "other",
  ]);
});

test("score: fixed 0..5 vocabulary; ordinal vocabularies must be choice (§6)", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "score", name: "rate", question: "rate" }],
  });
  assert.equal((request.questions[0] as { levels: number }).levels, 6);
  // Closed validation: per-question overrides like choices/levels are rejected.
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [{ type: "score", name: "rate", question: "rate", choices: ["poor", "good"] }],
    }),
  );
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [{ type: "score", name: "rate", question: "rate", levels: 10 }],
    }),
  );
});

test("unknown question type is validation_error", () => {
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "ranking", name: "q", question: "q" }] }),
  );
});

test("atomic fail-closed: one malformed question fails the whole request", () => {
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [
        { type: "boolean", name: "ok", question: "ok?" },
        { type: "choice", name: "route", question: "route" }, // missing choices
      ],
    }),
  );
});

test("missing state / missing questions / bad body shape are validation_error", () => {
  expectValidationError(() => enforceRequest({ questions: [{ type: "boolean", name: "q", question: "q" }] }));
  expectValidationError(() => enforceRequest({ state: "s", questions: [] }));
  expectValidationError(() => enforceRequest({ state: "s" }));
  expectValidationError(() => enforceRequest(null));
  expectValidationError(() => enforceRequest("state only"));
});

test("duplicate question name is validation_error", () => {
  expectValidationError(() =>
    enforceRequest({
      state: "s",
      questions: [
        { type: "boolean", name: "same", question: "same" },
        { type: "boolean", name: "same", question: "same" },
      ],
    }),
  );
});

test("state accepts string, object, and array", () => {
  for (const state of ["text", { a: 1 }, [{ role: "user" }]]) {
    const request = enforceRequest({
      state,
      questions: [{ type: "boolean", name: "q", question: "q" }],
    });
    assert.deepEqual(request.state, state);
  }
  expectValidationError(() =>
    enforceRequest({ state: 42, questions: [{ type: "boolean", name: "q", question: "q" }] }),
  );
});

test("verdict enforcement: model returned false is a normal 200 verdict with passed=false", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "boolean", name: "ok", question: "ok?" }],
  });
  const verdict = enforceAnswers(
    request.questions,
    { ok: { type: "boolean", probability: 0.2 } },
    { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  );
  assert.equal(verdict.answers.ok!.type, "boolean");
  assert.equal((verdict.answers.ok as { passed: boolean }).passed, false);
});

test("verdict enforcement: probability >= threshold passes", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "boolean", name: "ok", question: "ok?", threshold: 0.9 }],
  });
  const verdict = enforceAnswers(
    request.questions,
    { ok: { type: "boolean", probability: 0.9 } },
    { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  );
  assert.equal((verdict.answers.ok as { passed: boolean }).passed, true);
});

test("verdict enforcement: choice answer must be a member of the choices array", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "choice", name: "route", question: "route", choices: ["a", "b"] }],
  });
  assert.throws(
    () =>
      enforceAnswers(
        request.questions,
        { route: { type: "choice", choice: "c" } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});

test("verdict enforcement: missing answer fails the whole request with validation_error (atomic, review fix #8)", () => {
  const request = enforceRequest({
    state: "s",
    questions: [
      { type: "boolean", name: "a", question: "a" },
      { type: "boolean", name: "b", question: "b" },
    ],
  });
  assert.throws(
    () =>
      enforceAnswers(
        request.questions,
        { a: { type: "boolean", probability: 0.99 } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});

test("verdict enforcement: score is rounded to one decimal and range-checked", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "score", name: "rate", question: "rate" }],
  });
  const verdict = enforceAnswers(
    request.questions,
    { rate: { type: "score", score: 2.96 } },
    { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  );
  assert.equal((verdict.answers.rate as { score: number }).score, 3.0);
  assert.throws(
    () =>
      enforceAnswers(
        request.questions,
        { rate: { type: "score", score: 5.5 } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});

test("question name is REQUIRED; missing or blank is validation_error (review fix #1)", () => {
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "boolean", question: "ok?" }] }),
  );
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "boolean", name: "  ", question: "ok?" }] }),
  );
});

test("question text is REQUIRED; missing or blank is validation_error, never synthetic question[i] (review fix #1)", () => {
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "boolean", name: "q" }] }),
  );
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "boolean", name: "q", question: "" }] }),
  );
  expectValidationError(() =>
    enforceRequest({ state: "s", questions: [{ type: "boolean", name: "q", question: "   " }] }),
  );
});

test("enforced question carries both name and question text verbatim", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "boolean", name: "refund-gate", question: "Was a refund issued?" }],
  });
  const q = request.questions[0]! as { name: string; question: string };
  assert.equal(q.name, "refund-gate");
  assert.equal(q.question, "Was a refund issued?");
});

test("verdict enforcement: wrong answer type fails with validation_error (review fix #8)", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "boolean", name: "ok", question: "ok?" }],
  });
  assert.throws(
    () =>
      enforceAnswers(
        request.questions,
        { ok: { type: "score", score: 3 } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});

test("verdict enforcement: invalid probability and non-finite score fail with validation_error (review fix #8)", () => {
  const booleanRequest = enforceRequest({
    state: "s",
    questions: [{ type: "boolean", name: "ok", question: "ok?" }],
  });
  assert.throws(
    () =>
      enforceAnswers(
        booleanRequest.questions,
        { ok: { type: "boolean", probability: 1.5 } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
  assert.throws(
    () =>
      enforceAnswers(
        booleanRequest.questions,
        { ok: { type: "boolean", probability: "high" } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
  const scoreRequest = enforceRequest({
    state: "s",
    questions: [{ type: "score", name: "rate", question: "rate" }],
  });
  assert.throws(
    () =>
      enforceAnswers(
        scoreRequest.questions,
        { rate: { type: "score", score: Number.NaN } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});

test("verdict enforcement: malformed probabilities map fails with validation_error (review fix #8)", () => {
  const request = enforceRequest({
    state: "s",
    questions: [{ type: "choice", name: "route", question: "route", choices: ["a", "b"] }],
  });
  assert.throws(
    () =>
      enforceAnswers(
        request.questions,
        { route: { type: "choice", choice: "a", probabilities: { a: "high" } } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
  // Probabilities keys outside the vocabulary are rejected.
  assert.throws(
    () =>
      enforceAnswers(
        request.questions,
        { route: { type: "choice", choice: "a", probabilities: { zzz: 0.5 } } },
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ),
    (error: unknown) => error instanceof JanusError && error.code === "validation_error",
  );
});
