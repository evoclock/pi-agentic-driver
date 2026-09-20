// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// janus error taxonomy (§5, M9).
//
// Callers must be able to distinguish:
//   - "model returned false"  → HTTP 200 with a low-probability verdict
//   - "no verdict"            → timeout / gateway_unavailable / model_unauthorized
//   - "bad request"           → validation_error (and state_too_large)
//   - "capacity"              → busy (single-flight contention or budget breaker)

export type JanusErrorCode =
  | "validation_error"
  | "state_too_large"
  | "unknown_question"
  | "model_unauthorized"
  | "gateway_unavailable"
  | "timeout"
  | "busy"
  | "degraded";

export class JanusError extends Error {
  readonly code: JanusErrorCode;
  /** HTTP status paired with the code by the server. */
  readonly status: number;
  /** Optional structured detail (e.g. budget_exhausted, field-level errors). */
  readonly detail?: Record<string, unknown>;

  constructor(
    code: JanusErrorCode,
    message: string,
    status: number,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JanusError";
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }

  /** Machine-readable error body: {error, message, request_id, detail?}. */
  body(requestId: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      error: this.code,
      message: this.message,
      request_id: requestId,
    };
    if (this.detail !== undefined) body.detail = this.detail;
    return body;
  }
}

export function validationError(
  message: string,
  detail?: Record<string, unknown>,
): JanusError {
  return new JanusError("validation_error", message, 400, detail);
}

export function stateTooLarge(message: string, detail?: Record<string, unknown>): JanusError {
  return new JanusError("state_too_large", message, 413, detail);
}

export function unknownQuestion(message: string, detail?: Record<string, unknown>): JanusError {
  return new JanusError("unknown_question", message, 400, detail);
}

export function modelUnauthorized(message: string, detail?: Record<string, unknown>): JanusError {
  return new JanusError("model_unauthorized", message, 502, detail);
}

export function gatewayUnavailable(
  message: string,
  detail?: Record<string, unknown>,
): JanusError {
  return new JanusError("gateway_unavailable", message, 503, detail);
}

export function timeoutError(message: string, detail?: Record<string, unknown>): JanusError {
  return new JanusError("timeout", message, 504, detail);
}

export function busyError(message: string, detail?: Record<string, unknown>): JanusError {
  return new JanusError("busy", message, 429, detail);
}

export function degraded(message: string, detail?: Record<string, unknown>): JanusError {
  return new JanusError("degraded", message, 503, detail);
}
