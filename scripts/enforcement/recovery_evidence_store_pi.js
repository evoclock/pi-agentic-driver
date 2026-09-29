// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Owner-local, non-authorizing recovery evidence. Nothing in the journey calls
// this module yet. The host chooses a private root; the store never chooses an
// implicit repository or app-data path and never evicts evidence on its own.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { appendTerminalResult, nudgeCanonicalJsonString, validateLedgerEntry } from "./nudge_ledger_pi.js";

export const RECOVERY_EVIDENCE_SCHEMA = "agentic-driver.recovery-evidence.v1";
const FILE = "recovery-evidence.v1.sqlite";
const SHA256 = /^[a-f0-9]{64}$/;

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function positiveBound(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw refuse("invalid-bound", `${name} must be a positive safe integer`);
  return value;
}

function privateRoot(root, create) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) {
    throw refuse("invalid-root", "a canonical absolute owner-provided root is required");
  }
  if (create && !existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || realpathSync(root) !== root) {
    throw refuse("untrusted-root", "evidence root must be a private, non-symlink directory");
  }
  return root;
}

function evidenceFile(root, create) {
  const path = join(root, FILE);
  if (create && !existsSync(path)) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path) {
    throw refuse("untrusted-file", "evidence file must be private and not a symlink");
  }
  return path;
}

/** Explicit host root; readOnly observation never creates a directory or file. */
export function openRecoveryEvidenceStore({ root, readOnly = false, maxRecordBytes = 128 * 1024, maxTotalBytes = 16 * 1024 * 1024, maxRecords = 1000 } = {}) {
  positiveBound(maxRecordBytes, "maxRecordBytes");
  positiveBound(maxTotalBytes, "maxTotalBytes");
  positiveBound(maxRecords, "maxRecords");
  const path = evidenceFile(privateRoot(root, !readOnly), !readOnly);
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    if (!readOnly) db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        journey_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('requested','terminal')),
        body TEXT NOT NULL, digest TEXT NOT NULL, previous_digest TEXT,
        bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (journey_id, entry_id, phase)
      );
    `);
  } catch (error) { db.close(); throw error; }
  return { db, path, readOnly, maxRecordBytes, maxTotalBytes, maxRecords };
}

export function closeRecoveryEvidenceStore(store) {
  store.db.close();
}

function digest(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }

function reference(row) {
  return Object.freeze({ schema: RECOVERY_EVIDENCE_SCHEMA, journeyId: row.journey_id,
    entryId: row.entry_id, phase: row.phase, sha256: row.digest, bytes: row.bytes });
}

function fetchRow(store, { journeyId, entryId, phase }) {
  return store.db.prepare("SELECT * FROM evidence WHERE journey_id=? AND entry_id=? AND phase=?")
    .get(journeyId, entryId, phase);
}

/** Bounded, read-only listing of closed retrieval references; never bodies. */
export function listRecoveryEvidenceReferences(store, { limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw refuse("invalid-bound", "limit must be a positive safe integer");
  return store.db.prepare(
    "SELECT journey_id, entry_id, phase, digest, bytes FROM evidence ORDER BY created_at DESC, journey_id, entry_id, phase LIMIT ?",
  ).all(limit).map((row) => reference(row));
}

/** Returns exact bytes only when the caller's reference and its predecessor verify. */
export function readRecoveryEvidence(store, ref) {
  if (!ref || ref.schema !== RECOVERY_EVIDENCE_SCHEMA || !["requested", "terminal"].includes(ref.phase)
    || typeof ref.journeyId !== "string" || !ref.journeyId || typeof ref.entryId !== "string" || !ref.entryId
    || !SHA256.test(ref.sha256 ?? "") || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1) {
    throw refuse("invalid-reference", "a complete evidence reference is required");
  }
  const row = fetchRow(store, ref);
  if (!row) throw refuse("evidence-missing", "referenced recovery evidence is unavailable");
  if (row.digest !== ref.sha256 || row.bytes !== ref.bytes || digest(row.body) !== row.digest
    || Buffer.byteLength(row.body, "utf8") !== row.bytes) {
    throw refuse("evidence-corrupt", "recovery evidence digest or size mismatch");
  }
  let entry;
  try { entry = JSON.parse(row.body); } catch { throw refuse("evidence-corrupt", "recovery evidence is not valid JSON"); }
  if (entry.journeyId !== ref.journeyId || entry.entryId !== ref.entryId || !validateLedgerEntry(entry).ok
    || (ref.phase === "requested" && entry.result !== "requested")
    || (ref.phase === "terminal" && entry.result === "requested")) {
    throw refuse("evidence-corrupt", "recovery evidence does not match its identity and phase");
  }
  if (ref.phase === "terminal") {
    const parent = fetchRow(store, { ...ref, phase: "requested" });
    if (!parent || row.previous_digest !== parent.digest || digest(parent.body) !== parent.digest) {
      throw refuse("evidence-corrupt", "terminal evidence has no intact requested predecessor");
    }
  }
  return { reference: reference(row), entry };
}

function append(store, entry, phase, previousDigest = null) {
  if (store.readOnly) throw refuse("read-only", "evidence store is read-only");
  const body = nudgeCanonicalJsonString(entry);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > store.maxRecordBytes) throw refuse("evidence-too-large", "recovery record exceeds per-record bound");
  store.db.exec("BEGIN IMMEDIATE;");
  try {
    const usage = store.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM evidence").get();
    if (usage.count >= store.maxRecords || usage.bytes + bytes > store.maxTotalBytes) {
      throw refuse("evidence-capacity", "owner review or increased capacity is required; unreviewed evidence is never evicted");
    }
    store.db.prepare("INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?)").run(
      entry.journeyId, entry.entryId, phase, body, digest(body), previousDigest, bytes, new Date().toISOString());
    store.db.exec("COMMIT;");
  } catch (error) {
    store.db.exec("ROLLBACK;");
    if (String(error.message).startsWith("UNIQUE constraint failed: evidence.")) {
      throw refuse("evidence-duplicate", "recovery phase already recorded");
    }
    throw error;
  }
  return reference({ journey_id: entry.journeyId, entry_id: entry.entryId, phase, digest: digest(body), bytes });
}

/** Must succeed before the caller attempts any nudge or replacement. */
export function recordRecoveryRequest(store, entry) {
  const valid = validateLedgerEntry(entry);
  if (!valid.ok || entry.result !== "requested") throw refuse("invalid-entry", "a valid requested ledger entry is required");
  return append(store, entry, "requested");
}

/** A failed post-action write is ambiguous; callers must retain their identity lock. */
export function recordRecoveryResult(store, requestedRef, terminal) {
  if (!requestedRef || requestedRef.phase !== "requested") throw refuse("invalid-reference", "requested evidence reference required");
  const requested = readRecoveryEvidence(store, requestedRef);
  if (fetchRow(store, { ...requestedRef, phase: "terminal" })) {
    throw refuse("evidence-duplicate", "terminal evidence already recorded; never replay an action");
  }
  const [entry] = appendTerminalResult([requested.entry], requested.entry.entryId, terminal);
  return append(store, entry, "terminal", requestedRef.sha256);
}
