// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Adapter mapping tests (review fix #2): the transport contract maps onto the
// sole provider adapter (typesafe-direct) with mocked clients and NO network,
// NO live credentials. Question composition (review fix #1), the single-retry
// policy, and failed-attempt usage accumulation are verified here. The Vercel
// AI Gateway and the merge gateway are DROPPED — no test references them.

import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultAdapters,
  ProviderChain,
  ProviderChainError,
  ProviderTransportError,
  TypesafeDirectAdapter,
  composeQuestionPayload,
  providerQuestionText,
  type TransportRequest,
  type TypeSafeClientLike,
} from "../janus/providers.js";
import { gatewayUnavailable, timeoutError, modelUnauthorized } from "../janus/errors.js";
import { testProviders, testRetryProviders, fakeKeyReader, mockAdapter } from "./helpers.js";

const SAMPLE_REQUEST: TransportRequest = {
  state: { ticket: "I was charged twice" },
  questions: [
    { name: "billing", kind: "boolean", question: "Is this about billing?", instructions: "" },
    {
      name: "route",
      kind: "choice",
      question: "Route this ticket",
      instructions: "Prefer the most specific class.",
      choices: ["billing", "tech", "other"],
    },
    { name: "quality", kind: "score", question: "Rate this PR", instructions: "" },
  ],
};

test("composeQuestionPayload: question text is always present and first (review fix #1)", () => {
  const withoutInstructions = composeQuestionPayload("Is this about billing?", "");
  assert.equal(withoutInstructions.question, "Is this about billing?");
  assert.equal(withoutInstructions.framing, null);

  const withInstructions = composeQuestionPayload("Is this about billing?", "Be strict.");
  assert.equal(withInstructions.question, "Is this about billing?");
  assert.ok(withInstructions.framing!.includes("Be strict."));
  assert.ok(withInstructions.framing!.includes("Additional framing instructions"));
  // Unambiguous: framing block is clearly delimited, question comes first.
  const composed = providerQuestionText({
    name: "q",
    kind: "boolean",
    question: "Is this about billing?",
    instructions: "Be strict.",
  });
  assert.ok(composed.startsWith("Is this about billing?"));
  assert.ok(composed.indexOf("Is this about billing?") < composed.indexOf("Be strict."));
});

test("typesafe-direct adapter maps the transport contract to noul/choice/score shapes", async () => {
  let captured: { state: unknown; questions: Record<string, unknown> } | undefined;
  const fakeClient: TypeSafeClientLike = {
    async systemOne(request) {
      captured = { state: request.state, questions: request.questions as Record<string, unknown> };
      return {
        answers: {
          billing: { type: "noul", noul: 0.93 },
          route: { type: "choice", choice: "billing", probabilities: { billing: 0.8, tech: 0.1, other: 0.1 } },
          quality: { type: "score", score: 3.4, probabilities: { "3": 0.5, "4": 0.5 } },
        },
        usage: { input_tokens: 11, output_tokens: 7 },
        model: "jev-latest",
      } as never;
    },
  };
  const adapter = new TypesafeDirectAdapter(() => fakeClient);
  const result = await adapter.evaluate(SAMPLE_REQUEST, "fake-key", new AbortController().signal);

  assert.ok(captured);
  // State passes through untouched.
  assert.deepEqual(captured.state, SAMPLE_REQUEST.state);
  // Question text is the composed payload (question first, framing after).
  const billing = captured.questions.billing as { type: string; instructions: string };
  assert.equal(billing.type, "noul");
  assert.equal(billing.instructions, "Is this about billing?");
  const route = captured.questions.route as { type: string; instructions: string; criteria: Record<string, unknown> };
  assert.equal(route.type, "choice");
  assert.ok(route.instructions.startsWith("Route this ticket"));
  assert.ok(route.instructions.includes("Prefer the most specific class."));
  assert.deepEqual(Object.keys(route.criteria), ["billing", "tech", "other"]);
  const quality = captured.questions.quality as { type: string; criteria: string[] };
  assert.equal(quality.type, "score");
  assert.deepEqual(quality.criteria, ["0", "1", "2", "3", "4", "5"]);

  // Answers normalize onto the janus verdict vocabulary.
  assert.deepEqual(result.answers.billing, { type: "boolean", probability: 0.93 });
  assert.deepEqual(result.answers.route, {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.8, tech: 0.1, other: 0.1 },
  });
  assert.deepEqual(result.answers.quality, {
    type: "score",
    score: 3.4,
    probabilities: { "3": 0.5, "4": 0.5 },
  });
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(result.modelId, "jev-latest");
});

test("typesafe-direct adapter: SDK errors map to fixed-public transport failures", async () => {
  const failingClient: TypeSafeClientLike = {
    async systemOne() {
      const error = new Error("401 Unauthorized — key sk-live-secret invalid");
      throw error;
    },
  };
  const adapter = new TypesafeDirectAdapter(() => failingClient);
  await assert.rejects(
    adapter.evaluate(SAMPLE_REQUEST, "fake-key", new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderTransportError &&
      error.failure.error.code === "gateway_unavailable" &&
      !error.failure.error.message.includes("sk-live-secret"),
  );
});

test("provider surface is closed: typesafe-direct is the only adapter (fallbacks dropped)", () => {
  assert.deepEqual(
    defaultAdapters().map((adapter) => adapter.id),
    ["typesafe-direct"],
  );
});

test("chain: single provider succeeds on the first attempt — no retry", async () => {
  const calls: unknown[] = [];
  const chain = new ProviderChain(
    testProviders(),
    [mockAdapter({ id: "typesafe-direct", calls: calls as never })],
    fakeKeyReader(),
  );
  const outcome = await chain.evaluate(SAMPLE_REQUEST, new AbortController().signal);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.provider, "typesafe-direct");
  assert.equal(calls.length, 1);
  assert.deepEqual(outcome.failedAttemptUsage, []);
});

test("chain: exactly one retry after an eligible transport failure, identical request", async () => {
  const calls: unknown[] = [];
  let first = true;
  const chain = new ProviderChain(
    testRetryProviders(),
    [
      mockAdapter({
        id: "typesafe-direct",
        calls: calls as never,
        fail: () => {
          if (first) {
            first = false;
            return new ProviderTransportError("timeout", timeoutError("slow"));
          }
          return undefined;
        },
      }),
    ],
    fakeKeyReader(),
  );
  const outcome = await chain.evaluate(SAMPLE_REQUEST, new AbortController().signal);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.provider, "typesafe-direct");
  assert.equal(calls.length, 2, "exactly one retry attempt");
  // Identical request on retry (question semantics preserved).
  assert.deepEqual(
    (calls[1] as { questions: unknown }).questions,
    (calls[0] as { questions: unknown }).questions,
  );
  assert.deepEqual((calls[1] as { state: unknown }).state, (calls[0] as { state: unknown }).state);
});

test("chain: NO retry on validation errors", async () => {
  const calls: unknown[] = [];
  const validationShapeError = new ProviderTransportError(
    "validation_error",
    // Fixed taxonomy error with a non-eligible code: never retried.
    { code: "validation_error", status: 400, message: "bad request shape", body: () => ({}) } as never,
  );
  const chain = new ProviderChain(
    testRetryProviders(),
    [
      mockAdapter({
        id: "typesafe-direct",
        calls: calls as never,
        fail: () => validationShapeError,
      }),
    ],
    fakeKeyReader(),
  );
  await assert.rejects(
    chain.evaluate(SAMPLE_REQUEST, new AbortController().signal),
    (error: unknown) => error instanceof ProviderChainError && error.failure.code === "validation_error",
  );
  assert.equal(calls.length, 1, "validation errors never trigger a retry");
});

test("chain: terminal failure carries ALL accumulated attempt usage (review fix #12)", async () => {
  const chain = new ProviderChain(
    testRetryProviders(),
    [
      mockAdapter({
        id: "typesafe-direct",
        fail: () =>
          new ProviderTransportError("gateway_unavailable", gatewayUnavailable("down"), {
            inputTokens: 500,
            outputTokens: 0,
            totalTokens: 500,
          }),
      }),
    ],
    fakeKeyReader(),
  );
  await assert.rejects(
    chain.evaluate(SAMPLE_REQUEST, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof ProviderChainError);
      assert.equal(error.failure.code, "gateway_unavailable");
      assert.equal(error.failedAttemptUsage.length, 2, "both terminal attempts report usage");
      assert.equal(
        error.failedAttemptUsage.reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0),
        1000,
      );
      return true;
    },
  );
});

test("chain: only two attempts even with more provider entries (exactly one retry)", async () => {
  const chain = new ProviderChain(
    [...testRetryProviders(), testProviders()[0]!],
    [
      mockAdapter({
        id: "typesafe-direct",
        fail: () => new ProviderTransportError("timeout", timeoutError("slow")),
      }),
    ],
    fakeKeyReader(),
  );
  await assert.rejects(
    chain.evaluate(SAMPLE_REQUEST, new AbortController().signal),
    (error: unknown) => error instanceof ProviderChainError && error.failure.code === "timeout",
  );
});

test("readiness: ready when the sole provider credential resolves; not ready otherwise", async () => {
  const readyChain = new ProviderChain(
    testProviders(),
    [mockAdapter({ id: "typesafe-direct" })],
    fakeKeyReader(),
  );
  const ready = await readyChain.readiness();
  assert.equal(ready.ready, true);

  const unreadyChain = new ProviderChain(
    testProviders(),
    [mockAdapter({ id: "typesafe-direct" })],
    fakeKeyReader(new Set(["typesafe-ai", "Typesafe AI"])),
  );
  const unready = await unreadyChain.readiness();
  assert.equal(unready.ready, false);
  assert.match(unready.reason ?? "", /no provider credential resolvable/);
  assert.ok(!/test-key|secret value/i.test(unready.reason ?? ""), "no key fragments in the reason");
});

test("missing credential fails closed as model_unauthorized with no provider call", async () => {
  const calls: unknown[] = [];
  const chain = new ProviderChain(
    testProviders(),
    [mockAdapter({ id: "typesafe-direct", calls: calls as never })],
    fakeKeyReader(new Set(["typesafe-ai"])),
  );
  await assert.rejects(
    chain.evaluate(SAMPLE_REQUEST, new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderChainError && error.failure.code === "model_unauthorized",
  );
  assert.equal(calls.length, 0, "no provider attempt without a credential");
});

test("modelUnauthorized stays in the fixed taxonomy (sanity)", () => {
  assert.equal(modelUnauthorized("provider rejected the credential").code, "model_unauthorized");
});
