// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Replacement and lineage (ROUTER_DESIGN_TASK68 §7): the same-seat vs
// different-seat replacement rules and the dead-route rule.
//
// - Same-seat replacement (worker died, same route healthy): reuses the
//   envelope; pinned route.
// - Different-seat replacement (route dead, quota exhausted): requires a NEW
//   route-decision record AND a new claim/envelope — an envelope
//   authenticated for the old seat is never reused for a new seat. The new
//   record carries parentDecisionId lineage.
// - Dead-route rule: a seat whose collector reports failure or whose health
//   probe fails can never be used for replacement.
//
// Pure decision logic; the caller performs the actual replaceAttempt /
// claim transitions.

import { sha256Hex } from "./router_schemas_pi.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// §4 freshness at read time, duplicated here for the health/quota checks the
// replacement decision needs (single source of truth lives in the schemas
// module; this re-derivation keeps this module dependency-light).
function fresh(record, now) {
  if (!isPlainObject(record)) return false;
  if (record.sourceStatus !== "ok") return false;
  const at = typeof now === "string" ? Date.parse(now) : now;
  const expiry = Date.parse(record?.expiresAt);
  return Number.isFinite(at) && Number.isFinite(expiry) && at < expiry;
}

// The dead-route rule (§7.2): a seat is DEAD for replacement when its
// collector reports failure (sourceStatus not ok, or stale observation) or
// its health probe fails (no fresh ok health observation for local seats).
// A dead seat can never be used for replacement — not even the same seat.
export function isDeadRoute({ seat, healthObservations = {}, quotaObservations = [], now }) {
  if (!isPlainObject(seat)) return { dead: true, reason: "seat record missing" };
  if (seat.enabled !== true) return { dead: true, reason: "seat is disabled in config" };
  if (seat.kind === "local") {
    const health = isPlainObject(healthObservations) ? healthObservations[seat.endpointRef] : undefined;
    if (!fresh(health, now)) {
      return { dead: true, reason: `endpoint "${seat.endpointRef}" has no fresh ok health observation` };
    }
    return { dead: false, reason: null };
  }
  // Subscription seats: collector failure is fatal for replacement (§10:
  // stale/malformed/unknown excludes the route; fail closed).
  const observations = (Array.isArray(quotaObservations) ? quotaObservations : [])
    .filter((obs) => obs?.seatId === seat.seatId);
  if (seat.quotaCollector !== null) {
    const anyOk = observations.some((obs) => obs.sourceStatus === "ok");
    if (!anyOk) {
      return { dead: true, reason: `collector for seat "${seat.seatId}" reports failure (fail closed)` };
    }
  }
  return { dead: false, reason: null };
}

// The replacement decision (§7.2). Inputs: the authenticated envelope's
// route identity, the candidate replacement seat (from a NEW route decision
// when the seat differs), and current health/quota observations.
// Returns one of:
//   { action: "reuse-envelope" }                       — same seat, alive
//   { action: "new-route-decision" }                   — different seat required
//   { action: "refused", reason }                      — dead route / invalid
export function replacementAction({ envelope, replacementSeatId = null, seatsById, healthObservations = {}, quotaObservations = [], now }) {
  const currentSeatId = typeof envelope?.seatId === "string" ? envelope.seatId : null;
  if (currentSeatId === null) {
    return { action: "refused", reason: "the envelope carries no seat identity (fails closed)" };
  }
  const targetSeatId = replacementSeatId ?? currentSeatId;
  const seat = seatsById?.get?.(targetSeatId) ?? null;

  // Dead-route rule first: the target seat (even the same seat) must be alive.
  const dead = isDeadRoute({ seat, healthObservations, quotaObservations, now });
  if (dead.dead) {
    return { action: "refused", reason: `dead route: ${dead.reason} (a dead route can never be used for replacement)` };
  }

  if (targetSeatId === currentSeatId) {
    // Same-seat replacement: the envelope is reused; the route is pinned.
    return { action: "reuse-envelope", seatId: currentSeatId };
  }
  // Different-seat replacement: a NEW route-decision record AND a new
  // claim/envelope are required (the old envelope is never re-authenticated
  // for another seat). The new decision carries parentDecisionId lineage.
  return { action: "new-route-decision", fromSeatId: currentSeatId, toSeatId: targetSeatId };
}

// Lineage digest for the replacement chain: binds parent decision, old
// envelope, and attempt index into the new decision's audit trail.
export function lineageDigest({ parentDecisionId, oldEnvelopeId, attemptIndex }) {
  return sha256Hex(JSON.stringify({ parentDecisionId, oldEnvelopeId, attemptIndex }));
}
