// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests: the §5 error taxonomy — callers must distinguish "model
// returned false" (200) from "no verdict" (timeout/gateway_unavailable) from
// "bad request" (validation_error) — plus provider error classification with
// FIXED public messages (review fix #5).

import test from "node:test";
import assert from "node:assert/strict";
import {
  APIError,
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import {
  JanusError,
  busyError,
  gatewayUnavailable,
  timeoutError,
  validationError,
} from "../janus/errors.js";
import {
  classifyGatewayError,
  classifyTypesafeError,
  ProviderTransportError,
} from "../janus/providers.js";

test("taxonomy codes are exactly the §5 set", () => {
  const codes: JanusError["code"][] = [
    "validation_error",
    "state_too_large",
    "unknown_question",
    "model_unauthorized",
    "gateway_unavailable",
    "timeout",
    "busy",
    "degraded",
  ];
  for (const code of codes) {
    const error = new JanusError(code, "message", 400);
    assert.equal(error.code, code);
    const body = error.body("req-1");
    assert.deepEqual(
      { error: body.error, message: body.message, request_id: body.request_id },
      { error: code, message: "message", request_id: "req-1" },
    );
  }
});

test("error body shape is {error, message, request_id} with optional detail", () => {
  const plain = validationError("bad").body("r1");
  assert.deepEqual(plain, { error: "validation_error", message: "bad", request_id: "r1" });
  const detailed = busyError("cap", { budget_exhausted: { kind: "tokens" } }).body("r2");
  assert.deepEqual(detailed.detail, { budget_exhausted: { kind: "tokens" } });
});

test("status mapping separates classes", () => {
  assert.equal(validationError("x").status, 400);
  assert.equal(busyError("x").status, 429);
  assert.equal(timeoutError("x").status, 504);
  assert.equal(gatewayUnavailable("x").status, 503);
});

function apiError(status: number, body: unknown): APIError {
  return APIError.fromResponse(status, body, new Headers());
}

test("typesafe classification: abort → timeout with fixed message", () => {
  const failure = classifyTypesafeError(new APIUserAbortError());
  assert.equal(failure.failure.error.code, "timeout");
  assert.equal(failure.failure.error.message, "evaluation timed out");
  // Timeout is a transport failure: eligible for the single failover to the
  // NEXT provider, never retried in place on the same one.
  assert.equal(failure.failure.failoverEligible, true);
});

test("typesafe classification: connection/timeout errors → gateway_unavailable, failover eligible", () => {
  for (const error of [new APIConnectionError("dns broke"), new APITimeoutError(1000)]) {
    const failure = classifyTypesafeError(error);
    assert.equal(failure.failure.error.code, "gateway_unavailable");
    assert.equal(failure.failure.failoverEligible, true);
  }
});

test("typesafe classification: 401/403 → model_unauthorized, failover eligible", () => {
  for (const status of [401, 403]) {
    const failure = classifyTypesafeError(apiError(status, {}));
    assert.equal(failure.failure.error.code, "model_unauthorized");
    assert.equal(failure.failure.failoverEligible, true);
  }
});

test("typesafe classification: 429/404/5xx → gateway_unavailable, failover eligible", () => {
  for (const status of [429, 404, 500, 503]) {
    const failure = classifyTypesafeError(apiError(status, {}));
    assert.equal(failure.failure.error.code, "gateway_unavailable");
    assert.equal(failure.failure.failoverEligible, true);
  }
});

test("typesafe classification: client-side TypeSafeError fails closed as unavailable", () => {
  const failure = classifyTypesafeError(new TypeSafeError("bad criteria shape"));
  assert.equal(failure.failure.error.code, "gateway_unavailable");
});

test("gateway classification: abort → timeout; network → unavailable; auth → unauthorized", () => {
  const abortError = new Error("Request aborted");
  abortError.name = "AbortError";
  assert.equal(classifyGatewayError(abortError).failure.error.code, "timeout");
  assert.equal(
    classifyGatewayError(new Error("fetch failed: ECONNREFUSED")).failure.error.code,
    "gateway_unavailable",
  );
  assert.equal(
    classifyGatewayError(new Error("401 Unauthorized: invalid api key")).failure.error.code,
    "model_unauthorized",
  );
  assert.equal(classifyGatewayError(new Error("429 rate limit exceeded")).failure.error.code, "gateway_unavailable");
});

test("public messages never contain provider/SDK/internal error text (review fix #5)", () => {
  const sensitive = "sk-live-abcdef0123456789 internal stack detail";
  const errors: unknown[] = [
    apiError(500, { message: sensitive }),
    new APIConnectionError(sensitive),
    new TypeSafeError(sensitive),
    new Error(sensitive),
  ];
  for (const error of errors) {
    const classified = error instanceof TypeSafeError && !(error instanceof APIError)
      ? classifyTypesafeError(error)
      : classifyTypesafeError(error);
    const message = classified.failure.error.message;
    assert.ok(!message.includes(sensitive), `message must be fixed, got: ${message}`);
    assert.ok(!/sk-/.test(message));
  }
});

test("ProviderTransportError preserves classification and is idempotent", () => {
  const first = classifyTypesafeError(apiError(429, {}));
  assert.ok(first instanceof ProviderTransportError);
  const again = classifyTypesafeError(first);
  assert.equal(again, first, "re-classifying a ProviderTransportError returns it unchanged");
});
