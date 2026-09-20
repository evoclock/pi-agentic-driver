// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Router operational state (ROUTER_DESIGN_TASK68 §8): local-first SQLite at
// ~/.local/share/agentic-driver/router/state.db (configurable). Stores
// collector snapshots, consumption samples, quantity-bearing reservations,
// route decisions, and ranking observations.
//
// GOVERNANCE BOUNDARY: this store is operational state ONLY. The
// authenticated claims file and the board writer remain the ONLY dispatch
// authority; SQLite is repaired from them, never the reverse. SQLite
// operations never hold the board writer lock, and vice versa — callers
// invoke this module outside any writer lock.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const RESERVATION_STATES = Object.freeze([
  "reserved", "claimed", "consumed", "released", "expired",
]);

// Default TTL for unclaimed (reserved) reservations: 15 minutes. Claimed
// reservations never TTL-expire — lease renewal governs them.
export const RESERVED_TTL_SECONDS = 900;

export function encodeReservationIdentity({ decisionId, seatId, accountId, vectors }) {
  return `res.${Buffer.from(JSON.stringify({ decisionId, seatId, accountId, vectors }), "utf8").toString("base64url")}`;
}

export function decodeReservationIdentity(id) {
  if (typeof id !== "string" || !id.startsWith("res.")) return null;
  try { return JSON.parse(Buffer.from(id.slice(4), "base64url").toString("utf8")); } catch { return null; }
}

function defaultDbPath() {
  return join(homedir(), ".local", "share", "agentic-driver", "router", "state.db");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quota_observations (
  collector TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source_status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (collector, seat_id, generation)
);
CREATE TABLE IF NOT EXISTS consumption_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity REAL NOT NULL,
  claim_id TEXT,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_seat_unit ON consumption_samples (seat_id, unit, captured_at);
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  vectors_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  lease_expires_at TEXT,
  claim_id TEXT,
  envelope_id TEXT,
  ttl_seconds INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_account ON reservations (account_id);
CREATE INDEX IF NOT EXISTS idx_reservations_state ON reservations (state);
CREATE TABLE IF NOT EXISTS route_decisions (
  decision_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  digest TEXT NOT NULL,
  selected_seat_id TEXT NOT NULL,
  parent_decision_id TEXT,
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ranking_observations (
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail_json TEXT,
  PRIMARY KEY (request_id, created_at)
);
`;

export function resolveRouterDbPath({ dbPath = null } = {}) {
  return dbPath ?? defaultDbPath();
}

export function routerDbExists({ dbPath = null } = {}) {
  return existsSync(resolveRouterDbPath({ dbPath }));
}

export function openRouterStore({ dbPath = null, readOnly = false } = {}) {
  // Runtime requirement (W6): the store depends on the built-in node:sqlite
  // module. Declared in package.json engines; fail with a clear reason when
  // the module is absent rather than a deep TypeError.
  if (typeof DatabaseSync !== "function") {
    throw new Error("router store requires Node.js >= 22.5 with the built-in node:sqlite module");
  }
  const path = resolveRouterDbPath({ dbPath });
  if (readOnly) {
    // Pure observation (W4): never create or migrate a store during check.
    // A missing store is empty operational state, not an error.
    if (!existsSync(path)) return { db: null, path, readOnly: true, closed: false, missing: true };
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return { db, path, readOnly: true, closed: false, missing: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
  return { db, path, readOnly: false, closed: false, missing: false };
}

export function closeRouterStore(store) {
  if (store === null || typeof store !== "object") return;
  try { store.db?.close(); } catch { /* already closed */ }
  store.closed = true;
}

// ---------------------------------------------------------------------------
// Quota observations (§4): keyed by (collector, seatId, generation).
// ---------------------------------------------------------------------------

export function insertQuotaObservation(store, observation) {
  const max = store.db.prepare("SELECT MAX(generation) AS generation FROM quota_observations WHERE collector = ? AND seat_id = ?")
    .get(observation.collector, observation.seatId)?.generation;
  if (Number.isInteger(max) && observation.generation < max) {
    return { ok: false, stale: true, reason: `generation rollback ${observation.generation} < ${max}` };
  }
  store.db.prepare(`
    INSERT INTO quota_observations (collector, seat_id, generation, captured_at, expires_at, source_status, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (collector, seat_id, generation) DO UPDATE SET
      captured_at = excluded.captured_at, expires_at = excluded.expires_at,
      source_status = excluded.source_status, record_json = excluded.record_json
  `).run(
    observation.collector, observation.seatId, observation.generation,
    observation.capturedAt, observation.expiresAt, observation.sourceStatus,
    JSON.stringify(observation),
  );
  return { ok: true, generation: observation.generation };
}

// Latest generation per (collector, seatId). Rollback protection: a lower
// generation than the highest stored one is treated as stale by the reader.
export function latestQuotaObservations(store, { now = null } = {}) {
  const rows = store.db.prepare(`
    SELECT record_json FROM quota_observations q
    WHERE generation = (
      SELECT MAX(generation) FROM quota_observations q2
      WHERE q2.collector = q.collector AND q2.seat_id = q.seat_id
    )
  `).all();
  return rows
    .map((row) => { try { return JSON.parse(row.record_json); } catch { return null; } })
    .filter((obs) => obs !== null);
}

// ---------------------------------------------------------------------------
// Consumption samples (§6.2 estimator feed): ingested from receipts at
// dispatch completion.
// ---------------------------------------------------------------------------

export function insertConsumptionSample(store, { seatId, unit, quantity, claimId = null, capturedAt }) {
  store.db.prepare(`
    INSERT INTO consumption_samples (seat_id, unit, quantity, claim_id, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(seatId, unit, quantity, claimId, capturedAt);
}

export function consumptionSamples(store, { seatId = null, unit = null, limit = null } = {}) {
  const clauses = [];
  const params = [];
  if (seatId !== null) { clauses.push("seat_id = ?"); params.push(seatId); }
  if (unit !== null) { clauses.push("unit = ?"); params.push(unit); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT seat_id AS seatId, unit, quantity, claim_id AS claimId, captured_at AS capturedAt
    FROM consumption_samples ${where} ORDER BY captured_at ASC, id ASC${limit !== null ? ` LIMIT ${Number(limit)}` : ""}`;
  return store.db.prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// Reservations (§6.2/§8): quantity-bearing, lifecycle
// reserved → claimed → consumed | released | expired.
// ---------------------------------------------------------------------------

export function createReservation(store, { reservationId = null, decisionId, seatId, accountId, vectors, now, ttlSeconds = RESERVED_TTL_SECONDS }) {
  if (!Array.isArray(vectors) || vectors.length === 0) throw new Error("reservation vectors are required");
  for (const vector of vectors) {
    if (typeof vector.windowId !== "string" || vector.windowId === "" || typeof vector.unit !== "string" || !Number.isFinite(vector.quantity) || vector.quantity < 0) {
      throw new Error("each reservation vector requires windowId, unit, and non-negative quantity");
    }
  }
  const id = reservationId ?? randomUUID();
  store.db.prepare(`
    INSERT INTO reservations (reservation_id, decision_id, seat_id, account_id, vectors_json, state, created_at, ttl_seconds)
    VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)
  `).run(id, decisionId, seatId, accountId, JSON.stringify(vectors), now, ttlSeconds);
  return id;
}

export function getReservation(store, reservationId) {
  const row = store.db.prepare("SELECT * FROM reservations WHERE reservation_id = ?").get(reservationId);
  if (row === undefined) return null;
  return {
    reservationId: row.reservation_id,
    decisionId: row.decision_id,
    seatId: row.seat_id,
    accountId: row.account_id,
    vectors: JSON.parse(row.vectors_json),
    state: row.state,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    claimId: row.claim_id,
    envelopeId: row.envelope_id,
    ttlSeconds: row.ttl_seconds,
  };
}

export function reservationsForDecision(store, decisionId) {
  return store.db.prepare(
    "SELECT reservation_id AS reservationId, state, vectors_json AS vectorsJson, account_id AS accountId, seat_id AS seatId FROM reservations WHERE decision_id = ?",
  ).all(decisionId).map((row) => ({ ...row, vectors: JSON.parse(row.vectorsJson) }));
}

export function activeReservations(store, { now }) {
  return store.db.prepare(`
    SELECT reservation_id AS reservationId, decision_id AS decisionId, seat_id AS seatId,
           account_id AS accountId, vectors_json AS vectorsJson, state,
           created_at AS createdAt, claimed_at AS claimedAt, lease_expires_at AS leaseExpiresAt,
           claim_id AS claimId, envelope_id AS envelopeId, ttl_seconds AS ttlSeconds
    FROM reservations WHERE state IN ('reserved', 'claimed')
  `).all().flatMap((row) => JSON.parse(row.vectorsJson).map((vector) => ({ ...row, ...vector })));
}

// Transition helpers. All idempotent where the design requires it.

// reserved → claimed, with lease. Non-reserved state is a no-op returning
// {ok: false, state} so a crash-window reconciliation can decide.
export function claimReservation(store, { reservationId, claimId, envelopeId, now, leaseSeconds = 3600 }) {
  const current = getReservation(store, reservationId);
  if (current === null) return { ok: false, state: null, reason: "reservation does not exist" };
  if (current.state === "claimed") {
    if (current.claimId !== claimId || current.envelopeId !== envelopeId) {
      return { ok: false, state: "claimed", reason: "reservation is bound to a different claim/envelope" };
    }
    store.db.prepare("UPDATE reservations SET lease_expires_at = ? WHERE reservation_id = ?")
      .run(leaseExpiry(now, leaseSeconds), reservationId);
    return { ok: true, state: "claimed", renewed: true };
  }
  if (current.state !== "reserved") {
    return { ok: false, state: current.state, reason: `reservation is ${current.state}, not reserved` };
  }
  store.db.prepare(`
    UPDATE reservations SET state = 'claimed', claimed_at = ?, lease_expires_at = ?, claim_id = ?, envelope_id = ?
    WHERE reservation_id = ? AND state = 'reserved'
  `).run(now, leaseExpiry(now, leaseSeconds), claimId ?? null, envelopeId ?? null, reservationId);
  return { ok: true, state: "claimed", renewed: false };
}

// Lease renewal on claimed reservations (§8): the dispatch loop heartbeat.
// TTL expiry never applies to claimed reservations — renewal only extends.
export function renewReservationLease(store, { reservationId, now, leaseSeconds = 3600 }) {
  const current = getReservation(store, reservationId);
  if (current === null || current.state !== "claimed") {
    return { ok: false, reason: "reservation is not claimed" };
  }
  store.db.prepare("UPDATE reservations SET lease_expires_at = ? WHERE reservation_id = ? AND state = 'claimed'")
    .run(leaseExpiry(now, leaseSeconds), reservationId);
  return { ok: true };
}

function leaseExpiry(now, leaseSeconds) {
  return new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
}

// claimed → consumed. Idempotent: consuming an already-consumed reservation
// succeeds without effect; duplicates are prevented by the claim, not the
// reservation (§8).
export function consumeReservation(store, { reservationId, now }) {
  const current = getReservation(store, reservationId);
  if (current === null) return { ok: false, reason: "reservation does not exist" };
  if (current.state === "consumed") return { ok: true, state: "consumed", idempotent: true };
  if (current.state !== "claimed") {
    return { ok: false, reason: `reservation is ${current.state}, not claimed` };
  }
  store.db.prepare("UPDATE reservations SET state = 'consumed' WHERE reservation_id = ? AND state = 'claimed'")
    .run(reservationId);
  return { ok: true, state: "consumed", idempotent: false };
}

// reserved|claimed → released. Idempotent.
export function releaseReservation(store, { reservationId, now }) {
  const current = getReservation(store, reservationId);
  if (current === null) return { ok: false, reason: "reservation does not exist" };
  if (current.state === "released") return { ok: true, state: "released", idempotent: true };
  if (current.state !== "reserved" && current.state !== "claimed") {
    return { ok: false, reason: `reservation is ${current.state}; cannot release` };
  }
  store.db.prepare("UPDATE reservations SET state = 'released' WHERE reservation_id = ? AND state IN ('reserved', 'claimed')")
    .run(reservationId);
  return { ok: true, state: "released", idempotent: false };
}

// TTL expiry applies ONLY to reserved (unclaimed) reservations (§8). Claimed
// reservations are governed by lease renewal, never TTL.
export function expireStaleReservations(store, { now }) {
  const result = store.db.prepare(`
    UPDATE reservations SET state = 'expired'
    WHERE state = 'reserved'
      AND (CAST(strftime('%s', created_at) AS INTEGER) + ttl_seconds) * 1000 <= ?
  `).run(Date.parse(now));
  return { expired: result.changes };
}

// ---------------------------------------------------------------------------
// Crash-window reconciliation (§8). The claims/envelope is AUTHORITY; SQLite
// is repaired from it. The caller supplies the authenticated claim (with its
// envelope) read from the claims file — this module never reads the board.
// ---------------------------------------------------------------------------

// Window 2+3: a claim exists in the authenticated claims file carrying a
// reservationId inside its envelope, but the reservation row is missing,
// still 'reserved', or expired. Re-materialize/repair from the envelope.
export function reconcileReservationFromClaim(store, { claim, now, leaseSeconds = 3600 }) {
  const envelope = claim?.envelope;
  const reservationId = typeof envelope?.reservationId === "string" ? envelope.reservationId : null;
  if (reservationId === null) return { ok: true, repaired: false, reason: null };
  const current = getReservation(store, reservationId);
  if (current !== null && current.state === "claimed"
    && current.claimId === claim.envelopeId) {
    return { ok: true, repaired: false, reason: null }; // already consistent
  }
  if (current === null) {
    const carried = decodeReservationIdentity(reservationId);
    if (!carried || carried.seatId !== envelope.seatId || carried.accountId !== envelope.accountId
      || !Array.isArray(carried.vectors) || carried.vectors.length === 0) {
      return { ok: false, repaired: false, reason: "reservation identity lacks authenticated reconstruction data (fails closed)" };
    }
    store.db.prepare(`
      INSERT INTO reservations (reservation_id, decision_id, seat_id, account_id, vectors_json, state, created_at, claimed_at, lease_expires_at, claim_id, envelope_id, ttl_seconds)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?)
    `).run(reservationId, carried.decisionId, carried.seatId, carried.accountId,
      JSON.stringify(carried.vectors), now, now, leaseExpiry(now, leaseSeconds),
      claim.envelopeId, envelope.envelopeId, 0);
    return { ok: true, repaired: true, reason: "re-materialized from authenticated reservation identity" };
  }
  // Window 3: reservation expired (or still reserved) while the claim is
  // active — the claim is authoritative; re-materialize as claimed.
  store.db.prepare(`
    UPDATE reservations SET state = 'claimed', claimed_at = ?, lease_expires_at = ?, claim_id = ?, envelope_id = ?
    WHERE reservation_id = ?
  `).run(now, leaseExpiry(now, leaseSeconds), claim.envelopeId, envelope.envelopeId, reservationId);
  return { ok: true, repaired: true, reason: "re-materialized from authenticated claim (crash window 3)" };
}

// Window 4: reclaim while spawn ambiguous — the existing reconciliation
// resolves spawn state first; the reservation follows the claim. When the
// claim was consumed with a terminal reason, the reservation follows.
export function followClaimConsumption(store, { envelopeId, reason, now }) {
  const rows = store.db.prepare("SELECT reservation_id, state FROM reservations WHERE envelope_id = ? AND state IN ('reserved', 'claimed')").all(envelopeId);
  const followed = [];
  for (const row of rows) {
    const target = reason === "completed" ? "consumed" : "released";
    store.db.prepare("UPDATE reservations SET state = ? WHERE reservation_id = ?").run(target, row.reservation_id);
    followed.push({ reservationId: row.reservation_id, state: target });
  }
  return { followed };
}

// ---------------------------------------------------------------------------
// Route decisions and ranking observations (audit).
// ---------------------------------------------------------------------------

export function insertRouteDecision(store, { record, digest }) {
  store.db.prepare(`
    INSERT INTO route_decisions (decision_id, created_at, card_hash, digest, selected_seat_id, parent_decision_id, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (decision_id) DO UPDATE SET digest = excluded.digest, record_json = excluded.record_json
  `).run(record.decisionId, record.createdAt, record.cardHash, digest, record.selectedSeatId, record.parentDecisionId, JSON.stringify(record));
}

export function getRouteDecision(store, decisionId) {
  const row = store.db.prepare("SELECT record_json FROM route_decisions WHERE decision_id = ?").get(decisionId);
  if (row === undefined) return null;
  try { return JSON.parse(row.record_json); } catch { return null; }
}

// A route-decision digest is the SHA-256 of the immutable record, which
// includes its own decisionId, so a digest maps to exactly one decision.
// The writer uses this to require that a replacement's parentDecisionId is
// the decision authenticated for the prior envelope, retrieved from the
// store (never trusting a caller-supplied parent id).
export function getRouteDecisionIdByDigest(store, digest) {
  if (store === null || store.db === null || typeof digest !== "string") return null;
  const row = store.db.prepare("SELECT decision_id AS decisionId FROM route_decisions WHERE digest = ?").get(digest);
  return row?.decisionId ?? null;
}

export function insertRankingObservation(store, { requestId, createdAt, candidateDigest, outcome, detail = null }) {
  store.db.prepare(`
    INSERT INTO ranking_observations (request_id, created_at, candidate_digest, outcome, detail_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (request_id, created_at) DO UPDATE SET outcome = excluded.outcome, detail_json = excluded.detail_json
  `).run(requestId, createdAt, candidateDigest, outcome, detail === null ? null : JSON.stringify(detail));
}

// ---------------------------------------------------------------------------
// Corruption handling (§10): corruption/unavailable fails closed for NEW
// reservations only; existing claims are unaffected (the claims file is
// authority). openRouterStore throws on an unreadable/corrupt file; callers
// catch and apply the failure policy.
// ---------------------------------------------------------------------------

export function storeHealthy(store) {
  try {
    store.db.prepare("SELECT COUNT(*) AS n FROM reservations").get();
    return true;
  } catch {
    return false;
  }
}
