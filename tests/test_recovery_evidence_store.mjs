import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openRecoveryEvidenceStore, closeRecoveryEvidenceStore,
  recordRecoveryRequest, recordRecoveryResult, readRecoveryEvidence,
} from "../scripts/enforcement/recovery_evidence_store_pi.js";
import { nudgeCanonicalJsonString } from "../scripts/enforcement/nudge_ledger_pi.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const auth = {
  dispatchId: "dispatch-1", source: "direct",
  authorityProvenance: { kind: "direct-instruction", reference: "dispatch-1", capturedAt: "2026-09-21T10:00:00.000Z" },
  authorityMaterial: "implement the module", authorityDigest: hash("implement the module"),
  authorizedAt: "2026-09-21T10:00:00.000Z", repositoryScope: "pi-agentic-driver",
  containmentProfile: "testudo-microvm-default", operationClasses: ["repository-read", "worktree-edit"],
};
auth.scopeDigest = hash(nudgeCanonicalJsonString({ operationClasses: [...auth.operationClasses].sort(), containmentProfile: auth.containmentProfile, repositoryScope: auth.repositoryScope }));

function entry(overrides = {}) {
  const messageText = "[NUDGE] please report status";
  return {
    ledgerVersion: 1, entryId: "nudge-j1-1-0-1", journeyId: "j1", timestamp: "2026-09-21T10:05:00.000Z",
    action: "nudge", role: "implementer", journeyStep: 1, attemptOrdinal: 0, repository: "/repo",
    dispatchAuthorization: auth, autonomy: "autonomous", containmentProfile: "testudo-microvm-default",
    operationClasses: ["repository-read", "worktree-edit"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 7 },
    messageText, messageSha256: hash(messageText), messageBytes: Buffer.byteLength(messageText),
    result: "requested", preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
    ...overrides,
  };
}

function fixture(t) {
  const scratch = mkdtempSync(join(process.cwd(), ".scratch-recovery-evidence-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  return { scratch, root: join(scratch, "owner-private") };
}

test("requested and terminal are immutable, digest-linked, retrievable across restart", (t) => {
  const { root } = fixture(t);
  let store = openRecoveryEvidenceStore({ root });
  const requested = recordRecoveryRequest(store, entry());
  assert.equal(requested.sha256.length, 64);
  assert.equal(readRecoveryEvidence(store, requested).entry.result, "requested");
  assert.throws(() => recordRecoveryRequest(store, entry()), /already recorded/);
  const terminal = recordRecoveryResult(store, requested, { result: "rejected", deliveryState: "rejected-before-delivery" });
  assert.equal(readRecoveryEvidence(store, terminal).entry.result, "rejected");
  assert.throws(() => recordRecoveryResult(store, requested, { result: "rejected" }), /already recorded/);
  closeRecoveryEvidenceStore(store);
  store = openRecoveryEvidenceStore({ root, readOnly: true });
  assert.equal(readRecoveryEvidence(store, terminal).entry.messageText, entry().messageText);
  assert.throws(() => recordRecoveryRequest(store, entry({ entryId: "new" })), /read-only/);
  closeRecoveryEvidenceStore(store);
});

test("tampered reference, body and predecessor fail closed", (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root });
  const requested = recordRecoveryRequest(store, entry());
  const terminal = recordRecoveryResult(store, requested, { result: "rejected", deliveryState: "rejected-before-delivery" });
  assert.throws(() => readRecoveryEvidence(store, { ...terminal, sha256: "f".repeat(64) }), /mismatch/);
  store.db.prepare("UPDATE evidence SET previous_digest=? WHERE phase='terminal'").run("f".repeat(64));
  assert.throws(() => readRecoveryEvidence(store, terminal), /predecessor/);
  store.db.prepare("UPDATE evidence SET body=? WHERE phase='requested'").run("{}");
  assert.throws(() => readRecoveryEvidence(store, terminal), /predecessor/);
  assert.throws(() => readRecoveryEvidence(store, requested), /mismatch/);
  closeRecoveryEvidenceStore(store);
});

test("capacity and invalid entries stop before action, without eviction", (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root, maxRecords: 1 });
  assert.throws(() => recordRecoveryRequest(store, entry({ messageText: "invalid" })), /valid requested/);
  const requested = recordRecoveryRequest(store, entry());
  assert.throws(() => recordRecoveryResult(store, requested, { result: "rejected", deliveryState: "rejected-before-delivery" }), /owner review or increased capacity/);
  assert.equal(readRecoveryEvidence(store, requested).entry.result, "requested");
  closeRecoveryEvidenceStore(store);
  const small = openRecoveryEvidenceStore({ root: join(root, "smaller"), maxRecordBytes: 1 });
  assert.throws(() => recordRecoveryRequest(small, entry()), /per-record bound/);
  closeRecoveryEvidenceStore(small);
});

test("two handles enforce one transaction-wide quota without overwriting evidence", (t) => {
  const { root } = fixture(t);
  const a = openRecoveryEvidenceStore({ root, maxRecords: 1 });
  const b = openRecoveryEvidenceStore({ root, maxRecords: 1 });
  const ref = recordRecoveryRequest(a, entry());
  assert.throws(() => recordRecoveryRequest(b, entry({ entryId: "second" })), /owner review or increased capacity/);
  assert.equal(readRecoveryEvidence(b, ref).entry.entryId, ref.entryId);
  closeRecoveryEvidenceStore(a);
  closeRecoveryEvidenceStore(b);
});

test("private root and DB are required; observation never creates storage", (t) => {
  const { scratch, root } = fixture(t);
  assert.throws(() => openRecoveryEvidenceStore({ root, readOnly: true }), /ENOENT/);
  assert.equal(existsSync(root), false);
  const store = openRecoveryEvidenceStore({ root });
  const dbPath = store.path;
  assert.equal(statSync(root).mode & 0o077, 0);
  assert.equal(statSync(dbPath).mode & 0o077, 0);
  closeRecoveryEvidenceStore(store);
  chmodSync(root, 0o755);
  assert.throws(() => openRecoveryEvidenceStore({ root }), /private/);
  chmodSync(root, 0o700);
  const alias = join(scratch, "alias");
  symlinkSync(root, alias);
  assert.throws(() => openRecoveryEvidenceStore({ root: alias }), /non-symlink/);
  const db = new DatabaseSync(dbPath);
  db.close();
  assert.throws(() => openRecoveryEvidenceStore({ root, maxTotalBytes: 0 }), /positive safe integer/);
});
