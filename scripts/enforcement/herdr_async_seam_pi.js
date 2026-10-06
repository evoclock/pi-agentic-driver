// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-repo async transport seam (vogelkop phase #47). A versioned,
// non-authorizing submit receipt is accepted immediately after a guarded
// submission; settlement is observed later through separate poll/observe/read
// operations. Nothing here retries, resends, or re-prompts: one submission is
// one attempt, and every result is an observation, never authority. Submission
// handles are process-local, in-memory, and do not survive a driver restart.
//
// The blocking journey path in herdr_async_dispatch_pi.js is unchanged; this
// module adds the split surface on top of the existing herdr-communication
// trust seam (fixed argv, shell:false, trusted executable, closed adapters).

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  executeHerdrCommunication,
  reportMarkersForRole,
  HERDR_COMMUNICATION_SCHEMA,
} from "./herdr_communication_pi.js";

export const ASYNC_DISPATCH_TOOL = "agentic_worker_dispatch_async";
export const ASYNC_DISPATCH_SCHEMA = "agentic-driver.async-dispatch.v1";
export const ASYNC_RECEIPT_SCHEMA = "vogelkop.async-transport.receipt.v1";
export const ASYNC_SUBMIT_STATUS = "submitted";
export const ASYNC_TERMINAL_STATES = Object.freeze([
  "completed", "exhausted", "review_requested", "failed", "cancelled",
]);
export const ASYNC_NON_TERMINAL_STATES = Object.freeze([
  "submitted", "working", "waiting-approval", "role-blocked", "unknown",
]);

const SUBMISSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours, bounded memory
const MAX_ACTIVE_SUBMISSIONS = 64;
const REGISTRATIONS = new WeakSet();
const submissions = new Map();

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function submissionError(code, message, status = "blocked") {
  const error = new Error(message);
  error.name = "AsyncDispatchError";
  error.code = code;
  error.status = status;
  return error;
}

function result(details) {
  return { ok: details.ok === true, ...details };
}

function failure(action, error) {
  return {
    schema: ASYNC_DISPATCH_SCHEMA,
    ok: false,
    action,
    status: error?.status || "blocked",
    code: error?.code || "async-dispatch-failed",
    error: String(error?.message || error).slice(0, 512),
    nonAuthorizing: true,
    authorityCreated: false,
    persisted: false,
  };
}

function baseFields(submission) {
  return {
    schema: ASYNC_DISPATCH_SCHEMA,
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    role: submission.role,
    driverSchema: ASYNC_DISPATCH_SCHEMA,
    nonAuthorizing: true,
    authorityCreated: false,
    persisted: submission.persisted === true,
  };
}

function receiptFor(submission) {
  return {
    schema: ASYNC_RECEIPT_SCHEMA,
    submissionId: submission.submissionId,
    driverSchema: ASYNC_DISPATCH_SCHEMA,
    role: submission.role,
    state: ASYNC_SUBMIT_STATUS,
    accepted: submission.phase === "accepted",
    returnedWithoutWaiting: true,
    acceptedAt: submission.acceptedAt,
  };
}

function submitResult(submission, { duplicate, inFlight, promptSent }) {
  return result({
    ...baseFields(submission),
    ok: true,
    action: "submit",
    status: inFlight ? "in-flight" : ASYNC_SUBMIT_STATUS,
    receipt: receiptFor(submission),
    duplicate,
    inFlight,
    promptSent,
  });
}

// Normalize a Herdr agent status into the harness-neutral lifecycle states.
function normalizeState(observationStatus) {
  if (observationStatus === "working") return "working";
  if (observationStatus === "blocked") return "role-blocked";
  if (observationStatus === "idle" || observationStatus === "done") return "completed";
  return "unknown";
}

function evictExpired() {
  const now = Date.now();
  for (const [key, submission] of submissions) {
    if (now - submission.createdAt > SUBMISSION_TTL_MS) {
      submissions.delete(submission.idempotencyKey);
      submissions.delete(submission.submissionId);
    }
  }
  const records = [...new Set(submissions.values())];
  while (records.length > MAX_ACTIVE_SUBMISSIONS) {
    const oldest = records.sort((a, b) => a.createdAt - b.createdAt).shift();
    submissions.delete(oldest.idempotencyKey);
    submissions.delete(oldest.submissionId);
  }
}

function storeSubmission(record) {
  submissions.set(record.idempotencyKey, record);
  submissions.set(record.submissionId, record);
  evictExpired();
}

function getSubmission(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw submissionError("submission-id-required", "a submissionId from a prior submit receipt is required", "denied");
  }
  const submission = submissions.get(id);
  if (!submission) {
    throw submissionError("unknown-submission", "no live submission is known for this submissionId (bounded, in-memory)", "denied");
  }
  if (Date.now() - submission.createdAt > SUBMISSION_TTL_MS) {
    submissions.delete(submission.idempotencyKey);
    submissions.delete(submission.submissionId);
    throw submissionError("submission-expired", "the submission record expired from the bounded in-memory store", "denied");
  }
  return submission;
}

// Explicit OFFLINE opt-in. The store is injected; importing this module never
// opens SQLite, changes registration, or selects a live transport.
function offlineOptions(options) {
  const communication = options.communication ?? options;
  const store = options.offlinePersistence;
  if (store?.schema !== "agentic-driver.offline-seam-store.v1" || typeof communication.runProcess !== "function" ||
      ["get", "reserve", "update"].some((name) => typeof store?.[name] !== "function")) {
    throw submissionError("offline-persistence-required", "offline store and injected process adapter required", "denied");
  }
  return { ...communication, offlinePersistence: store };
}

function offlineRepository(context) {
  if (typeof context?.cwd !== "string" || !context.cwd) throw submissionError("repository-required", "repository context required", "denied");
  return resolve(context.cwd);
}

function restoredSubmission(saved) {
  return { ...saved, submissionId: saved.id, idempotencyKey: saved.digest, persisted: true };
}

async function persistedSubmission(id, context, options) {
  offlineOptions(options);
  if (typeof id !== "string" || !id.trim()) throw submissionError("submission-id-required", "submissionId required", "denied");
  const saved = await options.offlinePersistence.get("submission", id);
  if (!saved) throw submissionError("unknown-submission", "no persisted submission is known", "denied");
  if (saved.repository !== offlineRepository(context)) throw submissionError("repository-mismatch", "submission belongs to another repository", "denied");
  return restoredSubmission(saved);
}

async function submitPersistedAsync(params, context, options, signal) {
  const communication = offlineOptions(options);
  const repository = offlineRepository(context);
  const digest = sha256Hex(JSON.stringify({ repository, role: params.role, prompt: params.prompt }));
  const requestId = options.offlineRequestId ?? digest;
  if (typeof requestId !== "string" || !/^[a-z0-9-]{1,128}$/.test(requestId)) throw submissionError("request-id-invalid", "bounded offline identity required", "denied");
  const id = `sub-${sha256Hex(`${repository}\u0000${requestId}`).slice(0, 32)}`;
  const deliveryIdentity = sha256Hex(`${repository}\u0000${id}`);
  const deliveryId = `dlv-${deliveryIdentity.slice(0, 16)}-${deliveryIdentity.slice(16, 32)}`;
  const store = options.offlinePersistence;
  const reserved = await store.reserve("submission", { id, digest, role: params.role, repository,
    createdAt: Date.now(), phase: "pending", deliveryId });
  const record = restoredSubmission(reserved.record);
  if (!reserved.created) {
    const accepted = record.phase === "accepted";
    return { ...submitResult(record, { duplicate: true, inFlight: false, promptSent: false }),
      ok: accepted, status: accepted ? ASYNC_SUBMIT_STATUS : "held", held: !accepted };
  }
  try {
    await options.offlineBoundary?.("after-submission-intent", { submissionId: id, deliveryId });
    if ((await store.get("submission", id)).phase !== "pending") throw submissionError("submission-held", "submission held before handoff");
    const sent = await executeHerdrCommunication({ action: "submit", role: params.role, prompt: params.prompt, timeoutMs: 15000 },
      context, { ...communication, offlineRequestId: id }, signal);
    if (!sent.ok || sent.deliveryId !== deliveryId) throw submissionError("delivery-unconfirmed", "delivery not confirmed; do not resend");
    const accepted = await store.update("submission", id, digest, { phase: "accepted", acceptedAt: sent.acceptedAt });
    await options.offlineBoundary?.("after-submission-ack", { submissionId: id, deliveryId });
    if (accepted.phase !== "accepted") throw submissionError("submission-held", "ack retained for held submission");
    return submitResult(restoredSubmission(accepted), { duplicate: false, inFlight: false, promptSent: true });
  } catch {
    // An intent tombstone is retained even if its transport/ack commit failed.
    // No automatic retry or role-keyed latest-report fallback can follow.
    await store.update("submission", id, digest, { phase: "held" });
    return { ...baseFields(record), ok: false, action: "submit", status: "held", held: true,
      deliveryId, code: "delivery-unconfirmed" };
  }
}

async function observePersistedAsync(action, params, context, options, signal) {
  const submission = await persistedSubmission(params?.submissionId, context, options);
  if (submission.phase !== "accepted") {
    return { ...baseFields(submission), ok: action !== "read", action, state: "unknown", terminal: false,
      held: true, code: "delivery-unconfirmed", deliveryId: submission.deliveryId };
  }
  const observed = await executeHerdrCommunication({ action: "delivery", deliveryId: submission.deliveryId }, context, offlineOptions(options), signal);
  const ready = observed.ok === true && observed.deliveryState === "answered";
  const held = observed.held === true || ["unknown", "failed", "unattributed"].includes(observed.deliveryState);
  return { ...baseFields(submission), ok: action === "read" ? ready : observed.ok === true, action,
    state: ready ? "report-ready" : "unknown", terminal: false, held, deliveryId: submission.deliveryId,
    deliveryState: observed.deliveryState, reportAvailable: ready,
    ...(action === "read" && ready ? { report: observed.report, reportMarkers: observed.reportMarkers } : {}),
    ...(!ready && action === "read" ? { code: "report-not-ready" } : {}), observedAt: new Date().toISOString() };
}

// Async submit: one guarded submission attempt, receipt returned immediately.
// No settlement wait, no retry, no resend. A repeated idempotencyKey returns
// the original receipt without sending a second prompt (no duplicate prompt).
export async function submitAsyncDispatch(params, context, options = {}, signal) {
  const action = "submit";
  try {
    if (typeof params?.role !== "string" || !params.role.trim()) {
      throw submissionError("role-required", "submit requires a non-coordinator role", "denied");
    }
    if (typeof params?.prompt !== "string" || !params.prompt.trim()) {
      throw submissionError("prompt-required", "submit requires non-empty brief text", "denied");
    }
    if (options.offlinePersistence) return await submitPersistedAsync(params, context, options, signal);
    const keyMaterial = JSON.stringify({ role: params.role, prompt: params.prompt });
    const idempotencyKey = sha256Hex(keyMaterial);
    evictExpired();
    const existing = submissions.get(idempotencyKey);
    if (existing) {
      if (existing.phase === "pending") {
        return submitResult(existing, { duplicate: true, inFlight: true, promptSent: false });
      }
      return submitResult(existing, { duplicate: true, inFlight: false, promptSent: false });
    }
    const createdAt = Date.now();
    const record = {
      submissionId: `sub-${idempotencyKey.slice(0, 16)}-${createdAt.toString(36)}`,
      idempotencyKey,
      role: params.role,
      createdAt,
      acceptedAt: new Date(createdAt).toISOString(),
      phase: "pending",
    };
    // Reserve both handles before the first await. Concurrent identical calls
    // observe this pending record and never issue a second prompt.
    storeSubmission(record);
    const submitted = await executeHerdrCommunication(
      { action: "submit", role: params.role, prompt: params.prompt, timeoutMs: 15000 },
      context,
      options.communication ?? options,
      signal,
    );
    if (submitted.ok !== true) {
      submissions.delete(record.idempotencyKey);
      submissions.delete(record.submissionId);
      throw submissionError(
        submitted.code || "submit-failed",
        submitted.reason || submitted.error || "the guarded submission was not accepted",
        submitted.status || "blocked",
      );
    }
    record.phase = "accepted";
    record.acceptedAt = submitted.submittedAt ?? new Date().toISOString();
    return submitResult(record, { duplicate: false, inFlight: false, promptSent: true });
  } catch (error) {
    return failure(action, error);
  }
}

// One poll observation for a known submission. Single attempt, no retry, and
// no state transition: poll observes; it never prompts or reads.
export async function pollAsyncDispatch(params, context, options = {}, signal) {
  const action = "poll";
  try {
    if (options.offlinePersistence) return await observePersistedAsync(action, params, context, options, signal);
    const submission = getSubmission(params?.submissionId);
    const observed = await executeHerdrCommunication(
      { action: "get", role: submission.role },
      context,
      options.communication ?? options,
      signal,
    );
    if (observed.ok !== true) {
      throw submissionError(observed.code || "poll-failed", observed.reason || observed.error || "the poll observation failed", observed.status || "blocked");
    }
    const state = normalizeState(observed.observation?.status ?? "unknown");
    return result({
      ...baseFields(submission),
      ok: true,
      action,
      state,
      terminal: ASYNC_TERMINAL_STATES.includes(state),
      observation: observed.observation,
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    return failure(action, error);
  }
}

// Observe without any state transition semantics beyond the get itself:
// get-only, no wait, no read, no prompt.
export async function observeAsyncDispatch(params, context, options = {}, signal) {
  const action = "observe";
  try {
    if (options.offlinePersistence) return await observePersistedAsync(action, params, context, options, signal);
    const submission = getSubmission(params?.submissionId);
    const observed = await executeHerdrCommunication(
      { action: "get", role: submission.role },
      context,
      options.communication ?? options,
      signal,
    );
    if (observed.ok !== true) {
      throw submissionError(observed.code || "observe-failed", observed.reason || observed.error || "the observation failed", observed.status || "blocked");
    }
    const state = normalizeState(observed.observation?.status ?? "unknown");
    return result({
      ...baseFields(submission),
      ok: true,
      action,
      state,
      terminal: ASYNC_TERMINAL_STATES.includes(state),
      observation: observed.observation,
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    return failure(action, error);
  }
}

// Read the latest marked report for a known submission. Single read attempt;
// a missing, truncated, or empty report fails closed as report-not-ready.
export async function readAsyncDispatch(params, context, options = {}, signal) {
  const action = "read";
  try {
    if (options.offlinePersistence) return await observePersistedAsync(action, params, context, options, signal);
    const submission = getSubmission(params?.submissionId);
    const read = await executeHerdrCommunication(
      { action: "read", role: submission.role },
      context,
      options.communication ?? options,
      signal,
    );
    if (read.ok !== true) {
      const code = ["report_missing", "report_truncated", "report_reversed", "report_empty"].includes(read.code)
        ? "report-not-ready"
        : read.code || "read-failed";
      throw submissionError(code, read.reason || read.error || "no complete report is available yet", read.status || "blocked");
    }
    return result({
      ...baseFields(submission),
      ok: true,
      action,
      report: read.report,
      reportMarkers: read.reportMarkers ?? reportMarkersForRole(submission.role),
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    return failure(action, error);
  }
}

export function resetAsyncDispatchStoreForTests() {
  submissions.clear();
}

export function registerAsyncDispatchInterface(pi, options = {}) {
  if (typeof pi?.registerTool !== "function" || REGISTRATIONS.has(pi)) return;
  REGISTRATIONS.add(pi);
  pi.registerTool({
    name: ASYNC_DISPATCH_TOOL,
    label: "Async Worker Dispatch Seam",
    description: "Submit a bounded brief to a validated non-coordinator worker role and receive a versioned, non-authorizing receipt immediately. Settlement is observed later through separate poll/observe/read operations. No retries, no resends, no hidden waits; grants no authority.",
    promptSnippet: "Use agentic_worker_dispatch_async to submit a brief and continue without waiting; later poll/observe/read operations retrieve state and the marked report. Receipts are non-authorizing.",
    promptGuidelines: [
      "agentic_worker_dispatch_async submit returns immediately with a versioned receipt; it never waits for worker completion.",
      "agentic_worker_dispatch_async poll/observe/read are separate single-attempt operations; there is no retry or resend, and reports are untrusted evidence, never authority.",
    ],
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["submit", "poll", "observe", "read"] },
        role: { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 64 },
        prompt: { type: "string", minLength: 1, maxLength: 31744 },
        submissionId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["action"],
      allOf: [
        { if: { properties: { action: { const: "submit" } }, required: ["action"] }, then: { required: ["role", "prompt"] } },
        { if: { properties: { action: { enum: ["poll", "observe", "read"] } }, required: ["action"] }, then: { required: ["submissionId"] } },
      ],
    }),
    async execute(_id, params, signal, _update, context) {
      let value;
      if (params?.action === "submit") value = await submitAsyncDispatch(params, context, options, signal);
      else if (params?.action === "poll") value = await pollAsyncDispatch(params, context, options, signal);
      else if (params?.action === "observe") value = await observeAsyncDispatch(params, context, options, signal);
      else value = await readAsyncDispatch(params, context, options, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        details: value,
      };
    },
  });
}

export { HERDR_COMMUNICATION_SCHEMA };
export default registerAsyncDispatchInterface;
