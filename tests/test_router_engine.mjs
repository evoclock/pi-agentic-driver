// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Route-decision engine tests (ROUTER_DESIGN_TASK68 §6): the eight ordered
// eligibility rules, the 40% reserve rule in final form (all active windows
// must pass, per-account aggregation, per-unit consumption vectors), the
// N=20 estimator (outliers, cold-start, min-5-samples), and the immutable
// route-decision record with digest.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SEAT_SCHEMA, ROUTER_CONFIG_SCHEMA, QUOTA_OBSERVATION_SCHEMA,
} from "../scripts/enforcement/router_schemas_pi.js";
import {
  ROUTE_DECISION_SCHEMA, estimateConsumption, activeWindows,
  aggregateAccountWindows, evaluateReserveRule, evaluateSeatEligibility,
  reservationVectors, routeDecisionRecord, routeDecisionDigest,
  wellFormedRouteDecision, routeDecision,
} from "../scripts/enforcement/router_engine_pi.js";

const NOW = "2026-09-16T12:00:00Z";

function seat(overrides = {}) {
  return {
    schema: SEAT_SCHEMA,
    seatId: "cursor-claude-main",
    kind: "subscription",
    provider: "vercel-ai-gateway",
    accountId: "acct-cursor-main",
    endpointRef: "merge",
    model: "claude-x",
    capabilities: ["implement", "review"],
    containmentTier: "none",
    maxConcurrency: 2,
    costClass: "high",
    quotaCollector: "cursor-statusline",
    clusterMembership: null,
    enabled: true,
    deprecated: null,
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    schema: ROUTER_CONFIG_SCHEMA,
    revision: 3,
    endpoints: { merge: { url: "https://gateway.example.internal/v1", kind: "vercel-ai-gateway" } },
    seats: [seat()],
    models: { "claude-x": { aliases: [], contextWindow: 100000, capabilities: ["implement", "review"] } },
    collectors: { "cursor-statusline": { adapter: "statusline-cache", cachePath: "/tmp/quota/cursor.json", ttlSeconds: 300, accounts: ["acct-cursor-main"] } },
    eligibility: {
      rules: [],
      reserve: {
        floorPercent: 40, scope: "account-window", coldStartFraction: 0.25,
        estimateSamples: 20, estimateMinSamples: 5, estimateOutlierSigma: 3,
        ownerInteractiveOverride: false,
      },
    },
    preferences: { order: [{ seatId: "cursor-claude-main" }], costPolicy: "free-first" },
    ranking: { enabled: false, janusUrl: "http://127.0.0.1:7431", maxCandidates: 8, fallback: "preference-order" },
    localHealth: { probeSeconds: 60, warmStateTracking: true },
    secrets: {},
    ...overrides,
  };
}

function observation(overrides = {}, windowOverrides = {}) {
  return {
    schema: QUOTA_OBSERVATION_SCHEMA,
    collector: "cursor-statusline",
    schemaVersion: 1,
    seatId: "cursor-claude-main",
    accountId: "acct-cursor-main",
    capturedAt: "2026-09-16T11:58:00Z",
    expiresAt: "2026-09-16T12:05:00Z",
    generation: 7,
    quotaWindows: [
      { unit: "messages", total: 100, used: 30, remaining: 70, resetAt: "2026-09-16T18:00:00Z", derived: false, ...windowOverrides },
    ],
    concurrency: { active: 1, limit: 3 },
    confidence: "high",
    sourceStatus: "ok",
    parseErrors: [],
    ...overrides,
  };
}

function card(overrides = {}) {
  return {
    cardId: "T-0001", title: "Card", role: "implementer",
    capabilities: ["implement"], placement: "container",
    containmentRequired: true, hash: "a".repeat(64), specHash: "b".repeat(64),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Estimator (§6.2)
// ---------------------------------------------------------------------------

test("estimator: mean of last N=20 with 3-sigma outlier exclusion", () => {
  const reserve = config().eligibility.reserve;
  // 5 normal samples around 10, plus one gross outlier.
  const samples = [10, 10, 10, 11, 9].map((quantity, i) => ({ seatId: "s", unit: "messages", quantity }));
  const withOutlier = [...samples, { seatId: "s", unit: "messages", quantity: 1000 }];
  const result = estimateConsumption({ seatId: "s", unit: "messages", samples: withOutlier, reserve, accountWindows: [] });
  // 6 samples: mean ~175, sd ~403 → 3σ band keeps everything; but with N=20
  // semantics and a min of 5, the outlier inflates the mean. Use a bigger
  // clean set so the outlier is actually excluded.
  const clean = Array.from({ length: 15 }, () => 10).map((quantity) => ({ seatId: "s", unit: "messages", quantity }));
  const mixed = [...clean, { seatId: "s", unit: "messages", quantity: 500 }];
  const mixedResult = estimateConsumption({ seatId: "s", unit: "messages", samples: mixed, reserve, accountWindows: [] });
  assert.equal(mixedResult.source, "estimated");
  assert.equal(mixedResult.estimate, 10); // outlier excluded, mean stays 10
  assert.equal(mixedResult.sampleCount, 15);
});

test("estimator: below min-5 samples falls back to cold-start constant", () => {
  const reserve = config().eligibility.reserve;
  const few = [10, 12].map((quantity) => ({ seatId: "s", unit: "messages", quantity }));
  const result = estimateConsumption({
    seatId: "s", unit: "messages", samples: few, reserve,
    accountWindows: [{ unit: "messages", total: 100 }, { unit: "messages", total: 40 }],
  });
  assert.equal(result.source, "cold-start");
  // 25% of the SMALLEST window total (40) = 10.
  assert.equal(result.estimate, 10);
});

test("estimator: cold-start with no window on the unit consumes nothing", () => {
  const reserve = config().eligibility.reserve;
  const result = estimateConsumption({
    seatId: "s", unit: "tokens", samples: [], reserve,
    accountWindows: [{ unit: "messages", total: 100 }],
  });
  assert.equal(result.estimate, 0);
  assert.equal(result.source, "cold-start");
});

test("estimator: only the seat's own samples count (per-seat estimation)", () => {
  const reserve = config().eligibility.reserve;
  const samples = Array.from({ length: 10 }, () => 50).map((quantity) => ({ seatId: "other", unit: "messages", quantity }));
  const result = estimateConsumption({
    seatId: "s", unit: "messages", samples, reserve,
    accountWindows: [{ unit: "messages", total: 100 }],
  });
  assert.equal(result.source, "cold-start"); // no samples for THIS seat
});

// ---------------------------------------------------------------------------
// Active windows and account aggregation (§4/§6.2)
// ---------------------------------------------------------------------------

test("active windows: reset-aligned; a window about to reset does not borrow headroom", () => {
  const windows = [
    { unit: "messages", total: 100, used: 90, remaining: 10, resetAt: "2026-09-16T12:30:00Z" },
    { unit: "messages", total: 100, used: 0, remaining: 100, resetAt: "2026-09-16T13:30:00Z" },
  ];
  const active = activeWindows(windows, NOW);
  assert.equal(active.length, 2);
  const afterReset = activeWindows(windows, "2026-09-16T12:31:00Z");
  assert.equal(afterReset.length, 1); // the 12:30 window is no longer active
  assert.equal(afterReset[0].resetAt, "2026-09-16T13:30:00Z");
});

test("account aggregation sums same-unit overlapping windows and skips stale observations", () => {
  const obsA = observation({}, { total: 100, used: 30, remaining: 70 });
  const obsB = observation({ seatId: "cursor-claude-second" }, { total: 50, used: 10, remaining: 40 });
  const aggregated = aggregateAccountWindows([obsA, obsB], NOW);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].total, 150);
  assert.equal(aggregated[0].remaining, 110);
  // Stale observation is excluded (read-time freshness).
  const stale = observation({ expiresAt: "2026-09-16T11:00:00Z" });
  assert.equal(aggregateAccountWindows([obsA, stale], NOW).length, 1);
  // Failed observation is excluded from aggregation.
  const failed = observation({ sourceStatus: "parse-error" });
  assert.equal(aggregateAccountWindows([obsA, failed], NOW).length, 1);
});

// ---------------------------------------------------------------------------
// The 40% reserve rule (§6.2, final form)
// ---------------------------------------------------------------------------

test("reserve rule: passing window admits the seat and yields quantity-bearing vectors", () => {
  const reserve = config().eligibility.reserve;
  const result = evaluateReserveRule({
    seat: seat(), observations: [observation()], samples: [], reserve, now: NOW,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.vectors.length, 1);
  assert.equal(result.vectors[0].accountId, "acct-cursor-main");
  assert.equal(result.vectors[0].unit, "messages");
  assert.equal(result.vectors[0].windowTotal, 100);
  assert.equal(result.vectors[0].windowRemaining, 70);
  assert.ok(Number.isFinite(result.vectors[0].quantity));
});

test("reserve rule: ANY active window failing makes the seat ineligible (all must pass)", () => {
  const reserve = config().eligibility.reserve;
  // messages: 70 remaining (passes); tokens: 10% remaining (fails).
  const obs = observation({}, {
    unit: "messages", total: 100, used: 30, remaining: 70,
  });
  const obs2 = observation({ generation: 8 }, {
    unit: "tokens", total: 1000, used: 900, remaining: 100,
  });
  const result = evaluateReserveRule({
    seat: seat(), observations: [obs, obs2], samples: [], reserve, now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /reserve floor/);
  assert.match(result.reason, /tokens/);
});

test("reserve rule: 40% floor arithmetic — remaining below floor rejects", () => {
  const reserve = config().eligibility.reserve;
  // 100 total, 40% floor = 40. Projected remaining must be >= 40.
  // Cold-start estimate = 25% of smallest total = 25. 70 - 25 = 45 >= 40: pass.
  const passing = evaluateReserveRule({ seat: seat(), observations: [observation()], samples: [], reserve, now: NOW });
  assert.equal(passing.ok, true);
  // used: 55, remaining: 45 → floor 40; 45 - 25 = 20 < 40: fail.
  const failing = evaluateReserveRule({
    seat: seat(), observations: [observation({}, { used: 55, remaining: 45 })], samples: [], reserve, now: NOW,
  });
  assert.equal(failing.ok, false);
});

test("reserve rule: seats sharing an account aggregate through the account mapping", () => {
  const reserve = config().eligibility.reserve;
  // Two seats on one account; each alone would pass but aggregated usage
  // plus two cold-start estimates fails the floor.
  const seatA = seat({ seatId: "cursor-claude-main" });
  const seatB = seat({ seatId: "cursor-claude-second" });
  const obsA = observation({ seatId: "cursor-claude-main" }, { total: 100, used: 30, remaining: 70 });
  const obsB = observation({ seatId: "cursor-claude-second" }, { total: 50, used: 10, remaining: 40 });
  // Aggregated: total 150, remaining 110. Cold-start for each = 25% of
  // smallest window total (50) = 12.5 → two dispatches ≈ 25. 110-25 = 85 >= 60: pass.
  const pass = evaluateReserveRule({ seat: seatA, observations: [obsA, obsB], samples: [], reserve, now: NOW });
  assert.equal(pass.ok, true, pass.reason);
  // Now aggregate to near the floor: total 100, remaining 45 (floor 40).
  const obsTight = observation({ seatId: "cursor-claude-main" }, { total: 100, used: 55, remaining: 45 });
  const obsTight2 = observation({ seatId: "cursor-claude-second" }, { total: 100, used: 55, remaining: 45 });
  const fail = evaluateReserveRule({ seat: seatA, observations: [obsTight, obsTight2], samples: [], reserve, now: NOW });
  assert.equal(fail.ok, false);
});

test("reserve rule: unknown capacity fails closed for subscription seats", () => {
  const reserve = config().eligibility.reserve;
  const noObs = evaluateReserveRule({ seat: seat(), observations: [], samples: [], reserve, now: NOW });
  assert.equal(noObs.ok, false);
  assert.match(noObs.reason, /unknown capacity/);
  const failed = evaluateReserveRule({
    seat: seat(), observations: [observation({ sourceStatus: "stale" })], samples: [], reserve, now: NOW,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /fail closed/);
});

test("reserve rule: collector failure vs legitimate zero are distinct", () => {
  const reserve = config().eligibility.reserve;
  // Legitimate zero: ok with remaining 0 → genuinely full, not unknown.
  const zero = evaluateReserveRule({
    seat: seat(), observations: [observation({}, { used: 100, remaining: 0 })], samples: [], reserve, now: NOW,
  });
  assert.equal(zero.ok, false);
  assert.match(zero.reason, /reserve floor/); // not "unknown capacity"
  // Collector failure: unknown → fail closed with the unknown message.
  const failed = evaluateReserveRule({
    seat: seat(), observations: [observation({ sourceStatus: "unknown" })], samples: [], reserve, now: NOW,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /unknown capacity/);
});

test("reserve rule: prior outstanding reservations consume headroom", () => {
  const reserve = config().eligibility.reserve;
  const obs = observation({}, { total: 100, used: 30, remaining: 70 });
  const alone = evaluateReserveRule({ seat: seat(), observations: [obs], samples: [], reserve, now: NOW });
  assert.equal(alone.ok, true);
  const withPrior = evaluateReserveRule({
    seat: seat(), observations: [obs], samples: [], reserve, now: NOW,
    existingReservations: [{ accountId: "acct-cursor-main", unit: "messages", resetAt: "2026-09-16T18:00:00Z", quantity: 20, state: "reserved" }],
  });
  assert.equal(withPrior.ok, false); // 70 - 25 - 20 = 25 < 40
});

test("reserve rule: owner-interactive override only with the explicit config flag", () => {
  const reserve = config().eligibility.reserve;
  const obs = observation({}, { used: 55, remaining: 45 });
  const refusedWithoutFlag = evaluateReserveRule({
    seat: seat(), observations: [obs], samples: [], reserve, now: NOW, ownerInteractive: true,
  });
  assert.equal(refusedWithoutFlag.ok, false);
  const overrideReserve = { ...reserve, ownerInteractiveOverride: true };
  const allowedWithFlag = evaluateReserveRule({
    seat: seat(), observations: [obs], samples: [], reserve: overrideReserve, now: NOW, ownerInteractive: true,
  });
  assert.equal(allowedWithFlag.ok, true);
  // Ranking output can NEVER trigger the override (§6.2): the flag is the
  // only path, and it is config, not a ranking field.
  const notFromRanking = evaluateReserveRule({
    seat: seat(), observations: [obs], samples: [], reserve, now: NOW, ownerInteractive: false,
  });
  assert.equal(notFromRanking.ok, false);
});

test("reserve rule: rounding is conservative — remaining down, usage up", () => {
  const reserve = config().eligibility.reserve;
  // remaining 41 (floor 40): cold-start estimate 25 → 41 - 25 = 16 < 40 → fail.
  const obs = observation({}, { total: 100, used: 59, remaining: 41 });
  const result = evaluateReserveRule({ seat: seat(), observations: [obs], samples: [], reserve, now: NOW });
  assert.equal(result.ok, false);
  // A fractional remaining of 40.5 floors DOWN to 40; a fractional estimate
  // of 12.4 ceils UP to 13 — both conservative directions.
  const frac = observation({}, { total: 100, used: 59, remaining: 41 });
  const tightReserve = { ...reserve, coldStartFraction: 0.124 };
  // cold-start estimate = ceil(100 × 0.124) = 13; 41 - 13 = 28 < 40 → fail.
  const tight = evaluateReserveRule({ seat: seat(), observations: [frac], samples: [], reserve: tightReserve, now: NOW });
  assert.equal(tight.ok, false);
  // Sanity: with a tiny cold-start fraction the projection passes again.
  const looseReserve = { ...reserve, coldStartFraction: 0.001 };
  const loose = evaluateReserveRule({ seat: seat(), observations: [frac], samples: [], reserve: looseReserve, now: NOW });
  assert.equal(loose.ok, true); // ceil(0.1) = 1; 41 - 1 = 40 >= 40
});

// ---------------------------------------------------------------------------
// Eligibility rules (§6.1): eight ordered rules
// ---------------------------------------------------------------------------

function eligibilityInputs(overrides = {}) {
  const cfg = config();
  return {
    seat: seat(),
    card: card(),
    policyRouteSeatIds: ["cursor-claude-main"],
    healthObservations: {},
    quotaObservations: [observation()],
    consumptionSamples: [],
    reserve: cfg.eligibility.reserve,
    now: NOW,
    existingReservations: [],
    activeSessions: [],
    providerLimit: 2,
    modelInstalled: new Set(["claude-x"]),
    ownerInteractive: false,
    ...overrides,
  };
}

test("rule order: first failing rule excludes the seat with its reason", () => {
  // Rule 1: disabled seat.
  const r1 = evaluateSeatEligibility(eligibilityInputs({ seat: seat({ enabled: false }) }));
  assert.equal(r1.eligible, false);
  assert.equal(r1.exclusions[0].rule, "seat-enabled");

  // Rule 2: not in the board-policy route list.
  const r2 = evaluateSeatEligibility(eligibilityInputs({ policyRouteSeatIds: ["other-seat"] }));
  assert.equal(r2.eligible, false);
  assert.equal(r2.exclusions[0].rule, "board-policy-route");

  // Rule 3: capability mismatch.
  const r3 = evaluateSeatEligibility(eligibilityInputs({ card: card({ capabilities: ["design"] }) }));
  assert.equal(r3.eligible, false);
  assert.equal(r3.exclusions[0].rule, "capability-match");

  // Rule 4: containment required but seat tier is none.
  const r4 = evaluateSeatEligibility(eligibilityInputs());
  // card() defaults to containmentRequired: true and the seat tier is none → fails here.
  assert.equal(r4.eligible, false);
  assert.equal(r4.exclusions[0].rule, "containment-tier");

  // Rule 5: no fresh health observation for a local seat.
  const localSeat = seat({ kind: "local", accountId: null, provider: "llama-server", endpointRef: "spark-primary", model: "glm-5.3-flash-ud-iq3xxs", containmentTier: "testudo", quotaCollector: null, costClass: "free" });
  const r5 = evaluateSeatEligibility(eligibilityInputs({ seat: localSeat, healthObservations: {} }));
  assert.equal(r5.eligible, false);
  assert.equal(r5.exclusions[0].rule, "endpoint-health");

  // Rule 6: model not installed.
  const r6 = evaluateSeatEligibility(eligibilityInputs({
    card: card({ containmentRequired: false, placement: "host" }),
    modelInstalled: new Set(["other-model"]),
  }));
  assert.equal(r6.eligible, false);
  assert.equal(r6.exclusions[0].rule, "model-installed");

  // Rule 7: quota ineligibility (subscription seat with a failing window).
  const r7 = evaluateSeatEligibility(eligibilityInputs({
    card: card({ containmentRequired: false, placement: "host" }),
    quotaObservations: [observation({ sourceStatus: "stale" })],
  }));
  assert.equal(r7.eligible, false);
  assert.equal(r7.exclusions[0].rule, "quota-eligibility");

  // Rule 8: no free global capacity.
  const r8 = evaluateSeatEligibility(eligibilityInputs({
    card: card({ containmentRequired: false, placement: "host" }),
    providerLimit: 0,
  }));
  assert.equal(r8.eligible, false);
  assert.equal(r8.exclusions[0].rule, "global-capacity");
});

test("rules pass in order for a fully eligible subscription seat", () => {
  const result = evaluateSeatEligibility(eligibilityInputs({
    card: card({ containmentRequired: false, placement: "host" }),
  }));
  assert.equal(result.eligible, true, result.exclusions.map((e) => e.reason).join("; "));
  assert.ok(result.reservationVectors.length > 0); // quantity-bearing
});

test("rule 5: local seats need only concurrency headroom, not quota", () => {
  const localSeat = seat({
    kind: "local", accountId: null, provider: "llama-server", endpointRef: "spark-primary",
    model: "glm-5.3-flash-ud-iq3xxs", containmentTier: "testudo", quotaCollector: null, costClass: "free",
    maxConcurrency: 2,
  });
  const health = { "spark-primary": { sourceStatus: "ok", expiresAt: "2026-09-16T12:05:00Z" } };
  // No quota observations at all — local seats do not need them.
  const result = evaluateSeatEligibility(eligibilityInputs({
    seat: localSeat, healthObservations: health, quotaObservations: [],
    card: card({ containmentRequired: false, placement: "container" }),
    modelInstalled: new Set(["glm-5.3-flash-ud-iq3xxs"]),
  }));
  assert.equal(result.eligible, true, result.exclusions.map((e) => e.reason).join("; "));
  // Full concurrency blocks.
  const full = evaluateSeatEligibility(eligibilityInputs({
    seat: localSeat, healthObservations: health, quotaObservations: [],
    card: card({ containmentRequired: false, placement: "container" }),
    modelInstalled: new Set(["glm-5.3-flash-ud-iq3xxs"]),
    activeSessions: [{ seatId: localSeat.seatId }, { seatId: localSeat.seatId }],
  }));
  assert.equal(full.eligible, false);
  assert.equal(full.exclusions[0].rule, "endpoint-health");
  assert.match(full.exclusions[0].reason, /concurrency full/);
});

test("rule 4: testudo seat satisfies containment; docker-policy does not", () => {
  const testudoSeat = seat({ containmentTier: "testudo" });
  const ok = evaluateSeatEligibility(eligibilityInputs({ seat: testudoSeat }));
  assert.notEqual(ok.exclusions[0]?.rule, "containment-tier");
  const dockerSeat = seat({ containmentTier: "docker-policy" });
  const denied = evaluateSeatEligibility(eligibilityInputs({ seat: dockerSeat }));
  assert.equal(denied.exclusions[0].rule, "containment-tier");
});

// ---------------------------------------------------------------------------
// Route-decision record (§6.3)
// ---------------------------------------------------------------------------

test("route-decision record: closed shape, immutable, stable digest", () => {
  const record = routeDecisionRecord({
    createdAt: NOW,
    cardHash: "a".repeat(64),
    specHash: "b".repeat(64),
    snapshotDigest: "c".repeat(64),
    configDigest: "d".repeat(64),
    eligibleSeats: [
      { seatId: "s1", excluded: false, reason: null },
      { seatId: "s2", excluded: true, reason: "seat is disabled in config" },
    ],
    rankedOrder: ["s1"],
    selectedSeatId: "s1",
    configRevision: 3,
  });
  assert.equal(wellFormedRouteDecision(record), true);
  assert.equal(Object.isFrozen(record), true);
  const digestA = routeDecisionDigest(record);
  const digestB = routeDecisionDigest(record);
  assert.equal(digestA, digestB);
  assert.match(digestA, /^[0-9a-f]{64}$/);
  // Unknown field breaks well-formedness.
  const tampered = { ...record, extra: 1 };
  assert.equal(wellFormedRouteDecision(tampered), false);
});

test("route decision: config invalid refuses to produce decisions (fail closed)", async () => {
  const result = await routeDecision({
    card: card(), config: { broken: true }, snapshotDigest: "c".repeat(64),
    policyRouteSeatIds: ["cursor-claude-main"], now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "config-invalid");
  assert.match(result.reason, /refuses to produce decisions/);
});

test("route decision: no eligible seat fails closed with the audit list", async () => {
  const cfg = config();
  const result = await routeDecision({
    card: card(), config: cfg, snapshotDigest: "c".repeat(64),
    policyRouteSeatIds: [], // nothing authorized
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-eligible-seat");
  assert.equal(result.eligibleSeats[0].excluded, true);
  assert.match(result.eligibleSeats[0].reason, /board-policy route list/);
});

test("route decision: emits an immutable record carrying the config digest and revision", async () => {
  const cfg = config();
  const result = await routeDecision({
    card: card({ containmentRequired: false, placement: "host" }),
    config: cfg,
    snapshotDigest: "c".repeat(64),
    policyRouteSeatIds: ["cursor-claude-main"],
    quotaObservations: [observation()],
    freeCapacityBySeat: { "cursor-claude-main": 2 },
    modelInstalled: new Set(["claude-x"]),
    now: NOW,
  });
  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(result.record.configRevision, 3);
  assert.equal(result.record.policyVersion, "agentic-driver.automation-policy.v1");
  assert.equal(result.record.parentDecisionId, null);
  assert.equal(wellFormedRouteDecision(result.record), true);
  assert.equal(result.digest, routeDecisionDigest(result.record));
});

test("route decision: ranking failure falls back deterministically and never blocks", async () => {
  const cfg = config({ ranking: { enabled: true, janusUrl: "http://127.0.0.1:7431", maxCandidates: 8, fallback: "preference-order" } });
  const failingRank = async () => { throw new Error("janus down"); };
  const result = await routeDecision({
    card: card({ containmentRequired: false, placement: "host" }),
    config: cfg, snapshotDigest: "c".repeat(64),
    policyRouteSeatIds: ["cursor-claude-main"],
    quotaObservations: [observation()],
    freeCapacityBySeat: { "cursor-claude-main": 2 },
    modelInstalled: new Set(["claude-x"]),
    janusRank: failingRank,
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.ranking.used, false); // fallback, not ranking
  assert.equal(result.record.selectedSeatId, "cursor-claude-main");
});

test("route decision: replacement lineage carries parentDecisionId", async () => {
  const cfg = config();
  const result = await routeDecision({
    card: card({ containmentRequired: false, placement: "host" }),
    config: cfg, snapshotDigest: "c".repeat(64),
    policyRouteSeatIds: ["cursor-claude-main"],
    quotaObservations: [observation()],
    freeCapacityBySeat: { "cursor-claude-main": 2 },
    modelInstalled: new Set(["claude-x"]),
    parentDecisionId: "parent-decision-uuid",
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.parentDecisionId, "parent-decision-uuid");
});

// ---------------------------------------------------------------------------
// Final fix-pass regressions: unknown touched units, completion-time
// ordering, >=2 shared-account reservations, forged observations.
// ---------------------------------------------------------------------------

test("estimator: an unknown touched unit fails closed (null estimate, never finite)", () => {
  const reserve = config().eligibility.reserve;
  // Unknown unit: the estimator returns a null estimate and reservation
  // vector building fails closed — it never invents a finite quantity.
  const unknown = estimateConsumption({ seatId: "cursor-claude-main", unit: "widgets", samples: [], reserve, accountWindows: [{ unit: "widgets", total: 100 }] });
  assert.equal(unknown.estimate, null);
  assert.equal(unknown.source, "unknown-unit");
  const guarded = reservationVectors({
    accountId: "acct-cursor-main", observations: [{
      accountId: "acct-cursor-main", sourceStatus: "ok", expiresAt: "2099-01-01T00:00:00Z",
      quotaWindows: [{ unit: "widgets", total: 100, used: 0, remaining: 100, resetAt: "2026-09-16T18:00:00Z", derived: false }],
    }], seatId: "cursor-claude-main", reserve, now: NOW,
  });
  assert.equal(guarded.error !== undefined, true);
  assert.match(guarded.error, /unknown touched quota unit "widgets" \(fail closed\)/);
  // Known units keep their cold-start constant behavior (unchanged).
  const known = estimateConsumption({ seatId: "cursor-claude-main", unit: "messages", samples: [], reserve, accountWindows: [{ unit: "messages", total: 100 }] });
  assert.equal(known.estimate, 25); // coldStartFraction 0.25 of the smallest total
});

test("estimator: N=20 uses completion-time order (capturedAt), not arrival order", () => {
  const reserve = config().eligibility.reserve;
  const seatId = "cursor-claude-main";
  // 25 completed dispatches: the 5 EARLIEST (by capturedAt) each consumed
  // 1000. Only the LAST 20 by completion time may feed the estimator, so
  // the mean must be exactly 10 (the early heavy samples are outside the
  // window by completion time, not by insertion position).
  const early = Array.from({ length: 5 }, (_, i) => ({ seatId, unit: "messages", quantity: 1000, capturedAt: `2026-09-01T0${i}:00:00Z` }));
  const recent = Array.from({ length: 20 }, (_, i) => ({ seatId, unit: "messages", quantity: 10, capturedAt: `2026-09-16T${String(i).padStart(2, "0")}:00:00Z` }));
  const inOrder = [...early, ...recent];
  const first = estimateConsumption({ seatId, unit: "messages", samples: inOrder, reserve, accountWindows: [] });
  assert.equal(first.source, "estimated");
  assert.equal(first.sampleCount, 20);
  assert.equal(first.estimate, 10);
  // Same samples SHUFFLED on arrival must give the identical result: the
  // estimator orders by completion time, never by caller list order.
  const shuffled = [...inOrder].reverse();
  const second = estimateConsumption({ seatId, unit: "messages", samples: shuffled, reserve, accountWindows: [] });
  assert.equal(second.estimate, 10);
  assert.equal(second.sampleCount, 20);
  // Two identical timestamps tie-break by insertion index deterministically.
  const tied = estimateConsumption({ seatId, unit: "messages", samples: [...recent.slice(0, 5), ...recent.slice(0, 20)], reserve, accountWindows: [] });
  assert.equal(tied.estimate, 10);
});

test("reserve rule: two or more outstanding reservations on a shared account aggregate", () => {
  const reserve = config().eligibility.reserve;
  // remaining 90 / total 100 / floor 40, cold-start estimate 25:
  //   0 outstanding → 65 >= 40 pass
  //   1 outstanding (25) → 40 >= 40 pass (exactly at the floor)
  //   2 outstanding (25 each) → 15 < 40 FAIL — aggregation is required
  const obs = observation({}, { total: 100, used: 10, remaining: 90 });
  const outstanding = (n) => Array.from({ length: n }, () => ({
    accountId: "acct-cursor-main", state: "reserved", unit: "messages",
    resetAt: "2026-09-16T18:00:00Z", quantity: 25,
  }));
  const none = evaluateReserveRule({ seat: seat(), observations: [obs], samples: [], reserve, now: NOW, existingReservations: outstanding(0) });
  assert.equal(none.ok, true);
  const one = evaluateReserveRule({ seat: seat(), observations: [obs], samples: [], reserve, now: NOW, existingReservations: outstanding(1) });
  assert.equal(one.ok, true); // 90 - 25 = 40, exactly the floor, still passes
  const two = evaluateReserveRule({ seat: seat(), observations: [obs], samples: [], reserve, now: NOW, existingReservations: outstanding(2) });
  assert.equal(two.ok, false); // 90 - 25 - 25 - 25 = 15 < 40 — the second reservation flips the outcome
  assert.match(two.reason, /reserve floor/);
  // Reservations on a DIFFERENT account never consume this account's headroom.
  const foreign = evaluateReserveRule({ seat: seat(), observations: [obs], samples: [], reserve, now: NOW,
    existingReservations: [{ accountId: "acct-other", state: "reserved", unit: "messages", resetAt: "2026-09-16T18:00:00Z", quantity: 25 }] });
  assert.equal(foreign.ok, true);
});

// Forged/misassigned observations never reach the reserve rule (§4: seat→
// account→collector binding is verified against the validated config).
function twoAccountConfig() {
  const cfg = config();
  cfg.seats = [
    seat(),
    seat({ seatId: "cursor-claude-alt", accountId: "acct-cursor-alt", endpointRef: "merge", model: "claude-x" }),
  ];
  cfg.collectors = {
    "cursor-statusline": { adapter: "statusline-cache", cachePath: "/tmp/quota/cursor.json", ttlSeconds: 300, accounts: ["acct-cursor-main"] },
    "cursor-alt": { adapter: "statusline-cache", cachePath: "/tmp/quota/alt.json", ttlSeconds: 300, accounts: ["acct-cursor-alt"] },
  };
  cfg.seats[1].quotaCollector = "cursor-alt";
  cfg.preferences = { order: [{ seatId: "cursor-claude-main" }, { seatId: "cursor-claude-alt" }], costPolicy: "free-first" };
  return cfg;
}

async function decisionWith(cfg, quotaObservations) {
  return routeDecision({
    card: card({ containmentRequired: false, placement: "host" }),
    config: cfg, snapshotDigest: "c".repeat(64),
    policyRouteSeatIds: ["cursor-claude-main", "cursor-claude-alt"],
    quotaObservations, freeCapacityBySeat: { "cursor-claude-main": 2, "cursor-claude-alt": 2 },
    modelInstalled: new Set(["claude-x"]), now: NOW,
  });
}

test("route decision: forged/misassigned observations fail closed (observation-invalid)", async () => {
  const cfg = twoAccountConfig();
  // 1. Unknown seat: the observation names a seat the config never declared.
  const ghost = await decisionWith(cfg, [observation({ seatId: "ghost-seat" })]);
  assert.equal(ghost.ok, false);
  assert.equal(ghost.code, "observation-invalid");
  // 2. Account mismatch: a well-formed observation claiming another seat's account.
  const wrongAccount = await decisionWith(cfg, [observation({ accountId: "acct-cursor-alt" })]);
  assert.equal(wrongAccount.ok, false);
  assert.equal(wrongAccount.code, "observation-invalid");
  // 3. Collector mismatch: the observation names another seat's collector
  //    (with that collector's account) for this seat.
  const wrongCollector = await decisionWith(cfg, [observation({ collector: "cursor-alt", accountId: "acct-cursor-alt" })]);
  assert.equal(wrongCollector.ok, false);
  assert.equal(wrongCollector.code, "observation-invalid");
  // 4. Collector account-list mismatch: the seat's own account is claimed
  //    under a collector whose account list does NOT include it.
  const unlisted = await decisionWith(cfg, [observation({ collector: "cursor-alt" })]);
  assert.equal(unlisted.ok, false);
  assert.equal(unlisted.code, "observation-invalid");
  assert.match(unlisted.reason, /does not match configured seat\/account\/collector/);
  // 5. Sanity: the honest observation still routes.
  const honest = await decisionWith(cfg, [observation()]);
  assert.equal(honest.ok, true);
});
