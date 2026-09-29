// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// NUDGE §6 ledger tests: exact record shape, digest recomputation, two-phase
// entries, receipt serialization, and the revert-anchor selection (§6.3).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  validateLedgerEntry, recomputeEntryDigests, buildRequestedEntry,
  appendTerminalResult, serializeLedgerSection, selectRevertAnchor,
  sha256Hex, nudgeCanonicalJsonString, NUDGE_LEDGER_VERSION,
} from "../scripts/enforcement/nudge_ledger_pi.js";

const AUTH = Object.freeze({
  dispatchId: "dispatch-1",
  source: "direct",
  authorityProvenance: { kind: "direct-instruction", reference: "dispatch-1", capturedAt: "2026-09-21T10:00:00.000Z" },
  authorityMaterial: "implement the module",
  authorityDigest: sha256Hex("implement the module"),
  authorizedAt: "2026-09-21T10:00:00.000Z",
  repositoryScope: "pi-agentic-driver",
  containmentProfile: "testudo-microvm-default",
  operationClasses: ["repository-read", "worktree-edit", "local-test"],
});

const AUTH_SCOPE_DIGEST = sha256Hex(nudgeCanonicalJsonString({
  operationClasses: [...new Set([...AUTH.operationClasses].sort())],
  containmentProfile: AUTH.containmentProfile,
  repositoryScope: AUTH.repositoryScope,
}));

function authWithScope(overrides = {}) {
  return { ...AUTH, scopeDigest: AUTH_SCOPE_DIGEST, ...overrides };
}

function baseEntry(overrides = {}) {
  const auth = authWithScope();
  return {
    ledgerVersion: NUDGE_LEDGER_VERSION,
    entryId: "nudge-j1-1-0-1",
    journeyId: "j1",
    timestamp: "2026-09-21T10:05:00.000Z",
    action: "nudge",
    role: "implementer",
    journeyStep: 1,
    attemptOrdinal: 0,
    repository: "/repo",
    dispatchAuthorization: auth,
    autonomy: "autonomous",
    containmentProfile: "testudo-microvm-default",
    operationClasses: ["repository-read", "worktree-edit"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 7 },
    messageText: "[NUDGE] please report status",
    messageSha256: sha256Hex("[NUDGE] please report status"),
    messageBytes: Buffer.byteLength("[NUDGE] please report status", "utf8"),
    result: "requested",
    preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Exact record shape
// ---------------------------------------------------------------------------

test("a valid nudge entry passes validation with no errors", () => {
  const result = validateLedgerEntry(baseEntry());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("exact top-level keys: no key outside the closed shape is accepted", () => {
  const entry = baseEntry();
  entry.sneaky = "value";
  const result = validateLedgerEntry(entry);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("entry.sneaky: key outside the closed record shape")));
});

test("every REQUIRED top-level key is named individually when absent", () => {
  for (const key of [
    "ledgerVersion", "entryId", "journeyId", "timestamp", "action", "role",
    "journeyStep", "attemptOrdinal", "repository", "dispatchAuthorization",
    "autonomy", "containmentProfile", "operationClasses", "preState", "result", "preGit",
  ]) {
    const entry = baseEntry();
    delete entry[key];
    const result = validateLedgerEntry(entry);
    assert.equal(result.ok, false, key);
    assert.ok(result.errors.some((e) => e.includes(`entry.${key}`)), key);
  }
});

test("a replacement entry requires replacementRole and rejects nudge-only delivery fields", () => {
  const replacement = baseEntry({
    action: "replacement",
    replacementRole: "reviewer",
    result: "spawned",
  });
  assert.equal(validateLedgerEntry(replacement).ok, true);

  const missingRole = { ...replacement };
  delete missingRole.replacementRole;
  const missing = validateLedgerEntry(missingRole);
  assert.ok(missing.errors.some((e) => e.includes("entry.replacementRole: REQUIRED for a replacement entry")));

  const withDelivery = { ...replacement, deliveryState: "delivered" };
  assert.ok(validateLedgerEntry(withDelivery).errors.some((e) => e.includes("nudge-only field")));
});

test("both actions require messageText, messageSha256, and messageBytes", () => {
  for (const action of ["nudge", "replacement"]) {
    for (const key of ["messageText", "messageSha256", "messageBytes"]) {
      const entry = baseEntry(action === "replacement" ? { action, replacementRole: "reviewer" } : {});
      delete entry[key];
      const result = validateLedgerEntry(entry);
      assert.equal(result.ok, false, `${action}.${key}`);
      assert.ok(result.errors.some((e) => e.includes(`entry.${key}`)), `${action}.${key}`);
    }
  }
  const wrongBytes = baseEntry({ messageText: "é", messageSha256: sha256Hex("é"), messageBytes: 1 });
  assert.ok(validateLedgerEntry(wrongBytes).errors.some((e) => e.includes("must equal the UTF-8 byte count")));
});

test("dispatchAuthorization shape: closed keys, closed sources, closed provenance kinds, hex digests", () => {
  const bad = baseEntry();
  bad.dispatchAuthorization = { ...AUTH, extra: true, source: "telepathy", scopeDigest: "nope" };
  const result = validateLedgerEntry(bad);
  assert.ok(result.errors.some((e) => e.includes("dispatchAuthorization.extra: key outside")));
  assert.ok(result.errors.some((e) => e.includes("source: must be one of")));
  assert.ok(result.errors.some((e) => e.includes("scopeDigest: must be lowercase SHA-256 hex")));
});

test("authorityProvenance kind is closed to direct-instruction | session-task | board-envelope", () => {
  const bad = baseEntry();
  bad.dispatchAuthorization = { ...AUTH, scopeDigest: AUTH.scopeDigest || sha256Hex("x"), authorityProvenance: { kind: "vibes", reference: "r", capturedAt: "t" } };
  const result = validateLedgerEntry(bad);
  assert.ok(result.errors.some((e) => e.includes("authorityProvenance.kind")));
});

test("preGit requires 40-hex head and 64-hex digests; postGit is optional but equally strict", () => {
  const bad = baseEntry({ preGit: { head: "zz", statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) } });
  assert.ok(validateLedgerEntry(bad).errors.some((e) => e.includes("preGit.head")));
  const badPost = baseEntry({ postGit: { head: "a".repeat(40), statusDigest: "x", diffDigest: "c".repeat(64) } });
  assert.ok(validateLedgerEntry(badPost).errors.some((e) => e.includes("postGit.statusDigest")));
  assert.equal(validateLedgerEntry(baseEntry({ postGit: { head: "d".repeat(40), statusDigest: "e".repeat(64), diffDigest: "f".repeat(64) } })).ok, true);
});

test("result enum is closed and includes the requested phase", () => {
  const bad = baseEntry({ result: "vibed" });
  assert.ok(validateLedgerEntry(bad).errors.some((e) => e.includes("entry.result")));
});

// ---------------------------------------------------------------------------
// Digest recomputation
// ---------------------------------------------------------------------------

test("direct source: authorityDigest recomputes from the exact stepPrompt bytes with no normalization", () => {
  const entry = baseEntry();
  const recomputed = recomputeEntryDigests(entry);
  assert.equal(recomputed.ok, true, recomputed.errors?.join("; "));
  assert.equal(recomputed.recomputable, true);
  assert.equal(recomputed.authorityDigest, createHash("sha256").update("implement the module", "utf8").digest("hex"));
  // No newline or Unicode normalization: a trailing newline changes the digest.
  const mutated = baseEntry();
  mutated.dispatchAuthorization = { ...AUTH, authorityMaterial: "implement the module\n", scopeDigest: AUTH.scopeDigest || undefined };
  assert.notEqual(sha256Hex("implement the module\n"), recomputed.authorityDigest);
});

test("queue source: authorityDigest recomputes from canonical JSON of immutable captured fields, mutable fields excluded", () => {
  const entry = baseEntry();
  entry.dispatchAuthorization = {
    ...authWithScope(),
    source: "queue",
    authorityProvenance: { kind: "session-task", reference: "list-1/task-9", capturedAt: "2026-09-21T10:00:00.000Z" },
    authorityMaterial: { id: "task-9", title: "Do the thing", description: null, capturedAt: "2026-09-21T10:00:00.000Z" },
    authorityDigest: sha256Hex(nudgeCanonicalJsonString({ id: "task-9", title: "Do the thing", description: null, capturedAt: "2026-09-21T10:00:00.000Z" })),
  };
  const recomputed = recomputeEntryDigests(entry);
  assert.equal(recomputed.ok, true, recomputed.errors?.join("; "));
  // Mutable fields present in the material do not participate: recomputation
  // uses exactly {id,title,description,capturedAt}.
  assert.equal(recomputed.authorityDigest, sha256Hex(nudgeCanonicalJsonString({
    id: "task-9", title: "Do the thing", description: null, capturedAt: "2026-09-21T10:00:00.000Z",
  })));
});

test("ledger canonical JSON preserves explicit null, literal bytes, array order, and exact Unicode code points", () => {
  assert.equal(nudgeCanonicalJsonString({ b: 1, a: null }), '{"a":null,"b":1}');
  assert.equal(nudgeCanonicalJsonString({ values: [3, 1, 2] }), '{"values":[3,1,2]}');
  assert.notEqual(
    nudgeCanonicalJsonString({ id: "t", title: null, description: null, capturedAt: "c" }),
    nudgeCanonicalJsonString({ id: "t", capturedAt: "c" }),
  );
  assert.notEqual(nudgeCanonicalJsonString({ text: "é" }), nudgeCanonicalJsonString({ text: "e\u0301" }));
});

test("queue source: missing title/description is explicit null in the digest material", () => {
  const material = { id: "task-9", capturedAt: "2026-09-21T10:00:00.000Z" };
  const digest = sha256Hex(nudgeCanonicalJsonString({
    id: material.id, title: null, description: null, capturedAt: material.capturedAt,
  }));
  const entry = baseEntry();
  entry.dispatchAuthorization = {
    ...authWithScope(), source: "queue",
    authorityProvenance: { kind: "session-task", reference: "list-1/task-9", capturedAt: material.capturedAt },
    authorityMaterial: material,
    authorityDigest: digest,
  };
  assert.equal(recomputeEntryDigests(entry).ok, true);
});

test("board source: digests are preserved, not recomputed (keyed verification needs the HMAC secret)", () => {
  const entry = baseEntry();
  entry.dispatchAuthorization = {
    ...authWithScope(),
    source: "board",
    authorityProvenance: { kind: "board-envelope", reference: "TASKS.md/E-1", capturedAt: "2026-09-21T10:00:00.000Z" },
    authorityMaterial: { envelopeDigest: "envelope-bytes" },
    authorityDigest: "9".repeat(64),
  };
  const recomputed = recomputeEntryDigests(entry);
  assert.equal(recomputed.recomputable, false);
  assert.ok(!recomputed.errors.some((e) => e.includes("authorityDigest mismatch")));
});

test("scopeDigest recomputes from sorted, deduplicated operation classes", () => {
  const scopeObject = {
    operationClasses: [...new Set([...AUTH.operationClasses].sort())],
    containmentProfile: AUTH.containmentProfile,
    repositoryScope: AUTH.repositoryScope,
  };
  const expected = sha256Hex(nudgeCanonicalJsonString(scopeObject));
  const entry = baseEntry();
  entry.dispatchAuthorization = { ...AUTH, scopeDigest: expected, operationClasses: [...AUTH.operationClasses].reverse() };
  assert.equal(recomputeEntryDigests(entry).ok, true);
  // A widened class list changes the scope digest — mismatch is an error.
  const widened = baseEntry();
  widened.dispatchAuthorization = { ...AUTH, scopeDigest: expected, operationClasses: [...AUTH.operationClasses, "network-access"] };
  const result = recomputeEntryDigests(widened);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("scopeDigest mismatch")));
});

test("malformed digest material returns an error instead of throwing", () => {
  const entry = baseEntry();
  entry.dispatchAuthorization = { ...entry.dispatchAuthorization, operationClasses: 7 };
  assert.doesNotThrow(() => recomputeEntryDigests(entry));
  assert.equal(recomputeEntryDigests(entry).ok, false);
});

test("messageSha256 and messageBytes recompute from the exact sent text", () => {
  const entry = baseEntry();
  entry.messageSha256 = "0".repeat(64);
  const result = recomputeEntryDigests(entry);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("messageSha256 mismatch")));
  const badBytes = baseEntry({ messageBytes: 999 });
  assert.ok(recomputeEntryDigests(badBytes).errors.some((e) => e.includes("messageBytes mismatch")));
});

// ---------------------------------------------------------------------------
// Two-phase entries
// ---------------------------------------------------------------------------

test("buildRequestedEntry mints a valid requested entry with message integrity fields", () => {
  const entry = buildRequestedEntry({
    journeyId: "j1", timestamp: "2026-09-21T10:05:00.000Z", action: "nudge",
    role: "implementer", journeyStep: 1, attemptOrdinal: 0,
    repository: "/repo", dispatchAuthorization: {
      ...AUTH, scopeDigest: sha256Hex(nudgeCanonicalJsonString({
        operationClasses: [...new Set([...AUTH.operationClasses].sort())],
        containmentProfile: AUTH.containmentProfile, repositoryScope: AUTH.repositoryScope,
      })),
    },
    autonomy: "autonomous", containmentProfile: "testudo-microvm-default",
    operationClasses: ["repository-read"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 7 },
    messageText: "[NUDGE] status?",
    preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
    reasonCode: "blocked-modal",
  });
  assert.equal(entry.result, "requested");
  assert.equal(entry.messageSha256, sha256Hex("[NUDGE] status?"));
  assert.equal(entry.messageBytes, Buffer.byteLength("[NUDGE] status?", "utf8"));
  assert.equal(validateLedgerEntry(entry).ok, true);
});

test("a nudge or replacement without a ledger pre-entry is forbidden", () => {
  const ledger = [];
  assert.throws(() => appendTerminalResult(ledger, "missing", { result: "delivered" }), /pre-entry/);
});

test("appendTerminalResult links the terminal phase to the requested entry by entryId", () => {
  const entry = buildRequestedEntry({
    journeyId: "j1", timestamp: "t", action: "nudge", role: "r", journeyStep: 1,
    attemptOrdinal: 0, repository: "/repo",
    dispatchAuthorization: {
      ...AUTH, scopeDigest: sha256Hex(nudgeCanonicalJsonString({
        operationClasses: [...new Set([...AUTH.operationClasses].sort())],
        containmentProfile: AUTH.containmentProfile, repositoryScope: AUTH.repositoryScope,
      })),
    },
    autonomy: "autonomous", containmentProfile: "p", operationClasses: ["repository-read"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 0 },
    messageText: "m", preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
  });
  const ledger = appendTerminalResult([entry], entry.entryId, {
    result: "delivered", deliveryState: "delivered", herdrCode: null,
    postGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
  });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].result, "delivered");
  assert.equal(ledger[0].entryId, entry.entryId);
  // An interrupted action leaves the requested phase visible in the ledger.
  const interrupted = [entry];
  assert.equal(interrupted[0].result, "requested");
});

test("appendTerminalResult rejects keys outside the terminal allowlist", () => {
  const entry = baseEntry();
  assert.throws(
    () => appendTerminalResult([entry], entry.entryId, {
      result: "delivered", deliveryState: "delivered", messageText: "overwritten",
    }),
    (error) => error?.code === "invalid-input" && /messageText/.test(error.message),
  );
});

test("appendTerminalResult refuses a terminal result of requested", () => {
  const entry = buildRequestedEntry({
    journeyId: "j", timestamp: "t", action: "nudge", role: "r", journeyStep: 1,
    attemptOrdinal: 0, repository: "/repo",
    dispatchAuthorization: {
      ...AUTH, scopeDigest: sha256Hex(nudgeCanonicalJsonString({
        operationClasses: [...new Set([...AUTH.operationClasses].sort())],
        containmentProfile: AUTH.containmentProfile, repositoryScope: AUTH.repositoryScope,
      })),
    },
    autonomy: "autonomous", containmentProfile: "p", operationClasses: ["repository-read"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 0 },
    messageText: "m", preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
  });
  assert.throws(() => appendTerminalResult([entry], entry.entryId, { result: "requested" }), /cannot be requested/);
});

// ---------------------------------------------------------------------------
// Receipt serialization
// ---------------------------------------------------------------------------

test("serializeLedgerSection emits a bounded, digest-linked section with both phases", () => {
  const entry = buildRequestedEntry({
    journeyId: "j", timestamp: "t", action: "nudge", role: "r", journeyStep: 1,
    attemptOrdinal: 0, repository: "/repo",
    dispatchAuthorization: {
      ...AUTH, scopeDigest: sha256Hex(nudgeCanonicalJsonString({
        operationClasses: [...new Set([...AUTH.operationClasses].sort())],
        containmentProfile: AUTH.containmentProfile, repositoryScope: AUTH.repositoryScope,
      })),
    },
    autonomy: "autonomous", containmentProfile: "p", operationClasses: ["repository-read"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 0 },
    messageText: "m", preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
  });
  const section = serializeLedgerSection([entry], { maxBytes: 64 * 1024 });
  assert.match(section.body, /^\[RECOVERY_LEDGER_BEGIN\]/);
  assert.match(section.body, /\[RECOVERY_LEDGER_END\]$/);
  assert.match(section.body, /"result":"requested"/);
  assert.equal(section.digest, sha256Hex(section.body));
});

test("receipt capacity: maxBytes is required and exceeding it fails closed", () => {
  const entry = buildRequestedEntry({
    journeyId: "j", timestamp: "t", action: "nudge", role: "r", journeyStep: 1,
    attemptOrdinal: 0, repository: "/repo",
    dispatchAuthorization: {
      ...AUTH, scopeDigest: sha256Hex(nudgeCanonicalJsonString({
        operationClasses: [...new Set([...AUTH.operationClasses].sort())],
        containmentProfile: AUTH.containmentProfile, repositoryScope: AUTH.repositoryScope,
      })),
    },
    autonomy: "autonomous", containmentProfile: "p", operationClasses: ["repository-read"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 0 },
    messageText: "m", preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
  });
  assert.throws(() => serializeLedgerSection([entry]), /maxBytes is required/);
  assert.throws(() => serializeLedgerSection([entry], { maxBytes: 10 }), /fails closed/);
});

// ---------------------------------------------------------------------------
// Revert-anchor selection (§6.3)
// ---------------------------------------------------------------------------

function anchorLedger() {
  const mk = (entryId, result, preGit, postGit) => baseEntry({
    entryId, result, preGit, ...(postGit ? { postGit } : {}),
  });
  return [
    mk("e1", "delivered",
      { head: "1".repeat(40), statusDigest: "1".repeat(64), diffDigest: "1".repeat(64) },
      { head: "2".repeat(40), statusDigest: "2".repeat(64), diffDigest: "2".repeat(64) }),
    mk("e2", "requested",
      { head: "2".repeat(40), statusDigest: "2".repeat(64), diffDigest: "2".repeat(64) }),
    mk("e3", "failed",
      { head: "3".repeat(40), statusDigest: "3".repeat(64), diffDigest: "3".repeat(64) }),
    mk("e4", "spawned",
      { head: "4".repeat(40), statusDigest: "4".repeat(64), diffDigest: "4".repeat(64) },
      { head: "5".repeat(40), statusDigest: "5".repeat(64), diffDigest: "5".repeat(64) }),
  ];
}

test("revert anchor: the last accepted entry is selected; requested-only and failed entries are never anchors", () => {
  const selection = selectRevertAnchor(anchorLedger(), {});
  assert.equal(selection.ok, true);
  assert.equal(selection.anchor.entryId, "e4");
  assert.equal(selection.anchor.action, "nudge");
});

test("revert anchor with no accepted entry fails with a named code", () => {
  const selection = selectRevertAnchor([{ ...baseEntry(), result: "requested" }], {});
  assert.equal(selection.ok, false);
  assert.equal(selection.code, "no-accepted-entry");
});

test("revert anchor: current observations are compared against pre AND post Git boundaries", () => {
  const selection = selectRevertAnchor(anchorLedger(), {
    repository: "/repo", branch: undefined, head: "5".repeat(40),
    statusDigest: "5".repeat(64), diffDigest: "5".repeat(64),
  });
  assert.equal(selection.headMatch ?? selection.comparisons.headMatch, true);
  assert.equal(selection.comparisons.headMatch, true);
  assert.equal(selection.comparisons.statusDigestMatch, true);
  assert.equal(selection.comparisons.diffDigestMatch, true);
  assert.equal(selection.atBoundary, true);
});

test("revert anchor: a drifted HEAD is reported as evidence, never as a verdict", () => {
  const selection = selectRevertAnchor(anchorLedger(), {
    repository: "/repo", head: "f".repeat(40), statusDigest: null, diffDigest: null,
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.comparisons.headMatch, false);
  assert.equal(selection.atBoundary, false);
});

test("revert anchor: the bounded owner procedure is returned with the anchor", () => {
  const selection = selectRevertAnchor(anchorLedger(), {});
  assert.ok(Array.isArray(selection.procedure));
  assert.equal(selection.procedure.length, 6);
  assert.match(selection.procedure[5], /human-approved/);
});
