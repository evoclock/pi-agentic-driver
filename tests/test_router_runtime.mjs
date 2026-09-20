// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Production router runtime tests (ROUTER_DESIGN_TASK68 §3/§8/§10 + the
// final fix pass): the closed loader (profile > repo defaults with digest/
// revision semantics), lifecycle reachability through the production path
// (expired reservations, crash-window reconciliation from authenticated
// claims, consumption ingestion, activeReservations), and the registered
// live tool routing at least one real path through config + store.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeCard, automationPolicyPath, claimCard } from "../scripts/enforcement/task_board_core_pi.js";
import { writeCollectorCacheAtomic, QUOTA_OBSERVATION_SCHEMA } from "../scripts/enforcement/router_schemas_pi.js";
import {
  openRouterStore, closeRouterStore, createReservation, getReservation,
  activeReservations, consumptionSamples,
} from "../scripts/enforcement/router_store_pi.js";
import { prepareRouterRuntime, loadRouterConfig } from "../scripts/enforcement/router_runtime_pi.js";
import { registerPulseTools } from "../scripts/enforcement/pulse_scheduler_pi.js";

const NOW = "2026-09-16T12:00:00Z";
const SEAT_ID = "cursor-claude-main";
const ACCOUNT_ID = "acct-cursor-main";
const MODEL = "zai/glm-5.3";
const authority = { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "plan the work" };

function defaultsConfig(cachePath) {
  return {
    schema: "agentic-driver.router-config.v1",
    revision: 1,
    endpoints: { merge: { url: "https://gateway.example.internal/v1", kind: "vercel-ai-gateway" } },
    seats: [{
      schema: "agentic-driver.seat.v1", seatId: SEAT_ID, kind: "subscription",
      provider: "vercel-ai-gateway", accountId: ACCOUNT_ID, endpointRef: "merge",
      model: MODEL, capabilities: ["implement"], containmentTier: "none", maxConcurrency: 2,
      costClass: "high", quotaCollector: "cursor-statusline", clusterMembership: null,
      enabled: true, deprecated: null,
    }],
    models: { [MODEL]: { aliases: [], contextWindow: 100000, capabilities: ["implement"] } },
    collectors: {
      "cursor-statusline": { adapter: "statusline-cache", cachePath, ttlSeconds: 300, accounts: [ACCOUNT_ID] },
    },
    eligibility: {
      rules: [],
      reserve: {
        floorPercent: 40, scope: "account-window", coldStartFraction: 0.25,
        estimateSamples: 20, estimateMinSamples: 5, estimateOutlierSigma: 3,
        ownerInteractiveOverride: false,
      },
    },
    preferences: { order: [{ seatId: SEAT_ID }], costPolicy: "free-first" },
    ranking: { enabled: false, janusUrl: "http://127.0.0.1:7431", maxCandidates: 8, fallback: "preference-order" },
    localHealth: { probeSeconds: 60, warmStateTracking: true },
    secrets: {},
  };
}

function quotaObservation(overrides = {}) {
  return {
    schema: QUOTA_OBSERVATION_SCHEMA,
    collector: "cursor-statusline",
    schemaVersion: 1,
    seatId: SEAT_ID,
    accountId: ACCOUNT_ID,
    capturedAt: "2026-09-16T11:58:00Z",
    expiresAt: "2026-09-16T12:05:00Z",
    generation: 7,
    quotaWindows: [
      { unit: "messages", total: 100, used: 10, remaining: 90, resetAt: "2026-09-16T18:00:00Z", derived: false },
    ],
    concurrency: { active: 1, limit: 3 },
    confidence: "high",
    sourceStatus: "ok",
    parseErrors: [],
    ...overrides,
  };
}

function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "router-runtime-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  mkdirSync(join(dir, ".agentic-driver"), { recursive: true });
  mkdirSync(join(dir, "quota"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  return {
    dir,
    defaultsPath: join(dir, ".agentic-driver", "router.defaults.json"),
    profilePath: join(dir, "home", "profile.json"),
    cacheRoot: join(dir, "quota"),
    dbPath: join(dir, "home", "state.db"),
    cachePath: join(dir, "quota", "cursor.json"),
  };
}

function writeBoardWithPolicy(dir, { placement = "host" } = {}) {
  const boardPath = join(dir, "TASKS.md");
  writeCard({ boardPath, input: { title: "Card 1", spec: "spec", definitionOfDone: "done",
    stoppingPoint: "tests green", scope: ["src/"], priority: "P0" }, authority });
  writeFileSync(automationPolicyPath(boardPath), JSON.stringify({
    roles: ["implementer"], placement, maxConcurrent: 4, expiry: "2099-01-01",
    board: boardPath, riskCeiling: "low", acceptedRepositories: [dir],
    pulse: {
      enabled: true, mode: "interactive", intervalSeconds: 300, fillOnStart: false,
      routing: { implementer: { preferred: [{ model: MODEL, maxConcurrent: 4 }], fallback: [], maxConcurrent: 4 } },
      stallTimeoutSeconds: 600, unattendedHostRiskAccepted: false,
    },
  }));
  return boardPath;
}

test("loadRouterConfig: profile precedence over repo defaults with digest/revision semantics", () => {
  const ws = freshWorkspace();
  try {
    writeFileSync(ws.defaultsPath, JSON.stringify(defaultsConfig(ws.cachePath)));
    writeFileSync(ws.profilePath, JSON.stringify({
      revision: 2,
      preferences: { order: [{ seatId: SEAT_ID }], costPolicy: "cheapest" },
    }));
    const loaded = loadRouterConfig({ repoRoot: ws.dir, defaultsPath: ws.defaultsPath, profilePath: ws.profilePath });
    // The profile section replaces the defaults' section wholesale.
    assert.equal(loaded.config.preferences.costPolicy, "cheapest");
    assert.equal(loaded.configRevision, 2);
    assert.match(loaded.configDigest, /^[0-9a-f]{64}$/);
    assert.equal(loaded.profileLoaded, true);
    // Defaults alone (no profile) keep their own revision and digest.
    const defaultsOnly = loadRouterConfig({ repoRoot: ws.dir, defaultsPath: ws.defaultsPath, profilePath: join(ws.dir, "absent.json") });
    assert.equal(defaultsOnly.configRevision, 1);
    assert.equal(defaultsOnly.profileLoaded, false);
    assert.notEqual(defaultsOnly.configDigest, loaded.configDigest);
    // An invalid merged config fails closed instead of loading.
    writeFileSync(ws.profilePath, JSON.stringify({ ranking: { enabled: "yes" } }));
    assert.throws(() => loadRouterConfig({ repoRoot: ws.dir, defaultsPath: ws.defaultsPath, profilePath: ws.profilePath }), /invalid/);
    // A missing defaults file fails closed.
    assert.throws(() => loadRouterConfig({ repoRoot: ws.dir, defaultsPath: join(ws.dir, "none.json"), profilePath: ws.profilePath }), /missing/);
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test("prepareRouterRuntime: lifecycle reachability — expiry, reconciliation, ingestion, activeReservations", () => {
  const ws = freshWorkspace();
  try {
    writeFileSync(ws.defaultsPath, JSON.stringify(defaultsConfig(ws.cachePath)));
    // Seed the collector cache (atomic temp+rename write under the trusted root).
    writeCollectorCacheAtomic({ cachePath: ws.cachePath, trustedRoot: ws.cacheRoot, value: quotaObservation() });
    // Seed the store: one stale reserved reservation (must expire) and one
    // live claimed reservation (must surface as active).
    const seed = openRouterStore({ dbPath: ws.dbPath });
    createReservation(seed, { reservationId: "res-stale", decisionId: "d-old", seatId: SEAT_ID,
      accountId: ACCOUNT_ID, vectors: [{ windowId: "w1", unit: "messages", quantity: 25 }], now: "2026-09-16T10:00:00Z", ttlSeconds: 60 });
    createReservation(seed, { reservationId: "res-live", decisionId: "d-live", seatId: SEAT_ID,
      accountId: ACCOUNT_ID, vectors: [{ windowId: "w1", unit: "messages", quantity: 25 }], now: NOW });
    closeRouterStore(seed);

    const boardPath = writeBoardWithPolicy(ws.dir, { placement: "container" });
    // A real authenticated claim carrying a reservation identity in its
    // envelope: the loader must repair SQLite FROM the claims file (authority).
    const reservationId = `res.${Buffer.from(JSON.stringify({
      decisionId: "d-crash", seatId: SEAT_ID, accountId: ACCOUNT_ID,
      vectors: [{ windowId: "w1", unit: "messages", quantity: 25 }],
    }), "utf8").toString("base64url")}`;
    const claimed = claimCard({ boardPath, role: "implementer", route: {
      seatId: SEAT_ID, accountId: ACCOUNT_ID, provider: "vercel-ai-gateway", model: MODEL,
      role: "implementer", effort: "default", containmentTier: "none", phase: "implement",
      routeDecisionDigest: "a".repeat(64), reservationId,
    } });
    assert.equal(claimed.ok, true);

    const runtime = prepareRouterRuntime({
      repoRoot: ws.dir, boardPath,
      defaultsPath: ws.defaultsPath, profilePath: join(ws.dir, "absent.json"),
      dbPath: ws.dbPath, cacheRoot: ws.cacheRoot, now: NOW,
      consumptionReceipts: [{ seatId: SEAT_ID, unit: "messages", quantity: 12, claimId: "c-1", capturedAt: NOW }],
    });
    try {
      // Expired: TTL passed only for reserved; it is no longer active.
      assert.equal(getReservation(runtime.routerStore, "res-stale").state, "expired");
      // The live reservation and the crash-window row are both active and
      // feed the 40% projection via existingReservations.
      const ids = runtime.routerSnapshot.existingReservations.map((r) => r.reservationId);
      assert.ok(ids.includes("res-live"), "the live reservation is active");
      assert.ok(ids.includes(reservationId), "the reconciled reservation is active");
      assert.equal(ids.includes("res-stale"), false, "the expired reservation is not active");
      // Reconciliation re-materialized the crash-window reservation from the
      // authenticated envelope, bound to the claim.
      const repaired = getReservation(runtime.routerStore, reservationId);
      assert.equal(repaired.state, "claimed");
      assert.equal(repaired.claimId, claimed.envelope.envelopeId);
      assert.equal(repaired.accountId, ACCOUNT_ID);
      assert.deepEqual(repaired.vectors, [{ windowId: "w1", unit: "messages", quantity: 25 }]);
      // Consumption receipts were ingested and surface for the estimator.
      const samples = consumptionSamples(runtime.routerStore, { seatId: SEAT_ID, unit: "messages" });
      assert.equal(samples.length, 1);
      assert.equal(samples[0].quantity, 12);
      // The collector cache observation was read and stored.
      assert.equal(runtime.routerSnapshot.quotaObservations.length, 1);
      assert.equal(runtime.routerSnapshot.quotaObservations[0].seatId, SEAT_ID);
    } finally { closeRouterStore(runtime.routerStore); }
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test("registered pulse tool: production loader routes at least one real tool path", async () => {
  const ws = freshWorkspace();
  try {
    writeFileSync(ws.defaultsPath, JSON.stringify(defaultsConfig(ws.cachePath)));
    writeCollectorCacheAtomic({ cachePath: ws.cachePath, trustedRoot: ws.cacheRoot, value: quotaObservation() });
    const boardPath = writeBoardWithPolicy(ws.dir);
    const registry = { get: (id) => id === MODEL ? { id } : null, isAuthenticated: () => true };
    const installed = () => new Set(defaultsConfig().seats.map((s) => s.model).filter((m) => registry.get(m) != null));
    // The exact production construction from extensions/pulse.ts: every tool
    // call resolves the runtime from the workspace via the loader.
    const routerRuntimeFor = (ctx, activeBoardPath) => {
      const runtime = prepareRouterRuntime({
        repoRoot: ctx.cwd, boardPath: activeBoardPath,
        defaultsPath: join(ctx.cwd, ".agentic-driver", "router.defaults.json"),
        profilePath: join(ws.dir, "home", "profile.json"),
        dbPath: ws.dbPath, cacheRoot: ws.cacheRoot, now: NOW,
        consumptionReceipts: ctx.consumptionReceipts ?? [],
      });
      runtime.routerSnapshot.modelInstalled = installed();
      return runtime;
    };
    // The tool's own observation timestamp is pinned the same way so the
    // fixture observation is fresh at read time (freshness is read-time).
    const registered = [];
    const openedStores = [];
    const pi = { registerTool: (tool) => registered.push(tool) };
    registerPulseTools(pi, {
      resolveBoardPath: (ctx) => join(ctx.cwd, "TASKS.md"),
      spawnWorker: null,
      routerRuntimeFor: (ctx, activeBoardPath) => {
        const runtime = routerRuntimeFor(ctx, activeBoardPath);
        openedStores.push(runtime.routerStore);
        return runtime;
      },
    });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "agentic_kanban_pulse");
    const ctx = { cwd: ws.dir, modelRegistry: registry, scopedModels: [MODEL], observedAt: NOW };
    try {
      const result = await registered[0].execute("call-1", { action: "check" }, null, null, ctx);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.ok, true, JSON.stringify(value));
      // The live tool path produced a REAL route decision through the loaded
      // config + store (not router-unavailable).
      assert.equal(value.routing.ok, true, JSON.stringify(value.routing));
      assert.equal(value.routing.routeDecisions.length, 1);
      assert.equal(value.routing.routeDecisions[0].seatId, SEAT_ID);
      assert.match(value.routing.routeDecisions[0].routeDecisionDigest, /^[0-9a-f]{64}$/);
      assert.equal(value.scan.cards[0].result, "READY_FOR_NEXT");
    } finally {
      for (const store of openedStores) closeRouterStore(store);
    }
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});
