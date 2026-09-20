// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Route-decision engine (ROUTER_DESIGN_TASK68 §6): deterministic, ordered
// eligibility evaluation over validated seats, the 40% reserve rule in final
// form, the consumption estimator, and the immutable route-decision record.
//
// Pure and side-effect-free, like pulse_core_pi.js: it consumes validated
// config, observations, and samples; it never reads files, never touches the
// board, and never grants authority. The digest of the emitted record is the
// routeDecisionDigest carried into envelopes and the Jev evalInputDigest.

import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonString, sha256Hex } from "./router_schemas_pi.js";
import {
  SEAT_KINDS, CAPABILITIES, CONTAINMENT_TIERS, PHASES, QUOTA_UNITS,
  ELIGIBILITY_RULES, computeConfigDigest, validateRouterConfig, wellFormedQuotaObservation,
} from "./router_schemas_pi.js";
import { rankOrFallback } from "./router_ranking_pi.js";
export { canonicalJsonString, sha256Hex };

export const ROUTE_DECISION_SCHEMA = "agentic-driver.route-decision.v1";
export const AUTOMATION_POLICY_VERSION = "agentic-driver.automation-policy.v1";

const HEX64_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Consumption estimator (§6.2): per seat and unit, the mean of the last
// N completed dispatches on that seat, outliers beyond sigma excluded,
// minimum minSamples samples; below minSamples the cold-start conservative
// constant = coldStartFraction × the smallest window total on that account.
// ---------------------------------------------------------------------------

export function estimateConsumption({ seatId, unit, samples = [], reserve, accountWindows = [] }) {
  if (!QUOTA_UNITS.includes(unit)) {
    return { estimate: null, source: "unknown-unit", sampleCount: 0 };
  }
  const unitWindows = (Array.isArray(accountWindows) ? accountWindows : [])
    .filter((window) => window?.unit === unit && Number.isFinite(window?.total));
  const N = reserve?.estimateSamples ?? 20;
  const minSamples = reserve?.estimateMinSamples ?? 5;
  const sigma = reserve?.estimateOutlierSigma ?? 3;
  const coldStartFraction = reserve?.coldStartFraction ?? 0.25;

  const relevant = (Array.isArray(samples) ? samples : [])
    .map((s, index) => ({ ...s, index }))
    .filter((s) => s?.seatId === seatId && s?.unit === unit && Number.isFinite(s?.quantity) && s.quantity >= 0)
    .sort((a, b) => {
      const at = Date.parse(a.capturedAt), bt = Date.parse(b.capturedAt);
      return Number.isFinite(at) && Number.isFinite(bt) ? at - bt || a.index - b.index : a.index - b.index;
    })
    .slice(-N).map((s) => s.quantity);

  if (relevant.length >= minSamples) {
    const mean = relevant.reduce((a, b) => a + b, 0) / relevant.length;
    const variance = relevant.reduce((a, b) => a + (b - mean) ** 2, 0) / relevant.length;
    const sd = Math.sqrt(variance);
    const kept = relevant.filter((q) => sd === 0 || Math.abs(q - mean) <= sigma * sd);
    // After exclusion there are always >= minSamples kept when sd === 0
    // (all values identical); otherwise the kept set can shrink below the
    // minimum — fall through to cold-start only if it does.
    if (kept.length >= minSamples) {
      // Conservative rounding: usage rounds UP (§6.2).
      return { estimate: Math.ceil((kept.reduce((a, b) => a + b, 0) / kept.length) * 1e6) / 1e6, source: "estimated", sampleCount: kept.length };
    }
  }
  // Cold start: 25% (configurable) of the smallest window total on the
  // account, for this unit. No window on this unit → the seat has no quota
  // accounting for this unit and consumes nothing (quantity 0).
  const totals = unitWindows.map((w) => w.total);
  if (totals.length === 0) return { estimate: 0, source: "cold-start", sampleCount: 0 };
  const smallest = Math.min(...totals);
  // Conservative rounding: usage rounds UP (§6.2).
  return { estimate: Math.ceil(smallest * coldStartFraction * 1e6) / 1e6, source: "cold-start", sampleCount: 0 };
}

// ---------------------------------------------------------------------------
// The 40% reserve rule (§6.2, final form). A subscription seat is ineligible
// when the projected post-dispatch remaining capacity of ANY active quota
// window on its account would fall below floorPercent of that window's total.
// All active windows must pass. Per-unit consumption vectors; quantity-
// bearing reservations; remaining rounds down, usage rounds up; unknown
// capacity = ineligible (fail closed).
// ---------------------------------------------------------------------------

// Active window = one whose resetAt is in the future (or null/unbounded) at
// evaluation time. A window about to reset does not borrow headroom from the
// next window: it is evaluated on its own current totals.
export function activeWindows(windows, now) {
  const at = typeof now === "string" ? Date.parse(now) : now;
  return (Array.isArray(windows) ? windows : []).filter((w) => {
    if (w?.resetAt === null || w?.resetAt === undefined) return true;
    const reset = Date.parse(w.resetAt);
    return Number.isFinite(reset) && reset > at;
  });
}

// Aggregate account-level views: sum windows of the same unit and overlapping
// reset windows across the account's seats' observations (§4). Returns a map
// keyed by `${unit}\u0000${resetAt ?? ""}` → {unit, total, used, remaining, resetAt}.
export function aggregateAccountWindows(observations, now) {
  const at = typeof now === "string" ? Date.parse(now) : now;
  const buckets = new Map();
  for (const obs of Array.isArray(observations) ? observations : []) {
    if (!isPlainObject(obs) || obs.sourceStatus !== "ok") continue;
    if (Number.isFinite(at) && Date.parse(obs?.expiresAt) <= at) continue; // stale at read time
    for (const window of Array.isArray(obs.quotaWindows) ? obs.quotaWindows : []) {
      if (window?.resetAt !== null && window?.resetAt !== undefined) {
        const reset = Date.parse(window.resetAt);
        if (!Number.isFinite(reset) || reset <= at) continue; // not active
      }
      const key = `${window.unit}\u0000${window.resetAt ?? ""}`;
      const current = buckets.get(key) ?? {
        windowId: `${obs.accountId}:${window.unit}:${window.resetAt ?? "unbounded"}`,
        unit: window.unit, resetAt: window.resetAt ?? null,
        total: 0, used: 0, remaining: 0,
      };
      // Conservative rounding: remaining rounds DOWN, usage rounds UP.
      current.total += window.total;
      current.used += Math.ceil(window.used);
      current.remaining += Math.floor(window.remaining);
      buckets.set(key, current);
    }
  }
  return [...buckets.values()];
}

// Quantity-bearing reservation vectors for one candidate dispatch: one entry
// per active window unit on the account, with the estimator's per-unit
// quantity. Returns {vectors, sources} or {error} when capacity is unknown.
export function reservationVectors({ accountId, observations, seatId, reserve, samples = [], now }) {
  const accountObs = (Array.isArray(observations) ? observations : [])
    .filter((obs) => obs?.accountId === accountId);
  if (accountObs.length === 0) {
    return { error: "unknown capacity: no fresh ok observation for this account (fail closed)" };
  }
  const fresh = accountObs.filter((obs) => obs.sourceStatus === "ok");
  if (fresh.length === 0) {
    return { error: "unknown capacity: account observations report collector failure (fail closed)" };
  }
  const account = aggregateAccountWindows(accountObs, now);
  if (account.length === 0) {
    return { error: "unknown capacity: no active quota windows on this account (fail closed)" };
  }
  const vectors = [];
  const sources = [];
  for (const window of account) {
    const estimate = estimateConsumption({ seatId, unit: window.unit, samples, reserve, accountWindows: account });
    if (!Number.isFinite(estimate.estimate)) return { error: `unknown touched quota unit "${window.unit}" (fail closed)` };
    vectors.push({
      accountId, windowId: window.windowId, unit: window.unit, resetAt: window.resetAt,
      quantity: estimate.estimate, windowTotal: window.total, windowRemaining: window.remaining,
    });
    sources.push({ unit: window.unit, source: estimate.source, sampleCount: estimate.sampleCount });
  }
  return { vectors, sources };
}

// Evaluate the reserve rule for one seat. Returns {ok, reason, vectors} —
// vectors are the quantity-bearing reservation contents when the rule passes.
export function evaluateReserveRule({ seat, observations, samples = [], reserve, now, existingReservations = [], ownerInteractive = false }) {
  if (seat.kind !== "subscription") return { ok: true, reason: null, vectors: [] };
  if (!isPlainObject(reserve)) return { ok: false, reason: "reserve configuration is missing (fail closed)", vectors: [] };
  const floorPercent = reserve.floorPercent ?? 40;
  const override = ownerInteractive === true && reserve.ownerInteractiveOverride === true;

  const accountId = seat.accountId;
  if (typeof accountId !== "string" || accountId === "") {
    return { ok: false, reason: "subscription seat has no accountId (fail closed)", vectors: [] };
  }
  const projection = reservationVectors({ accountId, observations, seatId: seat.seatId, reserve, samples, now });
  if (projection.error) {
    return { ok: false, reason: projection.error, vectors: [] };
  }
  // Prior unclaimed reservations on the same account consume headroom too.
  const outstanding = new Map();
  for (const res of Array.isArray(existingReservations) ? existingReservations : []) {
    if (res?.accountId !== accountId) continue;
    if (res?.state !== "reserved" && res?.state !== "claimed") continue;
    const key = `${res.unit}\u0000${res.resetAt ?? ""}`;
    outstanding.set(key, (outstanding.get(key) ?? 0) + (Number.isFinite(res?.quantity) ? res.quantity : 0));
  }
  for (const vector of projection.vectors) {
    const key = `${vector.unit}\u0000${vector.resetAt ?? ""}`;
    const prior = outstanding.get(key) ?? 0;
    // Conservative rounding: remaining rounds DOWN, usage rounds UP.
    const projectedRemaining = Math.floor(vector.windowRemaining) - Math.ceil(vector.quantity) - Math.ceil(prior);
    const floor = (vector.windowTotal * floorPercent) / 100;
    if (projectedRemaining < floor) {
      if (!override) {
        return {
          ok: false,
          reason: `reserve floor: window ${vector.unit} (reset ${vector.resetAt ?? "none"}) would fall to ${projectedRemaining} < ${floorPercent}% of ${vector.windowTotal}`,
          vectors: [],
        };
      }
    }
  }
  return { ok: true, reason: null, vectors: projection.vectors, sources: projection.sources };
}

// ---------------------------------------------------------------------------
// Deterministic eligibility (§6.1): eight ordered rules; first failing rule
// excludes the seat. Inputs are validated/normalized by the caller.
// ---------------------------------------------------------------------------

// Evaluate all eight rules for one seat against one card. `inputs` carries:
//   seat, card, policyRouteSeatIds, healthObservations, quotaObservations,
//   consumptionSamples, reserve, now, existingReservations, activeSessions,
//   providerLimit, modelInstalled (Set of installed model ids), ownerInteractive
export function evaluateSeatEligibility(inputs) {
  const {
    seat, card, policyRouteSeatIds = [], healthObservations = {},
    quotaObservations = [], consumptionSamples = [], reserve = null,
    now, existingReservations = [], activeSessions = [], providerLimit = null,
    modelInstalled = null, ownerInteractive = false,
  } = inputs;
  const exclusions = [];

  // Rule 1: seat.enabled === true (config).
  if (seat.enabled !== true) {
    exclusions.push({ rule: ELIGIBILITY_RULES[0], reason: "seat is disabled in config" });
    return { eligible: false, exclusions };
  }

  // Rule 2: seat referenced by the role's board-policy route list.
  const role = typeof card?.role === "string" && card.role !== "" ? card.role : "implementer";
  if (!policyRouteSeatIds.includes(seat.seatId)) {
    exclusions.push({ rule: ELIGIBILITY_RULES[1], reason: `seat "${seat.seatId}" is not referenced by the board-policy route list for role "${role}"` });
    return { eligible: false, exclusions };
  }

  // Rule 3: card capabilities ⊆ seat capabilities (exact tag match at launch).
  const cardCaps = Array.isArray(card?.capabilities) ? card.capabilities : [];
  const seatCaps = new Set(Array.isArray(seat.capabilities) ? seat.capabilities : []);
  const missing = cardCaps.filter((c) => !seatCaps.has(c));
  if (missing.length > 0) {
    exclusions.push({ rule: ELIGIBILITY_RULES[2], reason: `seat lacks required capabilities: ${missing.join(", ")}` });
    return { eligible: false, exclusions };
  }

  // Rule 4: containment tier compatibility. Tier 1 work requires testudo;
  // docker-policy and none seats are ineligible for containment-required cards.
  const requiresContainment = card?.placement === "container" || card?.containmentRequired === true;
  if (requiresContainment && seat.containmentTier !== "testudo") {
    exclusions.push({ rule: ELIGIBILITY_RULES[3], reason: `card requires containment; seat containmentTier is "${seat.containmentTier}"` });
    return { eligible: false, exclusions };
  }

  // Rule 5: endpoint health. Local seats require a fresh ok health
  // observation; hosted/subscription seats require registry resolution
  // (which the validated config already provides — the endpointRef resolved
  // at config-validation time).
  if (seat.kind === "local") {
    const health = isPlainObject(healthObservations) ? healthObservations[seat.endpointRef] : undefined;
    const fresh = isPlainObject(health) && health.sourceStatus === "ok"
      && Number.isFinite(Date.parse(health?.expiresAt))
      && (typeof now === "string" ? Date.parse(now) : now) < Date.parse(health.expiresAt);
    if (!fresh) {
      exclusions.push({ rule: ELIGIBILITY_RULES[4], reason: `endpoint "${seat.endpointRef}" has no fresh ok health observation` });
      return { eligible: false, exclusions };
    }
    // Concurrency headroom on the local seat.
    const active = (Array.isArray(activeSessions) ? activeSessions : [])
      .filter((s) => s?.seatId === seat.seatId).length;
    if (active >= seat.maxConcurrency) {
      exclusions.push({ rule: ELIGIBILITY_RULES[4], reason: `local seat concurrency full (${active}/${seat.maxConcurrency})` });
      return { eligible: false, exclusions };
    }
  }

  // Rule 6: model installed — the lifecycle's installed-model check. The
  // caller supplies the trusted installed-model set; a null set fails closed.
  if (modelInstalled === null || !(modelInstalled instanceof Set) || !modelInstalled.has(seat.model)) {
    exclusions.push({ rule: ELIGIBILITY_RULES[5], reason: `model "${seat.model}" is not in the installed-model set` });
    return { eligible: false, exclusions };
  }

  // Rule 7: quota eligibility. Subscription seats: every active account
  // window passes the 40% reserve projection. Local seats: concurrency
  // headroom only (checked under rule 5 for the endpoint).
  if (seat.kind === "subscription") {
    const reserveResult = evaluateReserveRule({
      seat, observations: quotaObservations, samples: consumptionSamples,
      reserve, now, existingReservations, ownerInteractive,
    });
    if (!reserveResult.ok) {
      exclusions.push({ rule: ELIGIBILITY_RULES[6], reason: reserveResult.reason });
      return { eligible: false, exclusions };
    }
    var reservationVectors = reserveResult.vectors;
  } else {
    var reservationVectors = [];
  }

  // Rule 8: global capacity — composed free capacity > 0 under the corrected
  // freeCapacity(). The caller supplies the composed number (it owns the
  // pulse policy); the engine only applies the > 0 predicate.
  if (!Number.isInteger(providerLimit) || providerLimit <= 0) {
    // providerLimit here is the composed free-capacity count passed by the
    // caller (renamed at the call boundary); 0 or absent fails closed.
    exclusions.push({ rule: ELIGIBILITY_RULES[7], reason: "no free global capacity on the seat's route" });
    return { eligible: false, exclusions };
  }

  return { eligible: true, exclusions, reservationVectors };
}

// ---------------------------------------------------------------------------
// Route decision (§6.3): one immutable record per (card, snapshot).
// ---------------------------------------------------------------------------

export function routeDecisionRecord({
  decisionId = null, createdAt, cardHash, specHash, snapshotDigest, configDigest,
  eligibleSeats, rankedOrder, selectedSeatId, ranking = null, configRevision,
  reservationId = null, phase = "implement", parentDecisionId = null,
}) {
  const record = {
    schema: ROUTE_DECISION_SCHEMA,
    decisionId: decisionId ?? randomUUID(),
    createdAt,
    cardHash,
    specHash,
    snapshotDigest,
    configDigest,
    eligibleSeats,
    rankedOrder,
    selectedSeatId,
    ranking: ranking ?? { used: false, requestId: null, digest: null },
    policyVersion: AUTOMATION_POLICY_VERSION,
    configRevision,
    reservationId,
    phase: PHASES.includes(phase) ? phase : "implement",
    parentDecisionId,
  };
  return Object.freeze(record);
}

export function routeDecisionDigest(record) {
  return sha256Hex(canonicalJsonString(record));
}

// Well-formedness check for a route-decision record (closed shape).
export function wellFormedRouteDecision(record) {
  if (!isPlainObject(record) || record.schema !== ROUTE_DECISION_SCHEMA) return false;
  const keys = Object.keys(record).sort();
  const expected = [
    "schema", "decisionId", "createdAt", "cardHash", "specHash", "snapshotDigest",
    "configDigest", "eligibleSeats", "rankedOrder", "selectedSeatId", "ranking",
    "policyVersion", "configRevision", "reservationId", "phase", "parentDecisionId",
  ].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) return false;
  if (typeof record.decisionId !== "string" || record.decisionId === "") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(record.createdAt)) return false;
  for (const field of ["cardHash", "specHash", "snapshotDigest", "configDigest"]) {
    if (!HEX64_RE.test(record[field] ?? "")) return false;
  }
  if (!Array.isArray(record.eligibleSeats)) return false;
  for (const entry of record.eligibleSeats) {
    if (!isPlainObject(entry) || !Object.hasOwn(entry, "seatId") || !Object.hasOwn(entry, "excluded") || !Object.hasOwn(entry, "reason")) return false;
    if (typeof entry.seatId !== "string" || typeof entry.excluded !== "boolean") return false;
    if (entry.excluded && typeof entry.reason !== "string") return false;
  }
  if (!Array.isArray(record.rankedOrder) || !record.rankedOrder.every((id) => typeof id === "string")) return false;
  if (typeof record.selectedSeatId !== "string" || record.selectedSeatId === "") return false;
  const ranking = record.ranking;
  if (!isPlainObject(ranking) || typeof ranking.used !== "boolean"
    || (ranking.requestId !== null && typeof ranking.requestId !== "string")
    || (ranking.digest !== null && !HEX64_RE.test(ranking.digest))) return false;
  if (record.policyVersion !== AUTOMATION_POLICY_VERSION) return false;
  if (!Number.isInteger(record.configRevision)) return false;
  if (record.reservationId !== null && typeof record.reservationId !== "string") return false;
  if (!PHASES.includes(record.phase)) return false;
  if (record.parentDecisionId !== null && typeof record.parentDecisionId !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------
// The full route decision for one card: evaluate every seat in preference
// order, rank the eligible ones, select, and emit the immutable record.
// `janusRank` is the injected ranking adapter (async (candidates) =>
// {order, requestId} | null); null or a failed call falls back to
// preferences.order deterministically (ranking never blocks dispatch).
// ---------------------------------------------------------------------------

export async function routeDecision({
  card, config, snapshotDigest, policyRouteSeatIds, healthObservations = {},
  quotaObservations = [], consumptionSamples = [], now,
  existingReservations = [], activeSessions = [], freeCapacityBySeat = {},
  modelInstalled = null, ownerInteractive = false, janusRank = null,
  decisionId = null, parentDecisionId = null, phase = "implement",
}) {
  const configValidation = validateRouterConfig(config);
  if (!configValidation.ok) {
    return { ok: false, code: "config-invalid", reason: `router config is invalid and refuses to produce decisions: ${configValidation.errors.join("; ")} (fail closed)` };
  }
  const seatsById = new Map(config.seats.map((s) => [s.seatId, s]));
  const validObservations = quotaObservations.every((obs) => {
    if (!wellFormedQuotaObservation(obs).ok) return false;
    const seat = seatsById.get(obs?.seatId);
    const collector = config.collectors?.[obs?.collector];
    return seat && seat.kind === "subscription" && obs.accountId === seat.accountId
      && obs.collector === seat.quotaCollector && collector?.accounts?.includes(obs.accountId);
  });
  if (!validObservations) return { ok: false, code: "observation-invalid", reason: "quota observation does not match configured seat/account/collector (fail closed)" };
  const reserve = config.eligibility?.reserve ?? null;
  const preferenceOrder = (config.preferences?.order ?? []).map((e) => e.seatId);

  // Evaluate every seat in the config's declared order (deterministic);
  // collect eligibility per seat with exclusion reasons for the audit list.
  const eligible = [];
  const eligibleSeats = [];
  for (const seat of config.seats) {
    const result = evaluateSeatEligibility({
      seat, card, policyRouteSeatIds, healthObservations, quotaObservations,
      consumptionSamples, reserve, now, existingReservations, activeSessions,
      providerLimit: freeCapacityBySeat[seat.seatId] ?? 0,
      modelInstalled, ownerInteractive,
    });
    eligibleSeats.push({
      seatId: seat.seatId,
      excluded: !result.eligible,
      reason: result.eligible ? null : result.exclusions.map((e) => e.reason).join("; "),
    });
    if (result.eligible) {
      eligible.push({ seat, vectors: result.reservationVectors });
    }
  }

  // Deterministic candidate ordering: preference order first (only seats in
  // preferences.order, in that order), then remaining eligible seats in
  // config declaration order — never arbitrary.
  const preferred = preferenceOrder.filter((id) => eligible.some((e) => e.seat.seatId === id));
  const rest = eligible.map((e) => e.seat.seatId).filter((id) => !preferred.includes(id));
  const fallbackOrder = [...preferred, ...rest];

  const quotaBuckets = Object.fromEntries(eligible.map(({ seat, vectors }) => {
    if (seat.kind !== "subscription") return [seat.seatId, "high"];
    const ratio = Math.min(...vectors.map((v) => (v.windowRemaining - v.quantity) / v.windowTotal));
    return [seat.seatId, ratio < 0.5 ? "reserve-zone" : ratio < 0.65 ? "low" : ratio < 0.8 ? "medium" : "high"];
  }));
  const ranked = await rankOrFallback({ config, eligibleSeatIds: fallbackOrder, seatsById, quotaBuckets, janusRank, now });
  const rankedOrder = ranked.order;
  const ranking = { used: ranked.used, requestId: ranked.requestId, digest: ranked.digest };

  const selectedSeatId = rankedOrder[0] ?? null;
  if (selectedSeatId === null) {
    return {
      ok: false,
      code: "no-eligible-seat",
      reason: "no eligible seat for this card under the current snapshot (fail closed)",
      eligibleSeats,
    };
  }

  // Reservation: subscription seats with quota accounting get a
  // quantity-bearing reservation id minted by the caller's store; the record
  // carries it when present.
  const selected = eligible.find((e) => e.seat.seatId === selectedSeatId);
  const needsReservation = selected.seat.kind === "subscription" && selected.vectors.length > 0;

  const finalDecisionId = decisionId ?? randomUUID();
  const reservationId = needsReservation
    ? `res.${Buffer.from(JSON.stringify({ decisionId: finalDecisionId, seatId: selected.seat.seatId, accountId: selected.seat.accountId, vectors: selected.vectors }), "utf8").toString("base64url")}`
    : null;
  const record = routeDecisionRecord({
    decisionId: finalDecisionId, createdAt: now, cardHash: card.hash ?? null, specHash: card.specHash ?? null,
    snapshotDigest, configDigest: computeConfigDigest(config), eligibleSeats, rankedOrder,
    selectedSeatId, ranking, configRevision: config.revision, reservationId, phase, parentDecisionId,
  });
  return {
    ok: true, record, digest: routeDecisionDigest(record), selectedSeatId,
    reservationId, reservationVectors: selected.vectors, needsReservation,
    accountId: selected.seat.accountId, provider: selected.seat.provider,
    endpointRef: selected.seat.endpointRef, model: selected.seat.model,
    containmentTier: selected.seat.containmentTier,
    effort: ["low", "default", "high"].includes(card?.effort) ? card.effort : "default",
  };
}
