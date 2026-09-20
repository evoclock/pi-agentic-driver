// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Router defect-fix regression tests (independent verification review):
//   W2 localHealth probe adapter → local-seat eligibility
//   W3 per-tick runtime refresh
//   W4 read-only `check` (no SQLite writes)
//   L1 terminal-claim reservation settlement
//   R1 decision-derived replacement route fidelity
//   R2 dead-route enforcement in the replacement writer
//   W6 defaults template loads out of the box

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeCard, automationPolicyPath, claimCard, consumeEnvelope, replaceAttempt,
  canonicalJsonString, sha256Hex,
} from "../scripts/enforcement/task_board_core_pi.js";
import {
  ROUTER_CONFIG_SCHEMA, QUOTA_OBSERVATION_SCHEMA, SEAT_SCHEMA, validateRouterConfig,
  writeCollectorCacheAtomic,
} from "../scripts/enforcement/router_schemas_pi.js";
import { routeDecision } from "../scripts/enforcement/router_engine_pi.js";
import {
  openRouterStore, closeRouterStore, createReservation, claimReservation, getReservation,
  activeReservations, insertRouteDecision,
} from "../scripts/enforcement/router_store_pi.js";
import {
  prepareRouterRuntime, prepareRouterRuntimeWithHealth, probeLocalHealth,
  loadRouterConfig, ROUTER_DEFAULTS_RELATIVE_PATH,
} from "../scripts/enforcement/router_runtime_pi.js";
import { pulseTick } from "../scripts/enforcement/pulse_scheduler_pi.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authority = { source: "instruction", sessionOrReportId: "sess-defect", quotedInstruction: "write the card" };
const HEX = (c) => c.repeat(64);
const NOW = "2026-09-16T12:00:00.000Z";

function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

function freshDir(prefix = "router-defects-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitRepo(dir) {
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  writeFileSync(join(dir, "f.txt"), "one\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

function baseReserve() {
  return { floorPercent: 40, scope: "account-window", coldStartFraction: 0.25,
    estimateSamples: 20, estimateMinSamples: 5, estimateOutlierSigma: 3, ownerInteractiveOverride: false };
}

function baseConfig(overrides = {}) {
  return {
    schema: ROUTER_CONFIG_SCHEMA, revision: 1,
    endpoints: {}, seats: [], models: {}, collectors: {},
    eligibility: { rules: [], reserve: baseReserve() },
    preferences: { order: [], costPolicy: "free-first" },
    ranking: { enabled: false, janusUrl: "http://127.0.0.1:7431", maxCandidates: 8, fallback: "preference-order" },
    localHealth: { probeSeconds: 60, warmStateTracking: true },
    secrets: {},
    ...overrides,
  };
}

// A local DGX-style cluster seat spanning two endpoint nodes (§8.12).
function localClusterConfig() {
  const model = "local/cluster-model";
  return baseConfig({
    endpoints: {
      "spark-primary": { url: "http://127.0.0.1:8893", kind: "llama-server" },
      "spark-secondary": { url: "http://127.0.0.1:8894", kind: "llama-server" },
    },
    seats: [{
      schema: SEAT_SCHEMA, seatId: "spark-cluster", kind: "local", provider: "llama-server",
      accountId: null, endpointRef: "spark-primary", model, capabilities: ["implement"],
      containmentTier: "none", maxConcurrency: 2, costClass: "free", quotaCollector: null,
      clusterMembership: { clusterId: "dgx-sparks", nodes: ["spark-primary", "spark-secondary"], spansNodes: true },
      enabled: true, deprecated: null,
    }],
    models: { [model]: { aliases: [], contextWindow: 131072, capabilities: ["implement"] } },
    preferences: { order: [{ seatId: "spark-cluster" }], costPolicy: "free-first" },
  });
}

function subscriptionConfig(cachePath) {
  const model = "anthropic/claude-x";
  return baseConfig({
    endpoints: { cursor: { url: "https://cursor.example.invalid/v1", kind: "anthropic" } },
    seats: [{
      schema: SEAT_SCHEMA, seatId: "cursor-main", kind: "subscription", provider: "anthropic",
      accountId: "acct-main", endpointRef: "cursor", model, capabilities: ["implement"],
      containmentTier: "none", maxConcurrency: 2, costClass: "high", quotaCollector: "cursor-statusline",
      clusterMembership: null, enabled: true, deprecated: null,
    }],
    models: { [model]: { aliases: [], contextWindow: 100000, capabilities: ["implement"] } },
    collectors: { "cursor-statusline": { adapter: "statusline-cache", cachePath, ttlSeconds: 300, accounts: ["acct-main"] } },
    preferences: { order: [{ seatId: "cursor-main" }], costPolicy: "free-first" },
  });
}

function quotaObservation(overrides = {}) {
  return {
    schema: QUOTA_OBSERVATION_SCHEMA, collector: "cursor-statusline", schemaVersion: 1,
    seatId: "cursor-main", accountId: "acct-main",
    capturedAt: "2026-09-16T11:58:00.000Z", expiresAt: "2026-09-16T12:05:00.000Z", generation: 1,
    quotaWindows: [{ unit: "messages", total: 100, used: 10, remaining: 90, resetAt: "2026-09-16T18:00:00.000Z", derived: false }],
    concurrency: { active: 0, limit: 2 }, confidence: "high", sourceStatus: "ok", parseErrors: [],
    ...overrides,
  };
}

function cardFixture(overrides = {}) {
  return { cardId: "T-1", title: "Card 1", role: "implementer", capabilities: ["implement"],
    placement: "host", effort: "default", hash: HEX("a"), specHash: HEX("b"), ...overrides };
}

// ---------------------------------------------------------------------------
// W2: localHealth probe adapter
// ---------------------------------------------------------------------------

test("W2: a local seat becomes eligible with a fresh ok probe and ineligible when the probe fails", async () => {
  const config = localClusterConfig();
  assert.equal(validateRouterConfig(config).ok, true);
  const okFetch = async (url) => ({ ok: true, status: 200, json: async () => ({ status: "ok", memory: { free: 8_000_000_000, total: 16_000_000_000 }, concurrency: { active: 0, limit: 2 }, warm: true }) });
  const health = await probeLocalHealth({ config, now: NOW, fetchFn: okFetch });
  assert.equal(health.observations["spark-primary"].sourceStatus, "ok");
  assert.equal(health.observations["spark-secondary"].sourceStatus, "ok");
  assert.equal(health.observations["spark-primary"].expiresAt, "2026-09-16T12:01:00.000Z");

  const eligible = await routeDecision({
    card: cardFixture(), config, snapshotDigest: HEX("c"),
    policyRouteSeatIds: ["spark-cluster"], healthObservations: health.observations,
    modelInstalled: new Set(["local/cluster-model"]), freeCapacityBySeat: { "spark-cluster": 2 }, now: NOW,
  });
  assert.equal(eligible.ok, true, eligible.reason);

  // A failed probe is never ok, and the seat is excluded with a clear reason.
  const failFetch = async (url) => {
    if (url.includes(":8893")) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };
  const failed = await probeLocalHealth({ config, now: NOW, fetchFn: failFetch });
  assert.notEqual(failed.observations["spark-primary"].sourceStatus, "ok");
  const excluded = await routeDecision({
    card: cardFixture(), config, snapshotDigest: HEX("c"),
    policyRouteSeatIds: ["spark-cluster"], healthObservations: failed.observations,
    modelInstalled: new Set(["local/cluster-model"]), freeCapacityBySeat: { "spark-cluster": 2 }, now: NOW,
  });
  assert.equal(excluded.ok, false);
  assert.equal(excluded.code, "no-eligible-seat");
  assert.match(excluded.eligibleSeats[0].reason, /fresh ok health observation/);
});

test("W2: a staled probe expires at read time and a non-ok body is not fabricated ok", async () => {
  const config = localClusterConfig();
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) });
  const health = await probeLocalHealth({ config, now: NOW, fetchFn: okFetch });
  // probeSeconds = 60: one second past expiry the read-time freshness fails.
  const stale = await routeDecision({
    card: cardFixture(), config, snapshotDigest: HEX("c"),
    policyRouteSeatIds: ["spark-cluster"], healthObservations: health.observations,
    modelInstalled: new Set(["local/cluster-model"]), freeCapacityBySeat: { "spark-cluster": 2 },
    now: "2026-09-16T12:01:01.000Z",
  });
  assert.equal(stale.ok, false);
  assert.match(stale.eligibleSeats[0].reason, /fresh ok health observation/);
  // A 200 whose body reports a non-ok status is a failed probe, not alive.
  const badBody = await probeLocalHealth({ config, now: NOW, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ status: "loading" }) }) });
  assert.equal(badBody.observations["spark-primary"].sourceStatus, "unreachable");
});

test("W2: a spanning cluster seat requires BOTH nodes ready", async () => {
  const config = localClusterConfig();
  const oneNodeDown = async (url) => {
    if (url.includes(":8894")) return { ok: true, status: 200, json: async () => ({ status: "error" }) };
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };
  const health = await probeLocalHealth({ config, now: NOW, fetchFn: oneNodeDown });
  assert.notEqual(health.observations["spark-primary"].sourceStatus, "ok");
  assert.match(health.observations["spark-primary"].reason, /not ready/);
  const decision = await routeDecision({
    card: cardFixture(), config, snapshotDigest: HEX("c"),
    policyRouteSeatIds: ["spark-cluster"], healthObservations: health.observations,
    modelInstalled: new Set(["local/cluster-model"]), freeCapacityBySeat: { "spark-cluster": 2 }, now: NOW,
  });
  assert.equal(decision.ok, false);
});

test("W2: prepareRouterRuntimeWithHealth attaches endpoint-keyed healthObservations", async () => {
  const dir = freshDir();
  try {
    const defaultsPath = join(dir, "router.defaults.json");
    writeFileSync(defaultsPath, JSON.stringify(localClusterConfig()));
    const runtime = await prepareRouterRuntimeWithHealth({
      repoRoot: dir, defaultsPath, profilePath: join(dir, "absent.json"),
      dbPath: join(dir, "state.db"), now: NOW, readOnly: true,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }),
    });
    assert.equal(runtime.routerSnapshot.healthObservations["spark-primary"].sourceStatus, "ok");
    assert.equal(runtime.routerReadOnly, true);
    assert.equal(runtime.routerStore, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// W3: per-tick runtime refresh
// ---------------------------------------------------------------------------

test("W3: pulseTick refreshes the runtime per tick and a later tick reads fresh state", async () => {
  const dir = freshDir();
  try {
    gitRepo(dir);
    const boardPath = join(dir, "TASKS.md");
    const { writeCard: wc, automationPolicyPath: app } = { writeCard, automationPolicyPath };
    assert.equal(wc({ boardPath, input: { title: "Card 1", spec: "s", definitionOfDone: "d", stoppingPoint: "t", scope: ["src/"], priority: "P1" }, authority }).ok, true);
    const model = "anthropic/claude-x";
    writeFileSync(app(boardPath), JSON.stringify({
      roles: ["implementer"], placement: "container", maxConcurrent: 4, expiry: "2030-01-01T00:00:00.000Z",
      board: boardPath, riskCeiling: "medium", acceptedRepositories: [dir],
      pulse: { enabled: true, mode: "automated", intervalSeconds: 300, fillOnStart: false,
        routing: { implementer: { preferred: [{ model, maxConcurrent: 4 }], fallback: [], maxConcurrent: 4 } },
        stallTimeoutSeconds: 600, unattendedHostRiskAccepted: false },
    }));
    const config = subscriptionConfig(join(dir, "quota.json"));
    const registry = { get: (id) => id === model ? { id } : null, isAuthenticated: () => true };
    const buildSnapshot = (observation) => ({ quotaObservations: [observation], healthObservations: {}, modelInstalled: new Set([model]) });
    const expired = quotaObservation({ quotaWindows: [] , sourceStatus: "stale", expiresAt: "2026-09-16T11:00:00.000Z" });
    const fresh = quotaObservation({ capturedAt: "2026-09-16T11:59:00.000Z" });
    const base = { modelRegistry: registry, scopedModels: [model], routerConfig: config };
    let calls = 0;
    const first = await pulseTick({ boardPath, now: NOW, spawnWorker: async () => ({ ok: true }),
      context: base, routerRuntimeFor: () => { calls += 1; return { routerSnapshot: buildSnapshot(expired) }; } });
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.code, "route-unavailable");
    // The second tick asks again: the factory re-reads and returns fresh state.
    const second = await pulseTick({ boardPath, now: NOW, spawnWorker: async () => ({ ok: true }),
      context: base, routerRuntimeFor: () => { calls += 1; return { routerSnapshot: buildSnapshot(fresh) }; } });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(calls, 2, "the runtime factory is invoked per tick, never frozen");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// W4: read-only check performs no SQLite writes
// ---------------------------------------------------------------------------

test("W4: a read-only runtime writes nothing, expires nothing, and creates no store", () => {
  const dir = freshDir();
  try {
    const defaultsPath = join(dir, "router.defaults.json");
    const cacheRoot = join(dir, "quota");
    mkdirSync(cacheRoot, { recursive: true });
    const cachePath = join(cacheRoot, "cursor.json");
    const config = subscriptionConfig(cachePath);
    writeFileSync(defaultsPath, JSON.stringify(config));
    writeCollectorCacheAtomic({ cachePath, trustedRoot: cacheRoot, value: quotaObservation() });

    const dbPath = join(dir, "state.db");
    const seed = openRouterStore({ dbPath });
    // A stale unclaimed reservation (write mode would expire it) and a claimed
    // reservation bound to a claim that is neither active nor consumed.
    createReservation(seed, { reservationId: "res-stale", decisionId: "d1", seatId: "cursor-main",
      accountId: "acct-main", vectors: [{ windowId: "w1", unit: "messages", quantity: 5 }],
      now: "2026-09-16T10:00:00.000Z", ttlSeconds: 60 });
    createReservation(seed, { reservationId: "res-claimed", decisionId: "d2", seatId: "cursor-main",
      accountId: "acct-main", vectors: [{ windowId: "w1", unit: "messages", quantity: 5 }], now: NOW });
    claimReservation(seed, { reservationId: "res-claimed", claimId: HEX("d").slice(0, 32), envelopeId: HEX("e").slice(0, 32), now: NOW });
    closeRouterStore(seed);

    const runtime = prepareRouterRuntime({ repoRoot: dir, defaultsPath, profilePath: join(dir, "absent.json"),
      dbPath, cacheRoot, now: NOW, readOnly: true });
    assert.equal(runtime.routerStore, null, "check must not return a write store");
    assert.equal(runtime.routerSnapshot.quotaObservations.length, 1, "the cache is still read");

    const after = openRouterStore({ dbPath });
    try {
      assert.equal(getReservation(after, "res-stale").state, "reserved", "read-only never expires");
      assert.equal(getReservation(after, "res-claimed").state, "claimed", "read-only never settles");
      const observations = after.db.prepare("SELECT COUNT(*) AS n FROM quota_observations").get();
      assert.equal(observations.n, 0, "read-only never persists observations");
    } finally { closeRouterStore(after); }

    // A read-only runtime with no store file must not create one.
    const missingDb = join(dir, "missing", "state.db");
    const missingRuntime = prepareRouterRuntime({ repoRoot: dir, defaultsPath, profilePath: join(dir, "absent.json"),
      dbPath: missingDb, cacheRoot, now: NOW, readOnly: true });
    assert.equal(missingRuntime.routerSnapshot.existingReservations.length, 0);
    assert.equal(existsSync(missingDb), false, "read-only check must not create a store");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// L1: terminal-claim settlement
// ---------------------------------------------------------------------------

function boardWithPolicy(dir) {
  gitRepo(dir);
  const boardPath = join(dir, "TASKS.md");
  const r = writeCard({ boardPath, input: { title: "Card 1", spec: "s", definitionOfDone: "d", stoppingPoint: "t", scope: ["src/"], priority: "P0" }, authority });
  assert.equal(r.ok, true, JSON.stringify(r));
  writeFileSync(automationPolicyPath(boardPath), JSON.stringify({
    roles: ["implementer"], placement: "container", maxConcurrent: 4, expiry: "2030-01-01T00:00:00.000Z",
    board: boardPath, riskCeiling: "medium", acceptedRepositories: [dir],
  }));
  return { boardPath, cardId: r.cardId };
}

const settlementRoute = Object.freeze({
  seatId: "cursor-main", accountId: "acct-main", provider: "anthropic", model: "anthropic/claude-x",
  role: "implementer", effort: "default", containmentTier: "none", phase: "implement",
  routeDecisionDigest: "a".repeat(64), reservationId: null,
});

function settleCase(dir, { reason, missingClaim = false }) {
  const { boardPath, cardId } = boardWithPolicy(dir);
  const defaultsPath = join(dir, "router.defaults.json");
  writeFileSync(defaultsPath, JSON.stringify(subscriptionConfig(join(dir, "quota.json"))));
  const dbPath = join(dir, "state.db");
  const store = openRouterStore({ dbPath });
  let envelopeId;
  if (missingClaim) {
    envelopeId = "f".repeat(32);
  } else {
    const claim = claimCard({ boardPath, role: "implementer", cardId, route: { ...settlementRoute, reservationId: "res-settle" } });
    assert.equal(claim.ok, true, claim.reason);
    envelopeId = claim.envelope.envelopeId;
  }
  createReservation(store, { reservationId: "res-settle", decisionId: "dec-1", seatId: "cursor-main",
    accountId: "acct-main", vectors: [{ windowId: "w1", unit: "messages", quantity: 5 }], now: NOW });
  claimReservation(store, { reservationId: "res-settle", claimId: envelopeId, envelopeId, now: NOW });
  closeRouterStore(store);
  if (!missingClaim) {
    const consumed = consumeEnvelope({ boardPath, envelopeId, reason });
    assert.equal(consumed.ok, true, consumed.reason);
  }
  const runtime = prepareRouterRuntime({ repoRoot: dir, defaultsPath, profilePath: join(dir, "absent.json"), boardPath, dbPath, now: NOW });
  closeRouterStore(runtime.routerStore);
  const check = openRouterStore({ dbPath });
  try {
    return { state: getReservation(check, "res-settle").state,
      active: activeReservations(check, { now: NOW }).filter((r) => r.reservationId === "res-settle").length };
  } finally { closeRouterStore(check); }
}

test("L1: a claimed reservation for a consumed claim settles to consumed and leaves activeReservations", () => {
  const dir = freshDir();
  try {
    const consumed = settleCase(dir, { reason: "completed" });
    assert.equal(consumed.state, "consumed");
    assert.equal(consumed.active, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L1: a claimed reservation for a non-completed/released claim settles to released", () => {
  const dir = freshDir();
  try {
    const released = settleCase(dir, { reason: "failed" });
    assert.equal(released.state, "released");
    assert.equal(released.active, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L1: a claimed reservation whose claim is gone is released and never counts as active", () => {
  const dir = freshDir();
  try {
    const gone = settleCase(dir, { reason: "completed", missingClaim: true });
    assert.equal(gone.state, "released");
    assert.equal(gone.active, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// R1/R2: decision-derived replacement route fidelity + dead-route rule
// ---------------------------------------------------------------------------

function replacementConfig(dir) {
  return baseConfig({
    endpoints: {
      spark: { url: "http://127.0.0.1:8893", kind: "llama-server" },
      merge: { url: "https://merge.example.invalid/v1", kind: "merge-gateway" },
    },
    seats: [
      { schema: SEAT_SCHEMA, seatId: "spark", kind: "local", provider: "llama-server", accountId: null,
        endpointRef: "spark", model: "local/m", capabilities: ["implement"], containmentTier: "none",
        maxConcurrency: 2, costClass: "free", quotaCollector: null, clusterMembership: null, enabled: true, deprecated: null },
      { schema: SEAT_SCHEMA, seatId: "merge", kind: "local", provider: "llama-server", accountId: null,
        endpointRef: "merge", model: "local/n", capabilities: ["implement"], containmentTier: "none",
        maxConcurrency: 2, costClass: "free", quotaCollector: null, clusterMembership: null, enabled: true, deprecated: null },
    ],
    models: {
      "local/m": { aliases: [], contextWindow: 100000, capabilities: ["implement"] },
      "local/n": { aliases: [], contextWindow: 100000, capabilities: ["implement"] },
    },
    preferences: { order: [{ seatId: "spark" }, { seatId: "merge" }], costPolicy: "free-first" },
  });
}

function newDecisionRecord({ selectedSeatId, parentDecisionId, digest }) {
  // A schema-valid route-decision record shape is enough for the digest check;
  // the writer cross-checks the digest and the parent linkage.
  return {
    schema: "agentic-driver.route-decision.v1", decisionId: `new-${selectedSeatId}-${digest.slice(0, 6)}`,
    createdAt: NOW, cardHash: HEX("a"), specHash: HEX("b"), snapshotDigest: HEX("c"), configDigest: HEX("d"),
    eligibleSeats: [{ seatId: selectedSeatId, excluded: false, reason: null }],
    rankedOrder: [selectedSeatId], selectedSeatId,
    ranking: { used: false, requestId: null, digest: null },
    policyVersion: "agentic-driver.automation-policy.v1", configRevision: 1,
    reservationId: null, phase: "implement", parentDecisionId,
  };
}

function replacementFixture(dir) {
  const { boardPath, cardId } = boardWithPolicy(dir);
  const routerConfig = replacementConfig(dir);
  const dbPath = join(dir, "state.db");
  const store = openRouterStore({ dbPath });
  const oldDigest = HEX("1");
  const priorId = "prior-decision-1";
  insertRouteDecision(store, {
    record: { decisionId: priorId, createdAt: NOW, cardHash: HEX("a"), selectedSeatId: "spark", parentDecisionId: null },
    digest: oldDigest,
  });
  const claim = claimCard({ boardPath, role: "implementer", cardId,
    route: { seatId: "spark", accountId: null, provider: "llama-server", model: "local/m",
      role: "implementer", effort: "default", containmentTier: "none", phase: "implement",
      routeDecisionDigest: oldDigest, reservationId: null } });
  assert.equal(claim.ok, true, claim.reason);
  return { boardPath, cardId, store, routerConfig, oldEnvelopeId: claim.envelope.envelopeId, priorId };
}

function validReplacementRequest(fx, overrides = {}) {
  const seat = fx.routerConfig.seats.find((s) => s.seatId === "merge");
  const routeDecision = newDecisionRecord({ selectedSeatId: "merge", parentDecisionId: fx.priorId, digest: HEX("2") });
  const digest = sha256Hex(canonicalJsonString(routeDecision));
  const requestedRoute = {
    seatId: seat.seatId, accountId: seat.accountId, provider: seat.provider, model: seat.model,
    role: "implementer", effort: "default", containmentTier: seat.containmentTier, phase: "implement",
    routeDecisionDigest: digest, reservationId: null,
  };
  return {
    route: requestedRoute,
    routeDecision,
    routerConfig: fx.routerConfig,
    routerStore: fx.store,
    healthObservations: { merge: { sourceStatus: "ok", expiresAt: "2026-09-16T12:05:00.000Z" } },
    ...overrides,
  };
}

test("R1: an injected different-seat route (INJECTED-MODEL/openai) is refused", () => {
  const dir = freshDir();
  try {
    const fx = replacementFixture(dir);
    const attempt = replaceAttemptForTest(fx, validReplacementRequest(fx, {
      route: { ...validReplacementRequest(fx).route, model: "INJECTED-MODEL", provider: "openai" },
    }));
    assert.equal(attempt.ok, false, JSON.stringify(attempt));
    assert.equal(attempt.code, "replacement-route-invalid");
    // A merely non-null but wrong parentDecisionId is refused too.
    const wrongParent = replaceAttemptForTest(fx, validReplacementRequest(fx, {
      routeDecision: newDecisionRecord({ selectedSeatId: "merge", parentDecisionId: "not-the-prior", digest: HEX("2") }),
    }));
    assert.equal(wrongParent.ok, false);
    assert.equal(wrongParent.code, "replacement-route-invalid");
    // An unresolved selectedSeatId is refused (no config seat).
    const unknownSeat = replaceAttemptForTest(fx, validReplacementRequest(fx, {
      routeDecision: newDecisionRecord({ selectedSeatId: "ghost", parentDecisionId: fx.priorId, digest: HEX("2") }),
    }));
    assert.equal(unknownSeat.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R1: a valid config-seat-derived replacement is accepted with the correct parentDecisionId linkage", () => {
  const dir = freshDir();
  try {
    const fx = replacementFixture(dir);
    const attempt = replaceAttemptForTest(fx, validReplacementRequest(fx));
    assert.equal(attempt.ok, true, JSON.stringify(attempt));
    assert.equal(attempt.envelope.seatId, "merge");
    assert.equal(attempt.envelope.model, "local/n");
    assert.equal(attempt.envelope.provider, "llama-server");
    assert.equal(attempt.envelope.accountId, null);
    assert.equal(attempt.claim.parentClaimId, fx.oldEnvelopeId);
    assert.equal(attempt.claim.attemptIndex, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R2: a dead target route is refused even when routeHealthy:true is supplied", () => {
  const dir = freshDir();
  try {
    const fx = replacementFixture(dir);
    const dead = replaceAttemptForTest(fx, validReplacementRequest(fx, {
      healthObservations: {}, routeHealthy: true,
    }));
    assert.equal(dead.ok, false, JSON.stringify(dead));
    assert.equal(dead.code, "replacement-route-invalid");
    // A failed health probe is equally dead.
    const failedProbe = replaceAttemptForTest(fx, validReplacementRequest(fx, {
      healthObservations: { merge: { sourceStatus: "unreachable", expiresAt: "2026-09-16T12:05:00.000Z" } },
      routeHealthy: true,
    }));
    assert.equal(failedProbe.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The writer API: replaceAttempt is exported from task_board_core_pi.js.
function replaceAttemptForTest(fx, replacement) {
  return replaceAttempt({ boardPath: fx.boardPath, cardId: fx.cardId, envelopeId: fx.oldEnvelopeId,
    reason: "worker-unresponsive", replacement, now: NOW });
}

// ---------------------------------------------------------------------------
// W6: defaults template loads out of the box
// ---------------------------------------------------------------------------

test("W6: the shipped no-accounts defaults template loads and validates out of the box", () => {
  const template = JSON.parse(readFileSync(join(REPO_ROOT, ROUTER_DEFAULTS_RELATIVE_PATH), "utf8"));
  const validation = validateRouterConfig(template);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(template.seats.some((s) => s.kind === "subscription"), false, "no accounts ship in defaults");
  const loaded = loadRouterConfig({ repoRoot: REPO_ROOT, profilePath: join(REPO_ROOT, ".no-such-profile.json") });
  assert.equal(loaded.profileLoaded, false);
  assert.equal(loaded.configRevision, 1);
  assert.match(loaded.configDigest, /^[0-9a-f]{64}$/);
});
