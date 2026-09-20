// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Router integration tests (ROUTER_DESIGN_TASK68 §1, §5, §6.4, §7):
// envelope v2 route fields, claims v3 evidence + lineage + HMAC, batch
// context route identity carried from the decision, execution validation of
// the spawned model against the envelope, the janus ranking adapter with
// deterministic fallback, and the replacement/lineage rules.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  ENVELOPE_SCHEMA, CLAIMS_SCHEMA,
  createEnvelope, wellFormedEnvelope, readClaimsState, readClaims, claimCard,
  replaceAttempt, writerStatePath, claimsPath, validateBoard,
  canonicalJsonString, computeSpecHash, validateEnvelopeForExecution,
  writeCard, automationPolicyPath, prepareEnvelopeForExecution,
} from "../scripts/enforcement/task_board_core_pi.js";
import {
  mintBatchContext, reserveBatchEntry, pulseRun,
  heartbeatBatchReservation, settleBatchReservation,
} from "../scripts/enforcement/pulse_scheduler_pi.js";
import {
  openRouterStore, closeRouterStore, getReservation,
} from "../scripts/enforcement/router_store_pi.js";
import {
  ROUTER_CONFIG_SCHEMA, QUOTA_OBSERVATION_SCHEMA,
} from "../scripts/enforcement/router_schemas_pi.js";
import {
  claimCardForConfirmedBatch, registerConfirmedBatchForClaims,
} from "../scripts/enforcement/task_board_core_pi.js";
import {
  rankingCandidates, candidateSetDigest, rankingQuestion,
  applyRankingResponse, createJanusRankAdapter, rankOrFallback,
} from "../scripts/enforcement/router_ranking_pi.js";
import {
  isDeadRoute, replacementAction, lineageDigest,
} from "../scripts/enforcement/router_replacement_pi.js";
import { SEAT_SCHEMA } from "../scripts/enforcement/router_schemas_pi.js";

// ---------------------------------------------------------------------------
// Fixture: a minimal git repo with a board + policy, mirroring the dispatch
// tests' setup.
// ---------------------------------------------------------------------------

const authority = { source: "instruction", sessionOrReportId: "sess-test", quotedInstruction: "write the card" };

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixtureBoard(dir, { cards = 1, policyOverrides = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  writeFileSync(join(dir, "file.txt"), "one\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  const boardPath = join(dir, "TASKS.md");
  const ids = [];
  for (let i = 1; i <= cards; i += 1) {
    const r = writeCard({
      boardPath,
      input: { title: `Card ${i}`, spec: `spec ${i}`, definitionOfDone: `done ${i}`, stoppingPoint: "tests green", scope: ["src/"], priority: "P1" },
      authority,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    ids.push(r.cardId);
  }
  const policy = {
    roles: ["implementer"],
    placement: "container",
    maxConcurrent: 5,
    expiry: "2030-01-01T00:00:00.000Z",
    board: boardPath,
    riskCeiling: "medium",
    allowPerCardRiskOverride: false,
    acceptedRepositories: [dir],
    ...policyOverrides,
  };
  writeFileSync(automationPolicyPath(boardPath), JSON.stringify(policy));
  return { boardPath, ids, policy };
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "router-integration-"));
}

const routedClaim = Object.freeze({
  seatId: "spark-cluster-glm53flash", accountId: null, provider: "llama-server",
  model: "zai/glm-5.3", role: "implementer", effort: "default",
  containmentTier: "none", phase: "implement", routeDecisionDigest: "a".repeat(64), reservationId: null,
});

// ---------------------------------------------------------------------------
// Envelope v2 (§5.1)
// ---------------------------------------------------------------------------

function cardFor(boardPath, cardId) {
  return validateBoard(readFileSync(boardPath, "utf8"), {}).cards.find((c) => c.cardId === cardId);
}

function policyFor(boardPath) {
  return JSON.parse(readFileSync(automationPolicyPath(boardPath), "utf8"));
}

test("envelope v2: createEnvelope populates route fields from the PASSED route decision, never selecting one", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    const card = cardFor(boardPath, ids[0]);
    const route = {
      seatId: "spark-cluster-glm53flash",
      accountId: null,
      provider: "llama-server",
      model: "glm-5.3-flash-ud-iq3xxs",
      role: "implementer",
      effort: "high",
      containmentTier: "testudo",
      phase: "implement",
      routeDecisionDigest: "a".repeat(64),
      reservationId: "res-1",
    };
    const env = createEnvelope({ card, policy: policyFor(boardPath), repository: dir, route });
    assert.equal(env.schema, ENVELOPE_SCHEMA);
    assert.equal(env.seatId, "spark-cluster-glm53flash");
    assert.equal(env.accountId, null);
    assert.equal(env.provider, "llama-server");
    assert.equal(env.model, "glm-5.3-flash-ud-iq3xxs");
    assert.equal(env.role, "implementer");
    assert.equal(env.effort, "high");
    assert.equal(env.containmentTier, "testudo");
    assert.equal(env.phase, "implement");
    assert.equal(env.routeDecisionDigest, "a".repeat(64));
    assert.equal(env.reservationId, "res-1");
    assert.equal(wellFormedEnvelope(env), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope v2: missing route fails closed", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    assert.throws(() => createEnvelope({ card: cardFor(boardPath, ids[0]), policy: policyFor(boardPath), repository: dir }), /complete authenticated route/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope v2: route-field validation fails closed on bad enums and digests", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    const card = cardFor(boardPath, ids[0]);
    assert.throws(() => createEnvelope({ card, policy: policyFor(boardPath), repository: dir, route: { ...routedClaim, effort: "extreme" } }), /complete authenticated route/);
    const bad = createEnvelope({ card, policy: policyFor(boardPath), repository: dir, route: routedClaim });
    // A hand-tampered envelope with a bogus digest fails wellFormedEnvelope.
    const tampered = { ...bad, routeDecisionDigest: "nope" };
    assert.equal(wellFormedEnvelope(tampered), false);
    const badPhase = { ...bad, phase: "chaos" };
    assert.equal(wellFormedEnvelope(badPhase), false);
    const badTier = { ...bad, containmentTier: "fortress" };
    assert.equal(wellFormedEnvelope(badTier), false);
    const emptySeat = { ...bad, seatId: "" };
    assert.equal(wellFormedEnvelope(emptySeat), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Claims v3 (§5.3, §7.3)
// ---------------------------------------------------------------------------

test("claims v3: lineage fields are closed on the claim record; HMAC covers evidence", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    const r = claimCard({ boardPath, role: "implementer", cardId: ids[0], route: routedClaim });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.claim.parentClaimId, null);
    assert.equal(r.claim.attemptIndex, 0);
    const state = readClaimsState(boardPath);
    assert.equal(state.ok, true);
    assert.equal(state.state.schema ?? CLAIMS_SCHEMA, CLAIMS_SCHEMA);
    assert.deepEqual(Object.keys(state.state.evidence ?? {}), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claims v3: evidence map is HMAC-covered — tampering with evidence fails closed", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    assert.equal(claimCard({ boardPath, role: "implementer", cardId: ids[0], route: routedClaim }).ok, true);
    const raw = JSON.parse(readFileSync(claimsPath(boardPath), "utf8"));
    const writer = JSON.parse(readFileSync(writerStatePath(boardPath), "utf8"));
    // Forge a valid-looking v3 file with tampered evidence.
    const forged = {
      schema: CLAIMS_SCHEMA,
      generation: raw.generation,
      transaction: raw.transaction,
      claims: raw.claims,
      consumedClaims: raw.consumedClaims,
      evidence: { [`${"e".repeat(64)}`]: { forged: true } },
    };
    forged.hmac = createHmac("sha256", writer.secret)
      .update(canonicalJsonString({
        schema: forged.schema, generation: forged.generation,
        transaction: forged.transaction, claims: forged.claims,
        consumedClaims: forged.consumedClaims,
        evidence: raw.evidence ?? {},
      }), "utf8").digest("hex");
    writeFileSync(claimsPath(boardPath), JSON.stringify(forged));
    const read = readClaimsState(boardPath);
    assert.equal(read.ok, false, "evidence tampering must fail the HMAC");
    assert.match(read.reason, /evidence map is malformed|HMAC does not verify/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claims v3: v2 claims files are grandfathered and migrate on next write", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    assert.equal(claimCard({ boardPath, role: "implementer", cardId: ids[0], route: routedClaim }).ok, true);
    // Downgrade the file to a correctly signed v2 shape (legacy claim fields,
    // legacy HMAC input).
    const state = readClaimsState(boardPath);
    const writer = JSON.parse(readFileSync(writerStatePath(boardPath), "utf8"));
    const v2 = {
      schema: "agentic-driver.board-claims.v2",
      generation: state.state.generation,
      transaction: null,
      claims: state.state.claims.map((c) => {
        const { parentClaimId, attemptIndex, ...legacy } = c;
        return legacy;
      }),
      consumedClaims: state.state.consumedClaims,
    };
    v2.hmac = createHmac("sha256", writer.secret)
      .update(canonicalJsonString({
        schema: v2.schema, generation: v2.generation, transaction: v2.transaction,
        claims: v2.claims, consumedClaims: v2.consumedClaims,
      }), "utf8").digest("hex");
    writeFileSync(claimsPath(boardPath), JSON.stringify(v2));
    writeFileSync(writerStatePath(boardPath), JSON.stringify({
      ...writer, claimsGeneration: v2.generation,
      claimsDigest: createHmac("sha256", writer.secret)
        .update(canonicalJsonString({ generation: v2.generation, hmac: v2.hmac }), "utf8").digest("hex"),
    }));
    // v2 reads as valid with an empty evidence map.
    const read = readClaimsState(boardPath);
    assert.equal(read.ok, true, read.reason);
    assert.deepEqual(read.state.evidence, {});
    // The next write migrates to v3 with lineage defaults.
    const migrated = replaceAttempt({
      boardPath, cardId: ids[0], envelopeId: v2.claims[0].envelopeId,
      reason: "worker-unresponsive", replacement: {},
    });
    assert.equal(migrated.ok, true, migrated.reason);
    const after = readClaimsState(boardPath);
    assert.equal(after.ok, true);
    const newClaim = after.state.claims.find((c) => c.envelopeId === migrated.envelope.envelopeId);
    assert.equal(newClaim.parentClaimId, v2.claims[0].envelopeId);
    assert.equal(newClaim.attemptIndex, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Batch context route identity (§1, §8.1)
// ---------------------------------------------------------------------------

test("batch context: entries carry seatId/digest/reservationId from the route decision, never recomputed", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    const scan = {
      schema: "agentic-driver.board-pulse.v1", board: boardPath,
      cards: [{ title: "Card 1", role: "implementer", result: "READY_FOR_NEXT", reason: null }],
      proposedDispatches: [{ title: "Card 1", role: "implementer", model: "zai/glm-5.3", placement: "container" }],
    };
    const decision = {
      ok: true,
      selectedSeatId: "spark-cluster-glm53flash", model: "zai/glm-5.3", effort: "default", endpointRef: "spark-primary", reservationVectors: [],
      cardId: ids[0],
      digest: "a".repeat(64),
      provider: "llama-server",
      accountId: null,
      containmentTier: "none",
      reservationId: "res-9",
      record: {
        decisionId: "dec-1",
        selectedSeatId: "spark-cluster-glm53flash",
        phase: "implement",
      },
    };
    const batch = mintBatchContext({
      scan, cards: cardFor(boardPath, ids[0]) ? [cardFor(boardPath, ids[0])] : [], policy: policyFor(boardPath), instruction: "work",
      routeDecisions: [decision],
    });
    assert.equal(batch.entries.length, 1);
    const entry = batch.entries[0];
    assert.equal(entry.seatId, "spark-cluster-glm53flash");
    assert.equal(entry.routeDecisionDigest, "a".repeat(64));
    assert.equal(entry.reservationId, "res-9");
    assert.equal(entry.provider, "llama-server");
    assert.equal(entry.phase, "implement");
    assert.throws(() => mintBatchContext({ scan, cards: [cardFor(boardPath, ids[0])], policy: policyFor(boardPath), instruction: "work" }), /missing complete route decision/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("confirmed-batch claim: the envelope embeds the carried route identity", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir, { policyOverrides: { placement: "host" } });
    const scan = {
      schema: "agentic-driver.board-pulse.v1", board: boardPath,
      cards: [{ title: "Card 1", role: "implementer", result: "READY_FOR_NEXT", reason: null }],
      proposedDispatches: [{ title: "Card 1", role: "implementer", model: "zai/glm-5.3", placement: "host" }],
    };
    const decision = {
      ok: true, selectedSeatId: "spark-cluster-glm53flash", model: "zai/glm-5.3", effort: "default", endpointRef: "spark-primary", reservationVectors: [], cardId: ids[0], digest: "b".repeat(64), provider: "llama-server",
      accountId: null, containmentTier: "none", reservationId: "res-7",
      record: { decisionId: "dec-2", selectedSeatId: "spark-cluster-glm53flash", phase: "implement" },
    };
    const batch = mintBatchContext({
      scan, cards: [cardFor(boardPath, ids[0])], policy: policyFor(boardPath), instruction: "work",
      routeDecisions: [decision],
    });
    registerConfirmedBatchForClaims(batch);
    const reserved = reserveBatchEntry(batch, ids[0]);
    assert.equal(reserved.ok, true, reserved.reason);
    const claim = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch });
    assert.equal(claim.ok, true, claim.reason);
    assert.equal(claim.envelope.seatId, "spark-cluster-glm53flash");
    assert.equal(claim.envelope.routeDecisionDigest, "b".repeat(64));
    assert.equal(claim.envelope.reservationId, "res-7");
    assert.equal(claim.claim.attemptIndex, 0);
    assert.equal(claim.claim.parentClaimId, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Production scheduler path and reservation lifecycle (§1, §6.2, §8)
// ---------------------------------------------------------------------------

test("production pulseRun routes, claims, spawns the authenticated seat, and settles its reservation", async () => {
  const dir = freshDir();
  const store = openRouterStore({ dbPath: join(dir, "router.db") });
  try {
    const pulse = {
      enabled: true, mode: "interactive", intervalSeconds: 300, fillOnStart: true,
      routing: { implementer: { preferred: [{ model: "anthropic/claude-x", maxConcurrent: 2 }], fallback: [], maxConcurrent: 2 } },
      stallTimeoutSeconds: 600, unattendedHostRiskAccepted: false,
    };
    const { boardPath } = fixtureBoard(dir, { policyOverrides: { pulse, placement: "host" } });
    const now = "2026-09-16T12:00:00.000Z";
    const routerConfig = {
      schema: ROUTER_CONFIG_SCHEMA, revision: 1,
      endpoints: { cursor: { url: "https://cursor.example.invalid/v1", kind: "anthropic" } },
      seats: [{ schema: SEAT_SCHEMA, seatId: "cursor-main", kind: "subscription", enabled: true,
        endpointRef: "cursor", quotaCollector: "cursor-statusline", capabilities: ["implement"],
        accountId: "acct-main", provider: "anthropic", model: "anthropic/claude-x", containmentTier: "testudo",
        maxConcurrency: 2, costClass: "high", clusterMembership: null, deprecated: null }],
      models: { "anthropic/claude-x": { aliases: [], contextWindow: 100000, capabilities: ["implement"] } },
      collectors: { "cursor-statusline": { adapter: "statusline-cache", cachePath: join(dir, "quota.json"), ttlSeconds: 300, accounts: ["acct-main"] } },
      eligibility: { rules: [], reserve: { floorPercent: 40, scope: "account-window", coldStartFraction: 0.25,
        estimateSamples: 20, estimateMinSamples: 5, estimateOutlierSigma: 3, ownerInteractiveOverride: false } },
      preferences: { order: [{ seatId: "cursor-main" }], costPolicy: "free-first" },
      ranking: { enabled: false, janusUrl: "http://127.0.0.1:7431", maxCandidates: 8, fallback: "preference-order" },
      localHealth: { probeSeconds: 60, warmStateTracking: true }, secrets: {},
    };
    const quotaObservations = [{ schema: QUOTA_OBSERVATION_SCHEMA, collector: "cursor-statusline", schemaVersion: 1,
      seatId: "cursor-main", accountId: "acct-main", capturedAt: "2026-09-16T11:59:00.000Z",
      expiresAt: "2026-09-16T12:05:00.000Z", generation: 1,
      quotaWindows: [{ unit: "messages", total: 100, used: 10, remaining: 90, resetAt: "2026-09-16T18:00:00.000Z", derived: false }],
      concurrency: { active: 0, limit: 2 }, confidence: "high", sourceStatus: "ok", parseErrors: [] }];
    const spawned = [];
    const result = await pulseRun({ boardPath, instruction: "dispatch", now,
      spawnWorker: async (input) => { spawned.push(input); return { ok: true }; },
      context: { mode: "tui", hasUI: true, ui: { confirm: async () => true },
        routerConfig, routerStore: store, routerSnapshot: { quotaObservations, modelInstalled: new Set(["anthropic/claude-x"]) },
        modelRegistry: { get: (model) => model === "anthropic/claude-x" ? {} : null, isAuthenticated: () => true } } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.landedAssignments[0].status, "started", JSON.stringify(result));
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].model, spawned[0].envelope.model);
    assert.equal(spawned[0].provider, spawned[0].envelope.provider);
    assert.equal(spawned[0].seatId, spawned[0].envelope.seatId);
    const reservation = getReservation(store, spawned[0].envelope.reservationId);
    assert.equal(reservation.state, "claimed");
    assert.equal(reservation.vectors[0].windowId, "acct-main:messages:2026-09-16T18:00:00.000Z");
    assert.equal(heartbeatBatchReservation({ routerStore: store, envelope: spawned[0].envelope, now: "2026-09-16T12:01:00.000Z" }).ok, true);
    assert.equal(settleBatchReservation({ routerStore: store, envelope: spawned[0].envelope, outcome: "completed", now: "2026-09-16T12:02:00.000Z" }).ok, true);
    assert.equal(getReservation(store, reservation.reservationId).state, "consumed");
  } finally {
    closeRouterStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Execution validation (§5.2)
// ---------------------------------------------------------------------------

test("execution validation: the spawned model/endpoint must match the authenticated envelope", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir, { policyOverrides: { placement: "host" } });
    const claim = claimCardForConfirmedBatch({
      boardPath, cardId: ids[0], role: "implementer",
      confirmedBatch: (() => {
        const scan = {
          schema: "agentic-driver.board-pulse.v1", board: boardPath,
          cards: [{ title: "Card 1", role: "implementer", result: "READY_FOR_NEXT", reason: null }],
          proposedDispatches: [{ title: "Card 1", role: "implementer", model: "zai/glm-5.3", placement: "host" }],
        };
        const batch = mintBatchContext({
          scan, cards: [cardFor(boardPath, ids[0])], policy: policyFor(boardPath), instruction: "work",
          routeDecisions: [{
            ok: true, selectedSeatId: "spark-cluster-glm53flash", model: "zai/glm-5.3", effort: "default", endpointRef: "spark-primary", reservationVectors: [], cardId: ids[0], digest: "c".repeat(64), provider: "llama-server",
            accountId: null, containmentTier: "none", reservationId: null,
            record: { decisionId: "dec-3", selectedSeatId: "spark-cluster-glm53flash", phase: "implement" },
          }],
        });
        registerConfirmedBatchForClaims(batch);
        assert.equal(reserveBatchEntry(batch, ids[0]).ok, true);
        return batch;
      })(),
    });
    assert.equal(claim.ok, true);
    // The assigned branch is prepared first (execution boundary order).
    const prepared = prepareEnvelopeForExecution({ boardPath, envelope: claim.envelope });
    assert.equal(prepared.ok, true, prepared.reason);
    const validated = validateEnvelopeForExecution({ boardPath, envelope: claim.envelope });
    assert.equal(validated.ok, true, validated.reason);
    // The spawn step's match check: model + provider + seat must equal the
    // authenticated envelope. A mismatch fails closed.
    const spawnModel = claim.envelope.model;
    const spawnProvider = claim.envelope.provider;
    const spawnSeat = claim.envelope.seatId;
    assert.equal(spawnModel === claim.envelope.model
      && spawnProvider === claim.envelope.provider
      && spawnSeat === claim.envelope.seatId, true);
    const mismatched = { ...claim.envelope, model: "other/model" };
    assert.notEqual(mismatched.model, claim.envelope.model);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Ranking adapter (§6.4)
// ---------------------------------------------------------------------------

const seatsById = new Map([
  ["spark", { seatId: "spark", kind: "local", costClass: "free", capabilities: ["implement"] }],
  ["merge", { seatId: "merge", kind: "hosted-api", costClass: "low", capabilities: ["implement", "review"] }],
  ["cursor", { seatId: "cursor", kind: "subscription", costClass: "high", capabilities: ["implement"] }],
]);

test("ranking candidates: bounded at 8, no credentials, no endpoint URLs", () => {
  const candidates = rankingCandidates({
    eligibleSeatIds: ["spark", "merge", "cursor"], seatsById,
  });
  assert.equal(candidates.length, 3);
  const json = JSON.stringify(candidates);
  assert.ok(!json.includes("http"));
  assert.ok(!json.includes("key"));
  assert.equal(candidates[0].locality, "local");
  assert.equal(candidates[1].locality, "hosted");
  // Bounded: only the first 8 are ever sent.
  const many = Array.from({ length: 12 }, (_, i) => `seat-${i}`);
  const map = new Map(many.map((id) => [id, { seatId: id, kind: "local", costClass: "free", capabilities: [] }]));
  assert.equal(rankingCandidates({ eligibleSeatIds: many, seatsById: map }).length, 8);
});

test("applyRankingResponse: well-formed choice reorders; malformed falls back (returns null)", () => {
  const fallback = ["spark", "merge", "cursor"];
  const good = applyRankingResponse({ response: { answers: { route_rank: "merge", rank_confidence: 4 } }, fallbackOrder: fallback });
  assert.deepEqual(good.order, ["merge", "spark", "cursor"]);
  assert.equal(good.confidence, 4);
  // Unknown seat → null.
  assert.equal(applyRankingResponse({ response: { answers: { route_rank: "ghost" } }, fallbackOrder: fallback }), null);
  // Missing answers → null.
  assert.equal(applyRankingResponse({ response: null, fallbackOrder: fallback }), null);
  assert.equal(applyRankingResponse({ response: { answers: {} }, fallbackOrder: fallback }), null);
  // Garbage → null.
  assert.equal(applyRankingResponse({ response: "banana", fallbackOrder: fallback }), null);
});

test("janus adapter: any failure (unavailable/timeout/malformed) returns null — never blocks", async () => {
  // Absent janus (no URL): fallback IS the path.
  const absent = createJanusRankAdapter({});
  assert.equal(await absent({ candidates: [] }), null);
  // Throwing fetch.
  const throwing = createJanusRankAdapter({ janusUrl: "http://127.0.0.1:1", fetchFn: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await throwing({ candidates: [] }), null);
  // Non-2xx.
  const failing = createJanusRankAdapter({ janusUrl: "http://x", fetchFn: async () => ({ ok: false }) });
  assert.equal(await failing({ candidates: [] }), null);
  // Malformed body.
  const malformed = createJanusRankAdapter({ janusUrl: "http://x", fetchFn: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) });
  assert.equal(await malformed({ candidates: [] }), null);
  // No fetch available at all.
  const noFetch = createJanusRankAdapter({ janusUrl: "http://x", fetchFn: null });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.equal(await noFetch({ candidates: [] }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("janus adapter: a successful call returns the parsed body", async () => {
  const ok = createJanusRankAdapter({
    janusUrl: "http://x", fetchFn: async () => ({ ok: true, json: async () => ({ answers: { route_rank: "merge" } }) }),
  });
  const body = await ok({ candidates: [] });
  assert.deepEqual(body.answers.route_rank, "merge");
});

test("rankOrFallback: disabled ranking uses preference order; rank_confidence never influences ordering", async () => {
  const cfg = { preferences: { order: [{ seatId: "cursor" }, { seatId: "spark" }] }, ranking: { enabled: false } };
  const result = await rankOrFallback({
    config: cfg, eligibleSeatIds: ["spark", "cursor", "merge"], seatsById, now: "2026-09-16T12:00:00Z",
  });
  assert.equal(result.used, false);
  assert.deepEqual(result.order, ["cursor", "spark", "merge"]); // preference first, then declaration order
  assert.equal(result.outcome, "fallback-disabled");
});

test("rankOrFallback: ranking success reorders deterministically; failure falls back", async () => {
  const cfg = {
    preferences: { order: [{ seatId: "spark" }, { seatId: "merge" }] },
    ranking: { enabled: true, janusUrl: "http://127.0.0.1:7431", maxCandidates: 8, fallback: "preference-order" },
  };
  const ranked = await rankOrFallback({
    config: cfg, eligibleSeatIds: ["spark", "merge"], seatsById,
    janusRank: async () => ({ answers: { route_rank: "merge", rank_confidence: 5 } }),
    now: "2026-09-16T12:00:00Z",
  });
  assert.equal(ranked.used, true);
  assert.deepEqual(ranked.order, ["merge", "spark"]);
  assert.equal(ranked.confidence, 5);
  assert.match(ranked.requestId, /^rank-/);
  const failed = await rankOrFallback({
    config: cfg, eligibleSeatIds: ["spark", "merge"], seatsById,
    janusRank: async () => { throw new Error("down"); },
    now: "2026-09-16T12:00:00Z",
  });
  assert.equal(failed.used, false);
  assert.deepEqual(failed.order, ["spark", "merge"]);
  assert.equal(failed.outcome, "fallback-failed");
});

// ---------------------------------------------------------------------------
// Replacement and lineage (§7)
// ---------------------------------------------------------------------------

function seatMap(extra = []) {
  return new Map([
    ["spark", { schema: SEAT_SCHEMA, seatId: "spark", kind: "local", enabled: true, endpointRef: "spark-primary", quotaCollector: null, capabilities: [], accountId: null, provider: "llama-server", model: "m", containmentTier: "none", maxConcurrency: 2, costClass: "free", clusterMembership: null, deprecated: null }],
    ["merge", { schema: SEAT_SCHEMA, seatId: "merge", kind: "hosted-api", enabled: true, endpointRef: "merge", quotaCollector: null, capabilities: [], accountId: null, provider: "merge-gateway", model: "m2", containmentTier: "none", maxConcurrency: 2, costClass: "low", clusterMembership: null, deprecated: null }],
    ...extra,
  ]);
}

test("dead-route rule: failed collector or failed health probe can never be used for replacement", () => {
  const now = "2026-09-16T12:00:00Z";
  // Local seat with a failed health probe.
  const deadLocal = isDeadRoute({ seat: seatMap().get("spark"), healthObservations: {}, now });
  assert.equal(deadLocal.dead, true);
  const aliveLocal = isDeadRoute({
    seat: seatMap().get("spark"),
    healthObservations: { "spark-primary": { sourceStatus: "ok", expiresAt: "2026-09-16T12:05:00Z" } },
    now,
  });
  assert.equal(aliveLocal.dead, false);
  // Subscription seat with a failed collector.
  const cursorSeat = { ...seatMap().get("spark"), seatId: "cursor", kind: "subscription", accountId: "a", quotaCollector: "c" };
  const deadCollector = isDeadRoute({
    seat: cursorSeat,
    quotaObservations: [{ seatId: "cursor", sourceStatus: "parse-error" }],
    now,
  });
  assert.equal(deadCollector.dead, true);
  assert.match(deadCollector.reason, /fail closed/);
  const aliveCollector = isDeadRoute({
    seat: cursorSeat,
    quotaObservations: [{ seatId: "cursor", sourceStatus: "ok" }],
    now,
  });
  assert.equal(aliveCollector.dead, false);
});

test("replacement: same seat reuses the envelope; different seat requires a NEW route decision + claim", () => {
  const now = "2026-09-16T12:00:00Z";
  const seats = seatMap();
  const envelope = { seatId: "spark" };
  const health = { "spark-primary": { sourceStatus: "ok", expiresAt: "2026-09-16T12:05:00Z" } };
  // Same seat, alive → reuse.
  const same = replacementAction({ envelope, seatsById: seats, healthObservations: health, now });
  assert.equal(same.action, "reuse-envelope");
  // Different seat → new route decision + new claim/envelope.
  const different = replacementAction({
    envelope, replacementSeatId: "merge", seatsById: seats,
    healthObservations: health, now,
  });
  assert.equal(different.action, "new-route-decision");
  assert.equal(different.fromSeatId, "spark");
  assert.equal(different.toSeatId, "merge");
  // Dead route → refused, even the same seat.
  const dead = replacementAction({ envelope, seatsById: seats, healthObservations: {}, now });
  assert.equal(dead.action, "refused");
  assert.match(dead.reason, /dead route/);
  // Envelope without seat identity → refused.
  const blind = replacementAction({ envelope: {}, seatsById: seats, now });
  assert.equal(blind.action, "refused");
});

test("replacement: writer rejects fabricated different-seat routes and preserves same-seat lineage", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    const first = claimCard({ boardPath, role: "implementer", cardId: ids[0], route: routedClaim });
    assert.equal(first.ok, true);
    const fabricated = replaceAttempt({
      boardPath, cardId: ids[0], envelopeId: first.envelope.envelopeId,
      reason: "worker-unresponsive",
      replacement: { route: { ...routedClaim, seatId: "merge", provider: "merge-gateway", model: "deepseek", routeDecisionDigest: "d".repeat(64) } },
    });
    assert.equal(fabricated.ok, false);
    assert.equal(fabricated.code, "replacement-route-invalid");
    const second = replaceAttempt({ boardPath, cardId: ids[0], envelopeId: first.envelope.envelopeId,
      reason: "worker-unresponsive", replacement: {} });
    assert.equal(second.ok, true, second.reason);
    assert.equal(second.claim.parentClaimId, first.envelope.envelopeId);
    assert.equal(second.claim.attemptIndex, 1);
    assert.equal(second.envelope.seatId, routedClaim.seatId);
    assert.equal(second.envelope.routeDecisionDigest, routedClaim.routeDecisionDigest);
    // A third attempt indexes again.
    const third = replaceAttempt({
      boardPath, cardId: ids[0], envelopeId: second.envelope.envelopeId,
      reason: "failed",
      replacement: {},
    });
    assert.equal(third.claim.attemptIndex, 2);
    assert.equal(third.claim.parentClaimId, second.envelope.envelopeId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("replacement: same-seat replacement is pinned to the prior authenticated envelope route", () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir);
    const first = claimCard({ boardPath, role: "implementer", cardId: ids[0], route: routedClaim });
    assert.equal(first.ok, true);
    const envelopeId = first.envelope.envelopeId;
    // Same seatId, but EVERY other route field swapped via caller-supplied
    // replacement.route is refused — the envelope is the authority and a
    // same-seat replacement may not swap digest/model/provider/account/
    // effort/tier/phase/reservation underneath it.
    const mutations = [
      { routeDecisionDigest: "d".repeat(64) },
      { model: "other/model" },
      { provider: "openai" },
      { accountId: "acct-other" },
      { reservationId: "res.swapped" },
      { effort: "high" },
      { containmentTier: "testudo" },
      { phase: "review" },
      { role: "reviewer" },
    ];
    for (const mutation of mutations) {
      const attempt = replaceAttempt({
        boardPath, cardId: ids[0], envelopeId, reason: "worker-unresponsive",
        replacement: { route: { ...routedClaim, ...mutation } },
      });
      assert.equal(attempt.ok, false, `mutation ${JSON.stringify(mutation)} must be refused`);
      assert.equal(attempt.code, "replacement-route-invalid");
      assert.match(attempt.reason, /pinned to every field of the prior authenticated envelope/);
    }
    // An EXACT same-seat route (all fields identical to the prior envelope)
    // is accepted: it reuses the envelope and its lineage.
    const exact = replaceAttempt({
      boardPath, cardId: ids[0], envelopeId, reason: "worker-unresponsive",
      replacement: { route: { ...routedClaim } },
    });
    assert.equal(exact.ok, true, exact.reason ?? "");
    assert.equal(exact.envelope.seatId, routedClaim.seatId);
    assert.equal(exact.envelope.routeDecisionDigest, routedClaim.routeDecisionDigest);
    assert.equal(exact.envelope.model, routedClaim.model);
    assert.equal(exact.claim.parentClaimId, envelopeId);
    // The refusal mutated nothing: exactly one claim remains on the card and
    // the refused attempts consumed no envelope.
    const claims = readClaims(boardPath);
    assert.equal(claims.filter((c) => c.cardId === ids[0]).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lineage digest is deterministic", () => {
  const a = lineageDigest({ parentDecisionId: "p", oldEnvelopeId: "e", attemptIndex: 1 });
  const b = lineageDigest({ parentDecisionId: "p", oldEnvelopeId: "e", attemptIndex: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// §5.2 spawn-vs-envelope validation seam
// ---------------------------------------------------------------------------

test("spawn seam: model/provider/seat must exactly match the authenticated envelope", async () => {
  const { pulseWorkerSpawnSeam, validateSpawnMatchesEnvelope } = await import("../scripts/enforcement/pulse_scheduler_pi.js");
  const envelope = { model: "zai/glm-5.3", provider: "llama-server", seatId: "spark" };
  assert.equal(validateSpawnMatchesEnvelope({ envelope, model: "zai/glm-5.3", provider: "llama-server", seatId: "spark" }).ok, true);
  assert.equal(validateSpawnMatchesEnvelope({ envelope, model: "other/model" }).ok, false);
  assert.equal(validateSpawnMatchesEnvelope({ envelope, model: "zai/glm-5.3", provider: "other" }).ok, false);
  assert.equal(validateSpawnMatchesEnvelope({ envelope, model: "zai/glm-5.3", seatId: "merge" }).ok, false);
  assert.equal(validateSpawnMatchesEnvelope({ envelope: null, model: "zai/glm-5.3" }).ok, false);
  // The seam itself refuses before any Herdr call on mismatch.
  let called = 0;
  const seam = pulseWorkerSpawnSeam({ executeHerdrSpawnWorker: async () => { called += 1; return { ok: true }; } });
  const mismatch = await seam({ role: "implementer", repository: "/w", model: "other/model", placement: "host", context: null, signal: null, envelope });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "route-mismatch");
  assert.equal(called, 0);
  // The seam's repository guard is orthogonal (it resolves against
  // context.cwd); a passing route check reaches the repository check, which
  // fails with repository-mismatch — never route-mismatch — proving the
  // route gate passed and the lifecycle seam was reached.
  const match = await seam({ role: "implementer", repository: "/w", model: "zai/glm-5.3", placement: "host", context: null, signal: null, envelope, provider: "llama-server", seatId: "spark" });
  assert.equal(match.code, "repository-mismatch"); // past the route gate
  assert.notEqual(match.code, "route-mismatch");
});
