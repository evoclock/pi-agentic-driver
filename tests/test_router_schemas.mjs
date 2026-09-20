// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Router schema tests (ROUTER_DESIGN_TASK68 §2-§4): closed exactKeys
// validation for the seat, router-config, and quota-observation records;
// closed registries; config digest; precedence; collector freshness,
// generation rollback, failure-vs-zero; cache-root containment.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEAT_SCHEMA, ROUTER_CONFIG_SCHEMA, QUOTA_OBSERVATION_SCHEMA,
  SEAT_KINDS, PROVIDERS, CAPABILITIES, CONTAINMENT_TIERS, COST_CLASSES,
  wellFormedSeat, validateRouterConfig, computeConfigDigest,
  mergeRouterConfig, wellFormedQuotaObservation, isObservationFresh,
  observationCapacityState, cachePathContained, ELIGIBILITY_RULES,
  writeCollectorCacheAtomic, readCollectorCache,
} from "../scripts/enforcement/router_schemas_pi.js";

function seat(overrides = {}) {
  return {
    schema: SEAT_SCHEMA,
    seatId: "spark-cluster-glm53flash",
    kind: "local",
    provider: "llama-server",
    accountId: null,
    endpointRef: "spark-primary",
    model: "glm-5.3-flash-ud-iq3xxs",
    capabilities: ["implement", "review"],
    containmentTier: "none",
    maxConcurrency: 2,
    costClass: "free",
    quotaCollector: null,
    clusterMembership: { clusterId: "dgx-sparks", nodes: ["spark-1", "spark-2"], spansNodes: true },
    enabled: true,
    deprecated: null,
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    schema: ROUTER_CONFIG_SCHEMA,
    revision: 1,
    endpoints: {
      "spark-primary": { url: "http://100.77.248.117:8893", kind: "llama-server" },
      "spark-1": { url: "http://100.77.248.117:8894", kind: "llama-server" },
      "spark-2": { url: "http://100.77.248.118:8894", kind: "llama-server" },
      "merge": { url: "https://gateway.example.internal/v1", kind: "vercel-ai-gateway" },
    },
    seats: [
      seat(),
      seat({
        seatId: "cursor-claude-main", kind: "subscription", provider: "vercel-ai-gateway",
        accountId: "acct-cursor-main", endpointRef: "merge", model: "claude-x",
        clusterMembership: null, costClass: "high", quotaCollector: "cursor-statusline",
      }),
    ],
    models: {
      "glm-5.3-flash-ud-iq3xxs": { aliases: ["glm-5.3-flash"], contextWindow: 131072, capabilities: ["implement"] },
      "claude-x": { aliases: [], contextWindow: 100000, capabilities: ["implement"] },
    },
    collectors: {
      "cursor-statusline": {
        adapter: "statusline-cache",
        cachePath: "/home/u/.local/share/agentic-driver/quota/cursor.json",
        ttlSeconds: 300,
        accounts: ["acct-cursor-main"],
      },
    },
    eligibility: {
      rules: [],
      reserve: {
        floorPercent: 40, scope: "account-window", coldStartFraction: 0.25,
        estimateSamples: 20, estimateMinSamples: 5, estimateOutlierSigma: 3,
        ownerInteractiveOverride: false,
      },
    },
    preferences: {
      order: [{ seatId: "spark-cluster-glm53flash" }, { seatId: "cursor-claude-main" }],
      costPolicy: "free-first",
    },
    ranking: { enabled: true, janusUrl: "http://127.0.0.1:7431", maxCandidates: 8, fallback: "preference-order" },
    localHealth: { probeSeconds: 60, warmStateTracking: true },
    secrets: { "vercel-ai-gateway": { keychainService: "Vercel AI Gateway" } },
    ...overrides,
  };
}

test("registries are closed", () => {
  assert.deepEqual([...SEAT_KINDS], ["local", "hosted-api", "subscription"]);
  assert.ok(PROVIDERS.includes("llama-server"));
  assert.ok(CAPABILITIES.includes("implement"));
  assert.deepEqual([...CONTAINMENT_TIERS], ["testudo", "docker-policy", "none"]);
  assert.deepEqual([...COST_CLASSES], ["free", "low", "medium", "high"]);
  assert.deepEqual([...ELIGIBILITY_RULES], [
    "seat-enabled", "board-policy-route", "capability-match", "containment-tier",
    "endpoint-health", "model-installed", "quota-eligibility", "global-capacity",
  ]);
});

test("seat: the doc's §2 example validates", () => {
  const result = wellFormedSeat(seat(), {
    endpoints: { "spark-primary": {}, "spark-1": {}, "spark-2": {} },
  });
  assert.equal(result.ok, true, result.reason);
});

test("seat: subscription requires accountId; non-subscription forbids it", () => {
  const missing = wellFormedSeat(seat({ kind: "subscription", accountId: null }));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /requires a non-empty accountId/);
  const present = wellFormedSeat(seat({ accountId: "acct-x" }));
  assert.equal(present.ok, false);
  assert.match(present.reason, /must have accountId: null/);
});

test("seat: unknown fields fail closed (exactKeys)", () => {
  const bad = seat({ extra: 1 });
  assert.equal(wellFormedSeat(bad).ok, false);
});

test("seat: enum values must come from their registries", () => {
  assert.equal(wellFormedSeat(seat({ kind: "quantum" })).ok, false);
  assert.equal(wellFormedSeat(seat({ provider: "not-a-provider" })).ok, false);
  assert.equal(wellFormedSeat(seat({ containmentTier: "fortress" })).ok, false);
  assert.equal(wellFormedSeat(seat({ costClass: "priceless" })).ok, false);
  assert.equal(wellFormedSeat(seat({ capabilities: ["implement", "invented"] })).ok, false);
});

test("seat: endpointRef and cluster nodes must resolve in endpoints{}", () => {
  const endpoints = { "spark-primary": {} };
  assert.equal(wellFormedSeat(seat(), { endpoints }).ok, false);
  const ok = wellFormedSeat(seat({ clusterMembership: { clusterId: "c", nodes: ["spark-1"], spansNodes: false } }), {
    endpoints: { "spark-primary": {}, "spark-1": {} },
  });
  assert.equal(ok.ok, true, ok.reason);
});

test("seat: seatId slug pattern and uniqueness are enforced", () => {
  assert.equal(wellFormedSeat(seat({ seatId: "Bad Seat" })).ok, false);
  assert.equal(wellFormedSeat(seat({ maxConcurrency: 0 })).ok, false);
  assert.equal(wellFormedSeat(seat({ maxConcurrency: 33 })).ok, false);
  assert.equal(wellFormedSeat(seat({ enabled: "yes" })).ok, false);
});

test("config: the doc's §3 shape validates and has a stable digest", () => {
  const result = validateRouterConfig(config());
  assert.equal(result.ok, true, result.errors.join("; "));
  const digestA = computeConfigDigest(config());
  const digestB = computeConfigDigest(config());
  assert.equal(digestA, digestB);
  assert.match(digestA, /^[0-9a-f]{64}$/);
  // Key order does not affect the canonical digest.
  const reordered = JSON.parse(JSON.stringify(config()));
  reordered.seats = [...reordered.seats].reverse();
  assert.notEqual(computeConfigDigest(reordered), digestA); // different content, different digest
  const sameContentDifferentKeyOrder = JSON.parse(JSON.stringify(config()));
  const flipped = {};
  for (const k of Object.keys(sameContentDifferentKeyOrder).reverse()) flipped[k] = sameContentDifferentKeyOrder[k];
  assert.equal(computeConfigDigest(flipped), digestA);
});

test("config: unknown fields fail closed", () => {
  const bad = config({ cron: "* * * * *" });
  assert.equal(validateRouterConfig(bad).ok, false);
});

test("config: dangling references fail closed", () => {
  const badEndpoint = config();
  badEndpoint.seats[0].endpointRef = "nonexistent";
  assert.equal(validateRouterConfig(badEndpoint).ok, false);

  const badCollector = config();
  badCollector.seats[0].quotaCollector = "nope";
  assert.equal(validateRouterConfig(badCollector).ok, false);

  const badPreference = config();
  badPreference.preferences.order = [{ seatId: "ghost-seat" }];
  assert.equal(validateRouterConfig(badPreference).ok, false);

  const badNode = config();
  badNode.seats[0].clusterMembership.nodes = ["spark-1", "ghost"];
  assert.equal(validateRouterConfig(badNode).ok, false);

  const dup = config();
  dup.seats = [dup.seats[0], dup.seats[0]];
  assert.equal(validateRouterConfig(dup).ok, false);
});

test("config: ranking maxCandidates is bounded at 8", () => {
  const bad = config({ ranking: { enabled: true, janusUrl: "http://127.0.0.1:7431", maxCandidates: 9, fallback: "preference-order" } });
  assert.equal(validateRouterConfig(bad).ok, false);
});

test("config: precedence — user profile replaces sections wholesale over repo defaults", () => {
  const defaults = config();
  const profile = { revision: 2, ranking: { enabled: false, janusUrl: "http://127.0.0.1:9999", maxCandidates: 4, fallback: "preference-order" } };
  const merged = mergeRouterConfig(defaults, profile);
  assert.ok(merged !== null);
  assert.equal(merged.revision, 2);
  assert.equal(merged.ranking.enabled, false);
  assert.equal(merged.ranking.maxCandidates, 4);
  // Untouched sections come from the defaults.
  assert.equal(merged.seats.length, defaults.seats.length);
  // Unknown profile sections fail closed.
  assert.equal(mergeRouterConfig(defaults, { hijacked: true }), null);
  // A profile that breaks referential integrity fails closed.
  assert.equal(mergeRouterConfig(defaults, { seats: [{ schema: SEAT_SCHEMA, seatId: "x" }] }), null);
});

test("observation: the doc's §4 example validates", () => {
  const obs = {
    schema: QUOTA_OBSERVATION_SCHEMA,
    collector: "cursor-statusline",
    schemaVersion: 1,
    seatId: "cursor-claude-main",
    accountId: "acct-cursor-main",
    capturedAt: "2026-09-16T12:00:00Z",
    expiresAt: "2026-09-16T12:05:00Z",
    generation: 42,
    quotaWindows: [
      { unit: "messages", total: 100, used: 37, remaining: 63, resetAt: "2026-09-16T18:00:00Z", derived: false },
    ],
    concurrency: { active: 1, limit: 3 },
    confidence: "high",
    sourceStatus: "ok",
    parseErrors: [],
  };
  assert.equal(wellFormedQuotaObservation(obs).ok, true, wellFormedQuotaObservation(obs).reason);
});

test("observation: total >= used + remaining is required (total explicit, never derived)", () => {
  const base = {
    schema: QUOTA_OBSERVATION_SCHEMA,
    collector: "c", schemaVersion: 1, seatId: "s", accountId: "a",
    capturedAt: "2026-09-16T12:00:00Z", expiresAt: "2026-09-16T12:05:00Z",
    generation: 1,
    quotaWindows: [{ unit: "messages", total: 50, used: 40, remaining: 20, resetAt: null, derived: false }],
    concurrency: null, confidence: "high", sourceStatus: "ok", parseErrors: [],
  };
  assert.equal(wellFormedQuotaObservation(base).ok, false);
  assert.match(wellFormedQuotaObservation(base).reason, /total >= used \+ remaining/);
  const ok = { ...base, quotaWindows: [{ ...base.quotaWindows[0], total: 60 }] };
  assert.equal(wellFormedQuotaObservation(ok).ok, true);
});

test("observation: unknown fields and bad enums fail closed", () => {
  const base = {
    schema: QUOTA_OBSERVATION_SCHEMA,
    collector: "c", schemaVersion: 1, seatId: "s", accountId: "a",
    capturedAt: "2026-09-16T12:00:00Z", expiresAt: "2026-09-16T12:05:00Z",
    generation: 1,
    quotaWindows: [{ unit: "messages", total: 100, used: 0, remaining: 100, resetAt: null, derived: false }],
    concurrency: null, confidence: "high", sourceStatus: "ok", parseErrors: [],
  };
  assert.equal(wellFormedQuotaObservation({ ...base, extra: 1 }).ok, false);
  assert.equal(wellFormedQuotaObservation({ ...base, sourceStatus: "great" }).ok, false);
  assert.equal(wellFormedQuotaObservation({ ...base, quotaWindows: [{ ...base.quotaWindows[0], unit: "bytes" }] }).ok, false);
  assert.equal(wellFormedQuotaObservation({ ...base, accountId: null }).ok, false);
  assert.equal(wellFormedQuotaObservation({ ...base, expiresAt: "2026-09-16T11:00:00Z" }).ok, false);
});

test("observation: freshness is read-time — now < expiresAt AND sourceStatus ok", () => {
  const obs = {
    sourceStatus: "ok", expiresAt: "2026-09-16T12:05:00Z",
  };
  assert.equal(isObservationFresh(obs, "2026-09-16T12:04:59Z"), true);
  assert.equal(isObservationFresh(obs, "2026-09-16T12:05:00Z"), false); // boundary: expired
  assert.equal(isObservationFresh({ ...obs, sourceStatus: "stale" }, "2026-09-16T12:00:00Z"), false);
  assert.equal(isObservationFresh(null, "2026-09-16T12:00:00Z"), false);
});

test("observation: failure vs zero are distinct", () => {
  const at = "2026-09-16T12:01:00Z";
  const zero = {
    sourceStatus: "ok", expiresAt: "2026-09-16T12:05:00Z",
    quotaWindows: [{ unit: "messages", total: 100, used: 100, remaining: 0, resetAt: null, derived: false }],
  };
  assert.equal(observationCapacityState(zero, at), "zero");
  const failure = { ...zero, sourceStatus: "parse-error" };
  assert.equal(observationCapacityState(failure, at), "failure");
  const stale = { ...zero, expiresAt: "2026-09-16T12:00:00Z" };
  assert.equal(observationCapacityState(stale, at), "failure");
  const available = { ...zero, quotaWindows: [{ ...zero.quotaWindows[0], remaining: 10 }] };
  assert.equal(observationCapacityState(available, at), "available");
});

test("cache root containment canonicalizes paths and rejects symlink escapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-cache-"));
  const root = join(dir, "quota");
  mkdirSync(join(root, "sub", "dir"), { recursive: true });
  symlinkSync("/etc", join(root, "escape"));
  try {
    assert.equal(cachePathContained(join(root, "cursor.json"), root).ok, true);
    assert.equal(cachePathContained("/etc/passwd", root).ok, false);
    assert.equal(cachePathContained(join(root, "..", "passwd"), root).ok, false);
    assert.equal(cachePathContained(root, root).ok, false);
    assert.equal(cachePathContained("relative/path.json", root).ok, false);
    assert.equal(cachePathContained(join(root, "sub", "dir", "file.json"), root).ok, true);
    assert.equal(cachePathContained(join(root, "escape", "passwd"), root).ok, false);
    // The FINAL path component is defended too: a symlink at the cache file
    // itself (not just a parent) is rejected for both read and write paths.
    symlinkSync("/etc/passwd", join(root, "hijacked.json"));
    assert.equal(cachePathContained(join(root, "hijacked.json"), root).ok, false);
    assert.equal(readCollectorCache({ cachePath: join(root, "hijacked.json"), trustedRoot: root }).ok, false);
    assert.throws(() => writeCollectorCacheAtomic({ cachePath: join(root, "hijacked.json"), trustedRoot: root, value: { schema: "x" } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const CACHE_OBSERVATION = {
  schema: QUOTA_OBSERVATION_SCHEMA,
  collector: "cursor-statusline",
  schemaVersion: 1,
  seatId: "cursor-claude-main",
  accountId: "acct-cursor-main",
  capturedAt: "2026-09-16T11:58:00Z",
  expiresAt: "2026-09-16T12:05:00Z",
  generation: 7,
  quotaWindows: [
    { unit: "messages", total: 100, used: 30, remaining: 70, resetAt: "2026-09-16T18:00:00Z", derived: false },
  ],
  concurrency: { active: 1, limit: 3 },
  confidence: "high",
  sourceStatus: "ok",
  parseErrors: [],
};

test("collector cache: atomic temp+rename write and validating read round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-cache-rw-"));
  const root = join(dir, "quota");
  mkdirSync(join(root, "sub"), { recursive: true });
  const cachePath = join(root, "sub", "cursor.json");
  try {
    const written = writeCollectorCacheAtomic({ cachePath, trustedRoot: root, value: CACHE_OBSERVATION });
    assert.equal(written, realpathSync(cachePath));
    // No temp leftovers: the tmp-* sibling is renamed away by the write.
    assert.deepEqual(readdirSync(join(root, "sub")).sort(), ["cursor.json"]);
    // The read validates the record's closed shape.
    const read = readCollectorCache({ cachePath, trustedRoot: root });
    assert.equal(read.ok, true);
    assert.deepEqual(read.observation, CACHE_OBSERVATION);
    // Overwrite is atomic too (a second write replaces the file in place).
    const next = { ...CACHE_OBSERVATION, generation: 8, capturedAt: "2026-09-16T12:02:00Z" };
    writeCollectorCacheAtomic({ cachePath, trustedRoot: root, value: next });
    const reread = readCollectorCache({ cachePath, trustedRoot: root });
    assert.equal(reread.ok, true);
    assert.equal(reread.observation.generation, 8);
    // Malformed data fails closed at read time — it is never trusted.
    writeFileSync(cachePath, "{ not json", "utf8");
    const malformed = readCollectorCache({ cachePath, trustedRoot: root });
    assert.equal(malformed.ok, false);
    writeFileSync(cachePath, JSON.stringify({ schema: "agentic-driver.quota-observation.v1", wrong: true }), "utf8");
    const wrongShape = readCollectorCache({ cachePath, trustedRoot: root });
    assert.equal(wrongShape.ok, false);
    // A missing file fails closed without throwing.
    const missing = readCollectorCache({ cachePath: join(root, "absent.json"), trustedRoot: root });
    assert.equal(missing.ok, false);
    // Writes outside the trusted root are refused before any temp file lands.
    assert.throws(() => writeCollectorCacheAtomic({ cachePath: join(dir, "outside.json"), trustedRoot: root, value: CACHE_OBSERVATION }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
