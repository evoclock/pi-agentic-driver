// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Router store tests (ROUTER_DESIGN_TASK68 §8): SQLite operational state,
// the reservation lifecycle reserved → claimed → consumed|released|expired,
// lease renewal on claimed, TTL only on reserved, the four crash-window
// reconciliation rules, and idempotent release/consume. No network calls.

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRouterStore, closeRouterStore, createReservation, getReservation,
  claimReservation, consumeReservation, releaseReservation,
  renewReservationLease, expireStaleReservations,
  reconcileReservationFromClaim, followClaimConsumption,
  insertQuotaObservation, latestQuotaObservations,
  insertConsumptionSample, consumptionSamples,
  insertRouteDecision, getRouteDecision, insertRankingObservation,
  storeHealthy, RESERVATION_STATES, encodeReservationIdentity,
} from "../scripts/enforcement/router_store_pi.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "router-store-"));
  const store = openRouterStore({ dbPath: join(dir, "state.db") });
  return { store, dir };
}

const NOW = "2026-09-16T12:00:00Z";
const VECTORS = [
  { windowId: "messages-18h", unit: "messages", resetAt: "2026-09-16T18:00:00Z", quantity: 25, windowTotal: 100, windowRemaining: 70 },
  { windowId: "tokens-unbounded", unit: "tokens", resetAt: null, quantity: 1200, windowTotal: 10000, windowRemaining: 8000 },
];

test("reservation lifecycle: reserved → claimed → consumed", () => {
  const { store, dir } = freshStore();
  try {
    assert.deepEqual([...RESERVATION_STATES], ["reserved", "claimed", "consumed", "released", "expired"]);
    const reservationId = createReservation(store, { decisionId: "d1", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    assert.equal(typeof reservationId, "string"); // one row per window unit (quantity-bearing)
    const first = getReservation(store, reservationId);
    assert.equal(first.state, "reserved");
    assert.equal(first.vectors.length, 2);
    assert.equal(first.vectors[0].quantity, 25);
    assert.equal(first.vectors[0].windowId, "messages-18h");
    // reserved → claimed, with lease and the dual-store back-reference.
    const claim = claimReservation(store, { reservationId: reservationId, claimId: "claim-1", envelopeId: "env-1", now: NOW });
    assert.equal(claim.ok, true);
    const claimed = getReservation(store, reservationId);
    assert.equal(claimed.state, "claimed");
    assert.equal(claimed.claimId, "claim-1");
    assert.equal(claimed.envelopeId, "env-1");
    assert.ok(claimed.leaseExpiresAt > NOW);
    // claimed → consumed.
    assert.equal(consumeReservation(store, { reservationId: reservationId, now: NOW }).ok, true);
    assert.equal(getReservation(store, reservationId).state, "consumed");
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("consume and release are idempotent", () => {
  const { store, dir } = freshStore();
  try {
    const reservationId = createReservation(store, { decisionId: "d1", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    claimReservation(store, { reservationId: reservationId, claimId: "c", envelopeId: "e", now: NOW });
    const first = consumeReservation(store, { reservationId: reservationId, now: NOW });
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    const second = consumeReservation(store, { reservationId: reservationId, now: NOW });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    // Release from a terminal state is refused, not silently ok.
    assert.equal(releaseReservation(store, { reservationId: reservationId, now: NOW }).ok, false);
    const secondReservation = createReservation(store, { decisionId: "d2", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    claimReservation(store, { reservationId: secondReservation, claimId: "c2", envelopeId: "e2", now: NOW });
    assert.equal(releaseReservation(store, { reservationId: secondReservation, now: NOW }).ok, true);
    assert.equal(releaseReservation(store, { reservationId: secondReservation, now: NOW }).idempotent, true);
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("TTL expiry applies ONLY to reserved; claimed is governed by lease renewal", () => {
  const { store, dir } = freshStore();
  try {
    const reservationId = createReservation(store, {
      decisionId: "d1", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW, ttlSeconds: 60,
    });
    claimReservation(store, { reservationId: reservationId, claimId: "c", envelopeId: "e", now: NOW });
    const unclaimed = createReservation(store, { decisionId: "d2", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW, ttlSeconds: 60 });
    // Well past both the reserved TTL and a lapsed lease.
    const later = "2026-09-16T15:00:00Z";
    const result = expireStaleReservations(store, { now: later });
    // The reserved one expires; the claimed one does NOT (TTL never applies).
    assert.equal(result.expired, 1);
    assert.equal(getReservation(store, reservationId).state, "claimed");
    assert.equal(getReservation(store, unclaimed).state, "expired");
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("lease renewal extends claimed reservations and never expires them", () => {
  const { store, dir } = freshStore();
  try {
    const reservationId = createReservation(store, { decisionId: "d1", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    claimReservation(store, { reservationId: reservationId, claimId: "c", envelopeId: "e", now: NOW });
    const renewed = renewReservationLease(store, { reservationId: reservationId, now: "2026-09-16T12:30:00Z", leaseSeconds: 3600 });
    assert.equal(renewed.ok, true);
    const after = getReservation(store, reservationId);
    assert.equal(after.state, "claimed");
    assert.equal(Date.parse(after.leaseExpiresAt), Date.parse("2026-09-16T13:30:00Z"));
    const unclaimed = createReservation(store, { decisionId: "d2", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    assert.equal(renewReservationLease(store, { reservationId: unclaimed, now: NOW }).ok, false);
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("crash window 2: claim succeeded, back-reference lost — envelope is authority, SQLite repaired", () => {
  const { store, dir } = freshStore();
  try {
    // The reservation row was never written (crash before create) but the
    // authenticated claim/envelope exists and carries reservationId.
    const lostId = encodeReservationIdentity({ decisionId: "d-lost", seatId: "s1", accountId: "a1", vectors: VECTORS });
    const claim = {
      envelopeId: "env-1",
      envelope: { envelopeId: "env-1", seatId: "s1", accountId: "a1", reservationId: lostId, routeDecisionDigest: "a".repeat(64) },
    };
    const result = reconcileReservationFromClaim(store, { claim, now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, true);
    const repaired = getReservation(store, lostId);
    assert.equal(repaired.state, "claimed");
    assert.equal(repaired.claimId, "env-1");
    assert.equal(repaired.envelopeId, "env-1");
    assert.deepEqual(repaired.vectors, VECTORS);
    // Idempotent: reconciling again is a no-op.
    const again = reconcileReservationFromClaim(store, { claim, now: NOW });
    assert.equal(again.repaired, false);
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("crash window 3: reservation expired while claim active — claim is authoritative", () => {
  const { store, dir } = freshStore();
  try {
    const reservationId = createReservation(store, { decisionId: "d1", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW, ttlSeconds: 1 });
    expireStaleReservations(store, { now: "2026-09-16T12:10:00Z" });
    assert.equal(getReservation(store, reservationId).state, "expired");
    // The claim is live in the authenticated claims file.
    const claim = {
      envelopeId: "env-1",
      envelope: { envelopeId: "env-1", seatId: "s1", accountId: "a1", reservationId: reservationId },
    };
    const result = reconcileReservationFromClaim(store, { claim, now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, true);
    assert.equal(getReservation(store, reservationId).state, "claimed");
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("crash window 4: reclaim while spawn ambiguous — the reservation follows the claim", () => {
  const { store, dir } = freshStore();
  try {
    const reservationId = createReservation(store, { decisionId: "d1", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    claimReservation(store, { reservationId: reservationId, claimId: "c", envelopeId: "env-1", now: NOW });
    // The claim was consumed with a terminal reason; the reservation follows.
    const completed = followClaimConsumption(store, { envelopeId: "env-1", reason: "completed", now: NOW });
    assert.equal(completed.followed[0].state, "consumed");
    // A non-completed consumption releases.
    const secondReservation = createReservation(store, { decisionId: "d2", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    claimReservation(store, { reservationId: secondReservation, claimId: "c2", envelopeId: "env-2", now: NOW });
    const reclaimed = followClaimConsumption(store, { envelopeId: "env-2", reason: "reclaimed", now: NOW });
    assert.equal(reclaimed.followed[0].state, "released");
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("quota observations: latest generation wins; lower generation is rollback", () => {
  const { store, dir } = freshStore();
  try {
    insertQuotaObservation(store, {
      collector: "cursor-statusline", seatId: "s1", generation: 5,
      capturedAt: NOW, expiresAt: "2026-09-16T12:05:00Z", sourceStatus: "ok",
      quotaWindows: [{ unit: "messages", total: 100, used: 10, remaining: 90, resetAt: null, derived: false }],
      accountId: "a1", schemaVersion: 1, concurrency: null, confidence: "high", parseErrors: [],
      schema: "agentic-driver.quota-observation.v1",
    });
    insertQuotaObservation(store, {
      collector: "cursor-statusline", seatId: "s1", generation: 6,
      capturedAt: NOW, expiresAt: "2026-09-16T12:05:00Z", sourceStatus: "ok",
      quotaWindows: [{ unit: "messages", total: 100, used: 20, remaining: 80, resetAt: null, derived: false }],
      accountId: "a1", schemaVersion: 1, concurrency: null, confidence: "high", parseErrors: [],
      schema: "agentic-driver.quota-observation.v1",
    });
    const rollback = insertQuotaObservation(store, {
      collector: "cursor-statusline", seatId: "s1", generation: 4,
      capturedAt: NOW, expiresAt: "2026-09-16T12:05:00Z", sourceStatus: "ok",
      quotaWindows: [], accountId: "a1", schemaVersion: 1, concurrency: null,
      confidence: "high", parseErrors: [], schema: "agentic-driver.quota-observation.v1",
    });
    assert.equal(rollback.ok, false);
    assert.equal(rollback.stale, true);
    const latest = latestQuotaObservations(store);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].generation, 6);
    assert.equal(latest[0].quotaWindows[0].remaining, 80);
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("consumption samples feed the estimator in capture order", () => {
  const { store, dir } = freshStore();
  try {
    insertConsumptionSample(store, { seatId: "s1", unit: "messages", quantity: 10, claimId: "c1", capturedAt: "2026-09-16T11:00:00Z" });
    insertConsumptionSample(store, { seatId: "s1", unit: "messages", quantity: 12, claimId: "c2", capturedAt: "2026-09-16T11:30:00Z" });
    insertConsumptionSample(store, { seatId: "s2", unit: "messages", quantity: 99, claimId: "c3", capturedAt: "2026-09-16T11:45:00Z" });
    const all = consumptionSamples(store, { seatId: "s1" });
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((s) => s.quantity), [10, 12]);
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("route decisions and ranking observations persist for audit", () => {
  const { store, dir } = freshStore();
  try {
    const record = {
      schema: "agentic-driver.route-decision.v1",
      decisionId: "dec-1", createdAt: NOW, cardHash: "a".repeat(64),
      specHash: "b".repeat(64), snapshotDigest: "c".repeat(64), configDigest: "d".repeat(64),
      eligibleSeats: [], rankedOrder: ["s1"], selectedSeatId: "s1",
      ranking: { used: false, requestId: null, digest: null },
      policyVersion: "agentic-driver.automation-policy.v1", configRevision: 1,
      reservationId: null, phase: "implement", parentDecisionId: null,
    };
    insertRouteDecision(store, { record, digest: "e".repeat(64) });
    const loaded = getRouteDecision(store, "dec-1");
    assert.equal(loaded.decisionId, "dec-1");
    assert.equal(loaded.selectedSeatId, "s1");
    insertRankingObservation(store, {
      requestId: "rank-1", createdAt: NOW, candidateDigest: "f".repeat(64),
      outcome: "fallback-failed", detail: { reason: "janus unavailable" },
    });
    assert.equal(storeHealthy(store), true);
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test("SQLite corruption fails closed for NEW reservations (storeHealthy reports)", () => {
  const { store, dir } = freshStore();
  try {
    assert.equal(storeHealthy(store), true);
    closeRouterStore(store);
    // Corrupt the file after close; reopening must fail rather than silently
    // proceeding (the caller applies the §10 policy: fail closed for NEW
    // reservations; existing claims are unaffected).
    writeFileSync(join(dir, "state.db"), "this is not a database", "utf8");
    let threw = false;
    try {
      const corrupt = openRouterStore({ dbPath: join(dir, "state.db") });
      closeRouterStore(corrupt);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "opening a corrupt database must fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimReservation: already-claimed binding mismatch rejects; the same binding renews idempotently", () => {
  const { store, dir } = freshStore();
  try {
    const reservationId = createReservation(store, { decisionId: "d1", seatId: "s1", accountId: "a1", vectors: VECTORS, now: NOW });
    const first = claimReservation(store, { reservationId, claimId: "claim-1", envelopeId: "env-1", now: NOW });
    assert.equal(first.ok, true);
    assert.equal(first.renewed, false);
    // A DIFFERENT claim/envelope may never bind an already-claimed reservation.
    const otherClaim = claimReservation(store, { reservationId, claimId: "claim-2", envelopeId: "env-2", now: NOW });
    assert.equal(otherClaim.ok, false);
    assert.equal(otherClaim.state, "claimed");
    assert.match(otherClaim.reason, /bound to a different claim\/envelope/);
    const otherEnvelope = claimReservation(store, { reservationId, claimId: "claim-1", envelopeId: "env-2", now: NOW });
    assert.equal(otherEnvelope.ok, false);
    // The SAME binding renews idempotently and only extends the lease.
    const before = getReservation(store, reservationId);
    const renewed = claimReservation(store, { reservationId, claimId: "claim-1", envelopeId: "env-1", now: "2026-09-16T13:00:00Z" });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.renewed, true);
    const after = getReservation(store, reservationId);
    assert.equal(after.claimId, "claim-1");
    assert.equal(after.envelopeId, "env-1");
    assert.ok(after.leaseExpiresAt > before.leaseExpiresAt);
    // Unknown reservations fail closed with a precise reason.
    const ghost = claimReservation(store, { reservationId: "res.ghost", claimId: "c", envelopeId: "e", now: NOW });
    assert.equal(ghost.ok, false);
    assert.match(ghost.reason, /does not exist/);
  } finally { closeRouterStore(store); rmSync(dir, { recursive: true, force: true }); }
});
