// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// NUDGE §6 recovery ledger (SPEC_TASK43_NUDGE.md v3.3.1). Pure module: no
// I/O, no transport, no authority store. Every recovery action (nudge or
// replacement) is an immutable, journey-linked ledger entry appended to
// `journey.recoveryLedger` and serialized inside or as a bounded,
// digest-linked section of the existing [WORKER_JOURNEY_REPORT_BEGIN/END]
// receipt. The ledger is audit evidence inside the journey receipt — it
// never grants dispatch authority and never performs rollback; §6.3 gives
// the owner a bounded revert-anchor procedure.

import { createHash } from "node:crypto";

export const NUDGE_LEDGER_VERSION = 1;

// Closed enums (NUDGE §6.2).
export const NUDGE_LEDGER_ACTIONS = Object.freeze(["nudge", "replacement"]);
export const NUDGE_LEDGER_RESULTS = Object.freeze([
  "requested", "delivered", "rejected", "unknown", "spawned", "failed", "parked",
]);
export const NUDGE_AUTHORITY_SOURCES = Object.freeze(["direct", "queue", "board"]);
export const NUDGE_AUTHORITY_KINDS = Object.freeze([
  "direct-instruction", "session-task", "board-envelope",
]);
export const NUDGE_DELIVERY_STATES = Object.freeze([
  "delivered", "rejected-before-delivery", "unknown",
]);

// Ledger-local canonical JSON (NUDGE §6.2): sort object keys at every depth,
// retain array order and exact string code points, and preserve explicit null.
// Do not reuse the board canonicalizer: its normalization and omission rules
// are not part of the ledger digest contract.
function sortLedgerValue(value) {
  if (Array.isArray(value)) return value.map(sortLedgerValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortLedgerValue(value[key])]));
}

export function nudgeCanonicalJsonString(value) {
  return JSON.stringify(sortLedgerValue(value));
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The closed record shape (§6.2), as an exact-key template. Optional keys
// are listed with their presence conditions so validation can name the
// exact path of any violation.
const REQUIRED_TOP_KEYS = Object.freeze([
  "ledgerVersion", "entryId", "journeyId", "timestamp",
  "action", "role", "journeyStep", "attemptOrdinal",
  "repository", "dispatchAuthorization",
  "autonomy", "containmentProfile", "operationClasses",
  "preState", "result",
  "preGit",
]);
const CONDITIONAL_TOP_KEYS = Object.freeze([
  // replacement entries only:
  "replacementRole",
  // source-defined nullable identities:
  "taskId", "claimId", "envelopeId", "branch",
  // nudge entries (bounded exact sent text + integrity):
  "messageText", "messageSha256", "messageBytes",
  // delivery evidence:
  "deliveryState", "herdrCode",
  // terminal post-action observations:
  "postGit",
  // linkage:
  "parentEntryId", "spawnReceiptDigest", "reportMarkers", "reasonCode",
]);
const REQUIRED_AUTH_KEYS = Object.freeze([
  "dispatchId", "source", "authorityProvenance", "authorityMaterial",
  "authorityDigest", "authorizedAt",
  "repositoryScope", "containmentProfile", "operationClasses", "scopeDigest",
]);
const OPTIONAL_AUTH_KEYS = Object.freeze([
  "expiresAt", "revokedAt", "claimId", "envelopeId", "taskId",
]);
const REQUIRED_PROVENANCE_KEYS = Object.freeze(["kind", "reference", "capturedAt"]);
const REQUIRED_PRESTATE_KEYS = Object.freeze([
  "classification", "agentStatus", "pollOrdinal",
]);
const OPTIONAL_PRESTATE_KEYS = Object.freeze(["stateChangeSeq", "revision"]);
const REQUIRED_GIT_KEYS = Object.freeze(["head", "statusDigest", "diffDigest"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value, requiredKeys, optionalKeys, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const key of requiredKeys) {
    if (value[key] === undefined) errors.push(`${path}.${key}: REQUIRED key absent`);
  }
  for (const key of Object.keys(value)) {
    if (!requiredKeys.includes(key) && !optionalKeys.includes(key)) {
      errors.push(`${path}.${key}: key outside the closed record shape`);
    }
  }
}

// Validate one ledger entry against the closed §6.2 shape. Returns
// {ok, errors} with exact paths. Both actions require the exact message and
// integrity fields; `action: replacement` also requires `replacementRole`
// and rejects the nudge-only delivery fields.
export function validateLedgerEntry(entry) {
  const errors = [];
  if (!isPlainObject(entry)) {
    return { ok: false, errors: ["entry: must be an object"] };
  }
  checkKeys(entry, REQUIRED_TOP_KEYS, CONDITIONAL_TOP_KEYS, "entry", errors);

  if (entry.ledgerVersion !== NUDGE_LEDGER_VERSION) {
    errors.push(`entry.ledgerVersion: must be ${NUDGE_LEDGER_VERSION}`);
  }
  for (const key of ["entryId", "journeyId", "timestamp", "role", "repository"]) {
    if (typeof entry[key] !== "string" || entry[key] === "") {
      errors.push(`entry.${key}: must be a non-empty string`);
    }
  }
  if (typeof entry.attemptOrdinal !== "number" || !Number.isSafeInteger(entry.attemptOrdinal) || entry.attemptOrdinal < 0) {
    errors.push("entry.attemptOrdinal: must be a safe integer >= 0");
  }
  if (!(typeof entry.journeyStep === "string" && entry.journeyStep !== "")
    && !(typeof entry.journeyStep === "number" && Number.isSafeInteger(entry.journeyStep) && entry.journeyStep >= 0)) {
    errors.push("entry.journeyStep: must be a non-empty string or a safe integer >= 0");
  }
  if (!NUDGE_LEDGER_ACTIONS.includes(entry.action)) {
    errors.push(`entry.action: must be one of ${NUDGE_LEDGER_ACTIONS.join(", ")}`);
  }
  if (!NUDGE_LEDGER_RESULTS.includes(entry.result)) {
    errors.push(`entry.result: must be one of ${NUDGE_LEDGER_RESULTS.join(", ")}`);
  }
  if (entry.action === "replacement") {
    if (typeof entry.replacementRole !== "string" || entry.replacementRole === "") {
      errors.push("entry.replacementRole: REQUIRED for a replacement entry");
    }
    for (const key of ["deliveryState", "herdrCode"]) {
      if (entry[key] !== undefined) errors.push(`entry.${key}: nudge-only field on a replacement entry`);
    }
  } else if (entry.action === "nudge") {
    if (entry.deliveryState !== undefined && !NUDGE_DELIVERY_STATES.includes(entry.deliveryState)) {
      errors.push(`entry.deliveryState: must be one of ${NUDGE_DELIVERY_STATES.join(", ")}`);
    }
  }
  if (typeof entry.messageText !== "string" || entry.messageText === "") {
    errors.push("entry.messageText: REQUIRED for every ledger action (exact bounded sent text)");
  }
  if (typeof entry.messageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.messageSha256)) {
    errors.push("entry.messageSha256: must be lowercase SHA-256 hex of messageText");
  }
  const expectedMessageBytes = typeof entry.messageText === "string"
    ? Buffer.byteLength(entry.messageText, "utf8")
    : null;
  if (typeof entry.messageBytes !== "number" || !Number.isSafeInteger(entry.messageBytes) || entry.messageBytes < 1) {
    errors.push("entry.messageBytes: REQUIRED positive safe integer (UTF-8 byte count)");
  } else if (expectedMessageBytes !== null && entry.messageBytes !== expectedMessageBytes) {
    errors.push("entry.messageBytes: must equal the UTF-8 byte count of messageText");
  }
  if (entry.reasonCode !== undefined && entry.reasonCode !== null
    && typeof entry.reasonCode !== "string") {
    errors.push("entry.reasonCode: must be a string when present");
  }

  // dispatchAuthorization (SEAM §2.4 minting contract, NUDGE §6.2 shape).
  const auth = entry.dispatchAuthorization;
  if (!isPlainObject(auth)) {
    errors.push("entry.dispatchAuthorization: must be an object");
  } else {
    checkKeys(auth, REQUIRED_AUTH_KEYS, OPTIONAL_AUTH_KEYS, "entry.dispatchAuthorization", errors);
    for (const key of ["dispatchId", "authorizedAt", "authorityDigest", "repositoryScope", "containmentProfile"]) {
      if (typeof auth[key] !== "string" || auth[key] === "") {
        errors.push(`entry.dispatchAuthorization.${key}: must be a non-empty string`);
      }
    }
    if (!NUDGE_AUTHORITY_SOURCES.includes(auth.source)) {
      errors.push(`entry.dispatchAuthorization.source: must be one of ${NUDGE_AUTHORITY_SOURCES.join(", ")}`);
    }
    if (!Array.isArray(auth.operationClasses) || auth.operationClasses.some((c) => typeof c !== "string" || c === "")) {
      errors.push("entry.dispatchAuthorization.operationClasses: must be an array of non-empty strings");
    }
    if (!/^[0-9a-f]{64}$/.test(auth.authorityDigest ?? "")) {
      errors.push("entry.dispatchAuthorization.authorityDigest: must be lowercase SHA-256 hex");
    }
    if (!/^[0-9a-f]{64}$/.test(auth.scopeDigest ?? "")) {
      errors.push("entry.dispatchAuthorization.scopeDigest: must be lowercase SHA-256 hex");
    }
    const provenance = auth.authorityProvenance;
    if (!isPlainObject(provenance)) {
      errors.push("entry.dispatchAuthorization.authorityProvenance: must be an object");
    } else {
      checkKeys(provenance, REQUIRED_PROVENANCE_KEYS, [], "entry.dispatchAuthorization.authorityProvenance", errors);
      if (!NUDGE_AUTHORITY_KINDS.includes(provenance.kind)) {
        errors.push(`entry.dispatchAuthorization.authorityProvenance.kind: must be one of ${NUDGE_AUTHORITY_KINDS.join(", ")}`);
      }
    }
  }

  if (!Array.isArray(entry.operationClasses) || entry.operationClasses.some((c) => typeof c !== "string" || c === "")) {
    errors.push("entry.operationClasses: must be an array of non-empty strings");
  }

  // preState.
  if (!isPlainObject(entry.preState)) {
    errors.push("entry.preState: must be an object");
  } else {
    checkKeys(entry.preState, REQUIRED_PRESTATE_KEYS, OPTIONAL_PRESTATE_KEYS, "entry.preState", errors);
    if (typeof entry.preState.classification !== "string" || entry.preState.classification === "") {
      errors.push("entry.preState.classification: must be a non-empty string");
    }
    if (typeof entry.preState.agentStatus !== "string" || entry.preState.agentStatus === "") {
      errors.push("entry.preState.agentStatus: must be a non-empty string");
    }
    const pollOrdinal = entry.preState.pollOrdinal;
    if (typeof pollOrdinal !== "number" || !Number.isSafeInteger(pollOrdinal) || pollOrdinal < 0) {
      errors.push("entry.preState.pollOrdinal: must be a safe integer >= 0");
    }
  }

  // Git observations (pre required, post optional): they are observations
  // from the trusted repository and never assert clean state.
  for (const [key, required] of [["preGit", true], ["postGit", false]]) {
    const value = entry[key];
    if (value === undefined) {
      if (required) errors.push(`entry.${key}: REQUIRED`);
      continue;
    }
    if (!isPlainObject(value)) {
      errors.push(`entry.${key}: must be an object`);
      continue;
    }
    checkKeys(value, REQUIRED_GIT_KEYS, [], `entry.${key}`, errors);
    for (const sub of REQUIRED_GIT_KEYS) {
      const digest = value[sub];
      const isHead = sub === "head";
      const hexOk = isHead ? /^[0-9a-f]{40}$/.test(digest ?? "") : /^[0-9a-f]{64}$/.test(digest ?? "");
      if (typeof digest !== "string" || !hexOk) {
        errors.push(`entry.${key}.${sub}: must be ${isHead ? "a 40-hex Git commit SHA" : "lowercase SHA-256 hex"}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// Digest recomputation (§6.2). Given a validated entry, recompute:
//  - direct: authorityDigest = SHA-256 of the exact stepPrompt UTF-8 bytes
//    (no newline/Unicode normalization); messageSha256 = SHA-256 of the
//    exact messageText bytes.
//  - queue: authorityDigest = SHA-256 of canonical JSON of the immutable
//    captured material {id,title,description,capturedAt} (missing
//    title/description is explicit null; mutable status/blockedBy/owner are
//    excluded by construction).
//  - board: the existing envelope authority digest is preserved, not
//    recomputed — recomputing the formal-tier HMAC requires the board
//    secret; the ledger preserves board bytes and digests for keyed
//    verification. Recompute returns {recomputable: false} for board.
//  - all: scopeDigest = SHA-256 of canonical JSON
//    {operationClasses,containmentProfile,repositoryScope} with classes
//    sorted and deduplicated.
// An owner can recompute both digests from one ledger record without HMAC
// infrastructure for direct and queue.
function recomputeEntryDigestsUnchecked(entry) {
  if (!entry?.dispatchAuthorization) return { ok: false, errors: ["entry.dispatchAuthorization: absent"] };
  const auth = entry.dispatchAuthorization;
  const errors = [];
  const scopeObject = {
    operationClasses: [...new Set([...(auth.operationClasses ?? [])].sort())],
    containmentProfile: auth.containmentProfile,
    repositoryScope: auth.repositoryScope,
  };
  const scopeDigest = sha256Hex(nudgeCanonicalJsonString(scopeObject));
  if (scopeDigest !== auth.scopeDigest) {
    errors.push("scopeDigest mismatch: recomputed scope digest differs from the recorded one");
  }

  let authorityDigest = null;
  let recomputable = true;
  if (auth.source === "direct") {
    if (typeof auth.authorityMaterial !== "string") {
      errors.push("direct authorityMaterial: must be the exact stepPrompt string (lossless receipt representation)");
    } else {
      authorityDigest = sha256Hex(auth.authorityMaterial);
    }
  } else if (auth.source === "queue") {
    const material = auth.authorityMaterial;
    if (!isPlainObject(material)) {
      errors.push("queue authorityMaterial: must be the immutable captured object {id,title,description,capturedAt}");
    } else {
      const immutable = {
        id: material.id ?? null,
        title: material.title ?? null,
        description: material.description ?? null,
        capturedAt: material.capturedAt ?? null,
      };
      authorityDigest = sha256Hex(nudgeCanonicalJsonString(immutable));
    }
  } else {
    // board: keyed verification only; the ledger preserves bytes + digests.
    recomputable = false;
  }
  if (recomputable && authorityDigest !== null && authorityDigest !== auth.authorityDigest) {
    errors.push("authorityDigest mismatch: recomputed authority digest differs from the recorded one");
  }
  if (typeof entry.messageText === "string" && typeof entry.messageSha256 === "string") {
    const messageDigest = sha256Hex(entry.messageText);
    if (messageDigest !== entry.messageSha256) {
      errors.push("messageSha256 mismatch: recomputed message digest differs from the recorded one");
    }
    const bytes = Buffer.byteLength(entry.messageText, "utf8");
    if (entry.messageBytes !== undefined && bytes !== entry.messageBytes) {
      errors.push("messageBytes mismatch: recomputed UTF-8 byte count differs from the recorded one");
    }
  }
  return { ok: errors.length === 0, recomputable, errors, scopeDigest, authorityDigest };
}

export function recomputeEntryDigests(entry) {
  try {
    return recomputeEntryDigestsUnchecked(entry);
  } catch (error) {
    return { ok: false, errors: [`entry: malformed digest material (${error instanceof Error ? error.message : String(error)})`] };
  }
}

// ---------------------------------------------------------------------------
// Two-phase in-memory write: `requested` before mutation, terminal result
// afterward, linked by entryId. Receipt serialization represents both phases
// so an interrupted action remains visible. A nudge or replacement without a
// ledger pre-entry is forbidden — buildRequestedEntry is the only way to
// mint the pre-entry, and appendTerminalResult refuses an unknown entryId.
// ---------------------------------------------------------------------------

let entryCounter = 0;

export function buildRequestedEntry({
  journeyId, timestamp, action, role, replacementRole = undefined,
  journeyStep, attemptOrdinal, taskId = null, claimId = null, envelopeId = null,
  repository, branch = undefined, dispatchAuthorization,
  autonomy, containmentProfile, operationClasses,
  preState, messageText = undefined, reasonCode = undefined,
  preGit, parentEntryId = undefined,
}) {
  if (action !== "nudge" && action !== "replacement") {
    throw Object.assign(new Error("action must be nudge | replacement"), { code: "invalid-input" });
  }
  if (typeof messageText !== "string" || messageText === "") {
    throw Object.assign(new Error("messageText (the exact bounded sent text, including framing) is required before any mutation"), { code: "invalid-input" });
  }
  entryCounter += 1;
  const entry = {
    ledgerVersion: NUDGE_LEDGER_VERSION,
    entryId: `nudge-${journeyId}-${journeyStep}-${attemptOrdinal}-${entryCounter}`,
    journeyId, timestamp, action, role,
    ...(action === "replacement" ? { replacementRole } : {}),
    ...(taskId !== null ? { taskId } : {}),
    ...(claimId !== null ? { claimId } : {}),
    ...(envelopeId !== null ? { envelopeId } : {}),
    ...(branch !== undefined ? { branch } : {}),
    journeyStep, attemptOrdinal,
    repository,
    dispatchAuthorization,
    autonomy, containmentProfile, operationClasses,
    preState,
    messageText,
    messageSha256: sha256Hex(messageText),
    messageBytes: Buffer.byteLength(messageText, "utf8"),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    result: "requested",
    preGit,
    ...(parentEntryId !== undefined ? { parentEntryId } : {}),
  };
  const validation = validateLedgerEntry(entry);
  if (!validation.ok) {
    throw Object.assign(new Error(`requested ledger entry is invalid: ${validation.errors.join("; ")}`), { code: "invalid-ledger-entry" });
  }
  return entry;
}

export function appendTerminalResult(ledger, entryId, terminal) {
  if (!Array.isArray(ledger)) {
    throw Object.assign(new Error("ledger must be an array"), { code: "invalid-input" });
  }
  const requested = ledger.find((entry) => entry.entryId === entryId);
  if (!requested) {
    throw Object.assign(
      new Error(`no requested ledger entry ${entryId} — a nudge or replacement without a pre-entry is forbidden`),
      { code: "pre-entry-required" },
    );
  }
  const terminalKeys = [
    "result", "deliveryState", "herdrCode", "postGit", "spawnReceiptDigest", "reportMarkers",
  ];
  if (!isPlainObject(terminal)) {
    throw Object.assign(new Error("terminal must be an object"), { code: "invalid-input" });
  }
  const unknownTerminalKeys = Object.keys(terminal).filter((key) => !terminalKeys.includes(key));
  if (unknownTerminalKeys.length > 0) {
    throw Object.assign(
      new Error(`terminal keys outside the allowlist: ${unknownTerminalKeys.join(", ")}`),
      { code: "invalid-input" },
    );
  }
  if (!NUDGE_LEDGER_RESULTS.includes(terminal.result)) {
    throw Object.assign(new Error(`terminal result must be one of ${NUDGE_LEDGER_RESULTS.join(", ")}`), { code: "invalid-input" });
  }
  if (terminal.result === "requested") {
    throw Object.assign(new Error("terminal result cannot be requested"), { code: "invalid-input" });
  }
  const allowedTerminal = Object.fromEntries(
    terminalKeys.filter((key) => terminal[key] !== undefined).map((key) => [key, terminal[key]]),
  );
  const merged = { ...requested, ...allowedTerminal, entryId, result: terminal.result };
  const validation = validateLedgerEntry(merged);
  if (!validation.ok) {
    throw Object.assign(new Error(`terminal ledger entry is invalid: ${validation.errors.join("; ")}`), { code: "invalid-ledger-entry" });
  }
  return ledger.map((entry) => (entry.entryId === entryId ? merged : entry));
}

// ---------------------------------------------------------------------------
// Receipt serialization (§6.1): the ledger serializes inside or as a bounded,
// digest-linked section of the existing journey receipt. Fail closed rather
// than silently truncating: if the serialized section exceeds maxBytes, the
// caller must fail the journey instead of dropping exact records.
// ---------------------------------------------------------------------------

export function serializeLedgerSection(ledger, { maxBytes } = {}) {
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw Object.assign(new Error("maxBytes is required and must be a positive safe integer (fail closed)"), { code: "invalid-input" });
  }
  const body = [
    "[RECOVERY_LEDGER_BEGIN]",
    `entries: ${ledger.length}`,
    ...ledger.map((entry) => `entry ${entry.entryId}: ${JSON.stringify(entry)}`),
    "[RECOVERY_LEDGER_END]",
  ].join("\n");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > maxBytes) {
    // Fail closed: no silent truncation of exact nudge/replacement records.
    const error = new Error(`recovery ledger section is ${bytes} bytes, exceeding the ${maxBytes}-byte receipt bound — the journey fails closed rather than silently dropping exact ledger records (§6.1)`);
    error.code = "ledger-receipt-capacity-exceeded";
    error.sectionBytes = bytes;
    error.maxBytes = maxBytes;
    throw error;
  }
  return { body, bytes, digest: sha256Hex(body) };
}

// ---------------------------------------------------------------------------
// Revert-anchor selection (§6.3). The ledger does not perform rollback; it
// gives the owner a precise boundary. Selection is pure: given the ledger
// and the current repository observation, select the last accepted ledger
// entry and report exactly which comparisons hold, so the owner can create
// a safety branch and restore to the recorded boundary. Several workers can
// touch one worktree, so the ledger never claims causality from timestamps
// alone — `atBoundary` is evidence, not a verdict.
// ---------------------------------------------------------------------------

export function selectRevertAnchor(ledger, {
  repository = null, branch = null, head = null, statusDigest = null, diffDigest = null,
} = {}) {
  // "Accepted" entries: terminal, non-failed outcomes. requested-only
  // entries (interrupted actions) and failed/parked outcomes are never
  // anchors — the last accepted state is the recovery boundary.
  const accepted = ledger.filter((entry) =>
    entry.result !== "requested"
    && entry.result !== "failed"
    && entry.result !== "parked");
  if (accepted.length === 0) {
    return { ok: false, code: "no-accepted-entry", reason: "no accepted ledger entry exists to anchor a revert" };
  }
  const anchor = accepted[accepted.length - 1];
  const comparisons = {
    repositoryMatch: repository === null ? null : anchor.repository === repository,
    branchMatch: branch === null || anchor.branch === undefined ? null : anchor.branch === branch,
    headMatch: head === null ? null : anchor.preGit.head === head || anchor.postGit?.head === head,
    statusDigestMatch: statusDigest === null ? null : anchor.preGit.statusDigest === statusDigest || anchor.postGit?.statusDigest === statusDigest,
    diffDigestMatch: diffDigest === null ? null : anchor.preGit.diffDigest === diffDigest || anchor.postGit?.diffDigest === diffDigest,
  };
  const observed = Object.values(comparisons).every((value) => value !== false);
  return {
    ok: true,
    anchor: {
      entryId: anchor.entryId,
      action: anchor.action,
      role: anchor.role,
      timestamp: anchor.timestamp,
      preGit: anchor.preGit,
      postGit: anchor.postGit ?? null,
      taskId: anchor.taskId ?? null,
      claimId: anchor.claimId ?? null,
      envelopeId: anchor.envelopeId ?? null,
    },
    comparisons,
    // True only when every supplied current observation matches the anchor's
    // recorded boundary. Automatic revert requires branch/worktree isolation
    // and commit attribution beyond this evidence (§6.3).
    atBoundary: observed,
    procedure: [
      "select the last accepted ledger entry",
      "verify repository/branch and compare current HEAD, status digest, and diff digest with the entry's pre/post Git observations",
      "inspect git log and git diff across the selected entry and later entries to attribute commits and uncommitted paths",
      "create a safety branch or snapshot",
      "revert later commits in reverse order, or restore selected paths/patches to the recorded boundary",
      "run review/tests and record the human-approved outcome separately",
    ],
  };
}
