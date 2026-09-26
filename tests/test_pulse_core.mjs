// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Pulse tests (PULSE_DESIGN_v3 §15): closed policy validation, the five
// Pulse results, ordering, routing/fallback, and composed capacity.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAutomationPolicy, checkPulsePolicy, canonicalJsonString, sha256Hex,
  computeCardHash, computeSpecHash, authorityRecordHmac,
} from "../scripts/enforcement/task_board_core_pi.js";
import {
  PULSE_RESULTS, PULSE_SCAN_SCHEMA, modelAvailability, modelUsable,
  freeCapacity, routesForRole, evaluateCard, scanBoard,
} from "../scripts/enforcement/pulse_core_pi.js";
import {
  resolveInstalledModel, validateSpawnParams,
} from "../scripts/enforcement/herdr_lifecycle_pi.js";

const basePolicy = {
  roles: ["implementer", "reviewer"],
  placement: "container",
  maxConcurrent: 5,
  expiry: "2030-01-01T00:00:00.000Z",
  envelopeExpiryHours: 12,
  board: "/workspace/TASKS.md",
  riskCeiling: "medium",
  allowPerCardRiskOverride: false,
  acceptedRepositories: ["/workspace"],
};

const basePulse = {
  enabled: true,
  mode: "interactive",
  intervalSeconds: 300,
  fillOnStart: true,
  routing: {
    implementer: {
      preferred: [{ model: "zai/glm-5.3", maxConcurrent: 4 }],
      fallback: [{ model: "opencode-go/glm-5.3", maxConcurrent: 2 }],
      maxConcurrent: 4,
    },
    reviewer: {
      preferred: [{ model: "openai-codex/gpt-5.6-sol", maxConcurrent: 1 }],
      fallback: [],
      maxConcurrent: 1,
    },
  },
  stallTimeoutSeconds: 600,
  unattendedHostRiskAccepted: false,
};

function policyWith(pulse) {
  return { ...basePolicy, pulse };
}

function card(overrides = {}) {
  const c = {
    cardId: "T1", title: "Card one", lane: "backlog", flags: [],
    priority: "P1", role: "implementer", dependencies: [],
    capabilities: [], stoppingPoint: "tests green",
    specHash: computeSpecHash("spec"), dodHash: computeSpecHash("done"),
    specText: "spec", dodText: "done",
    scope: ["src/"], unchangedPaths: [], repositories: ["/workspace"],
    tags: [], description: "", done: false, base: null, due: null,
    authoritySource: { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "do it" },
    ...overrides,
  };
  c.hash = overrides.hash ?? computeCardHash(c);
  c.authorityWriterHmac = authorityRecordHmac(c.authoritySource, "test-secret", c.hash);
  return c;
}

test("policy without pulse object is unchanged and valid", () => {
  const result = checkAutomationPolicy(basePolicy, { boardPath: "/workspace/TASKS.md" });
  assert.equal(result.ok, true);
});

test("closed pulse policy accepts the contract example", () => {
  const result = checkPulsePolicy(basePulse, { roles: basePolicy.roles });
  assert.equal(result.ok, true);
});

test("pulse unknown fields fail closed", () => {
  const result = checkPulsePolicy({ ...basePulse, cron: "* * * * *" }, { roles: basePolicy.roles });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fails closed/);
});

test("pulse accepts bounded nested, local-provider, and colon model IDs", () => {
  for (const model of [
    "merge-gateway/zai/glm-5.3-flash",
    "glm53fdf/glm-5.3-flash-exl3",
    "openrouter/meta-llama/llama-3.3:free",
  ]) {
    const pulse = structuredClone(basePulse);
    pulse.routing.implementer.preferred[0].model = model;
    assert.equal(checkPulsePolicy(pulse, { roles: basePolicy.roles }).ok, true, model);
  }
});

test("pulse rejects empty, malformed, traversal, whitespace, and overlong model IDs", () => {
  const invalid = [
    "", "provider/", "/model", "provider//model", "provider/../model",
    "provider/model name", "provider/model?free", `${"p".repeat(65)}/model`,
    `provider/${"m".repeat(184)}`,
  ];
  for (const model of invalid) {
    const pulse = structuredClone(basePulse);
    pulse.routing.implementer.preferred[0].model = model;
    const result = checkPulsePolicy(pulse, { roles: basePolicy.roles });
    assert.equal(result.ok, false, model);
    assert.match(result.reason, /fails closed/);
  }
});

test("Herdr lifecycle validation and resolution preserve exact nested model IDs", () => {
  const nested = "merge-gateway/zai/glm-5.3-flash";
  const local = "glm53fdf/glm-5.3-flash-exl3";
  const colon = "openrouter/meta-llama/llama-3.3:free";
  const params = (model) => ({ placement: "tab", role: "implementer", model, repository: "driver-agents" });
  for (const model of [nested, local, colon]) {
    assert.equal(validateSpawnParams(params(model)).model, model);
  }
  for (const model of ["provider/../model", "provider//model", "provider/model name", `provider/${"m".repeat(184)}`]) {
    assert.throws(() => validateSpawnParams(params(model)), (error) => error.code === "model_denied");
  }
  const listModels = [
    "provider model context input output",
    "merge-gateway zai/glm-5.3-flash 131k text text",
    "glm53fdf glm-5.3-flash-exl3 131k text text",
    "openrouter meta-llama/llama-3.3:free 131k text text",
  ].join("\n");
  assert.deepEqual(resolveInstalledModel(nested, { listModels, modelsPath: "/does/not/exist" }), ["--model", nested]);
  assert.deepEqual(resolveInstalledModel(local, { listModels, modelsPath: "/does/not/exist" }), ["--model", local]);
  assert.deepEqual(resolveInstalledModel(colon, { listModels, modelsPath: "/does/not/exist" }), ["--model", colon]);
});

test("pulse requires enabled boolean and rejects bad mode/interval", () => {
  assert.equal(checkPulsePolicy({ ...basePulse, enabled: "yes" }, { roles: basePolicy.roles }).ok, false);
  assert.equal(checkPulsePolicy({ ...basePulse, mode: "cron" }, { roles: basePolicy.roles }).ok, false);
  assert.equal(checkPulsePolicy({ ...basePulse, intervalSeconds: 5 }, { roles: basePolicy.roles }).ok, false);
  assert.equal(checkPulsePolicy({ ...basePulse, intervalSeconds: 90000 }, { roles: basePolicy.roles }).ok, false);
});

test("pulse routing roles must be declared in policy roles", () => {
  const pulse = { ...basePulse, routing: { ghost: basePulse.routing.implementer } };
  const result = checkPulsePolicy(pulse, { roles: basePolicy.roles });
  assert.equal(result.ok, false);
  assert.match(result.reason, /absent from the policy roles/);
});

test("pulse duplicate model across preferred and fallback fails closed", () => {
  const pulse = JSON.parse(JSON.stringify(basePulse));
  pulse.routing.implementer.fallback = [{ model: "zai/glm-5.3", maxConcurrent: 2 }];
  assert.equal(checkPulsePolicy(pulse, { roles: basePolicy.roles }).ok, false);
});

test("pulse capacities must be integers 1..32", () => {
  const pulse = JSON.parse(JSON.stringify(basePulse));
  pulse.routing.implementer.preferred[0].maxConcurrent = 0;
  assert.equal(checkPulsePolicy(pulse, { roles: basePolicy.roles }).ok, false);
  pulse.routing.implementer.preferred[0].maxConcurrent = 33;
  assert.equal(checkPulsePolicy(pulse, { roles: basePolicy.roles }).ok, false);
  pulse.routing.implementer.preferred[0].maxConcurrent = 32;
  assert.equal(checkPulsePolicy(pulse, { roles: basePolicy.roles }).ok, true);
});

test("checkAutomationPolicy rejects a malformed pulse object in place", () => {
  const result = checkAutomationPolicy(policyWith({ enabled: true }), { boardPath: basePolicy.board });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pulse/);
});

test("all five pulse results are the closed set", () => {
  assert.deepEqual([...PULSE_RESULTS], ["READY_FOR_NEXT", "BLOCKED", "STALE", "DENIED", "REVIEW_REQUIRED"]);
});

test("model availability resolves declared routes and fails closed otherwise", () => {
  const observations = { "zai/glm-5.3": { status: "available" } };
  assert.equal(modelAvailability({ model: "zai/glm-5.3", observations, declaredModels: ["zai/glm-5.3"] }), "available");
  assert.equal(modelAvailability({ model: "zai/glm-5.3", observations, declaredModels: ["other/model"] }), "unknown");
  assert.equal(modelAvailability({ model: "zai/glm-5.3", observations: null }), "unknown");
  assert.equal(modelUsable("available"), true);
  // §9 correction: "full" is unusable unless an explicit provider limit says
  // otherwise — a bare full fails closed.
  assert.equal(modelUsable("full"), false);
  assert.equal(modelUsable("full", { providerLimit: 0 }), false);
  assert.equal(modelUsable("full", { providerLimit: 2 }), false);
  assert.equal(modelUsable("full", { providerLimit: 2, providerActive: 1 }), true);
  assert.equal(modelUsable("full", { providerLimit: 2, providerActive: 2 }), false);
  assert.equal(modelUsable("unauthenticated"), false);
  assert.equal(modelUsable("unknown"), false);
});

test("free capacity composes route, role, and policy-wide ceilings", () => {
  const free = freeCapacity({
    role: "implementer", model: "zai/glm-5.3", pulsePolicy: basePulse,
    activeClaims: [], activeSessions: [],
  });
  assert.equal(free.free, 4);
  assert.equal(free.configured, 4);
});

test("free capacity subtracts unique active claims and deduplicates bound sessions", () => {
  const claims = [
    { cardId: "T1", role: "implementer", envelopeId: "e1", envelope: { model: "zai/glm-5.3" }, sessionId: "s1" },
    { cardId: "T2", role: "implementer", envelopeId: "e2", envelope: { model: "zai/glm-5.3" } },
  ];
  const sessions = [{ role: "implementer", model: "zai/glm-5.3", sessionId: "s1" }];
  const free = freeCapacity({
    role: "implementer", model: "zai/glm-5.3", pulsePolicy: basePulse,
    activeClaims: claims, activeSessions: sessions,
  });
  assert.equal(free.free, 2); // 4 - 2 unique claims; s1 counts once
});

test("unreconciled orphan sessions consume capacity and block duplicate spawn", () => {
  const sessions = [{ role: "implementer", model: "zai/glm-5.3", sessionId: "orphan" }];
  const free = freeCapacity({
    role: "implementer", model: "zai/glm-5.3", pulsePolicy: basePulse,
    activeClaims: [], activeSessions: sessions,
  });
  assert.equal(free.free, 3);
});

test("routes order is preferred then declared fallback", () => {
  const routes = routesForRole("implementer", basePulse);
  assert.deepEqual(routes.map((r) => r.model), ["zai/glm-5.3", "opencode-go/glm-5.3"]);
  assert.deepEqual(routes.map((r) => r.tier), ["preferred", "fallback"]);
});

test("evaluateCard: READY_FOR_NEXT for a dispatchable card under enabled policy", () => {
  const index = new Map([[ "T1", card() ]]);
  const result = evaluateCard({
    card: card(), boardIndex: index,
    activeClaims: [], pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "available" } },
    declaredModels: ["zai/glm-5.3"],
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(result.result, "READY_FOR_NEXT");
});

test("evaluateCard: full is usable only with explicit providerLimit AND providerActive headroom", () => {
  const index = new Map([[ "T1", card() ]]);
  const inputs = (overrides = {}) => ({
    card: card(), boardIndex: index,
    activeClaims: [], pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "full" } },
    declaredModels: ["zai/glm-5.3"],
    acceptedRepositories: basePolicy.acceptedRepositories,
    ...overrides,
  });
  // No capacity facts at all: fails closed (REVIEW_REQUIRED).
  assert.equal(evaluateCard(inputs()).result, "REVIEW_REQUIRED");
  // providerLimit alone is not enough — active must show headroom.
  assert.equal(evaluateCard(inputs({ providerLimit: 3 })).result, "REVIEW_REQUIRED");
  // providerLimit with providerActive headroom (per-model map) → usable.
  const withHeadroom = evaluateCard(inputs({ providerLimit: 3, providerActive: { "zai/glm-5.3": 1 } }));
  assert.equal(withHeadroom.result, "READY_FOR_NEXT");
  assert.deepEqual(withHeadroom.routes.map((r) => r.model), ["zai/glm-5.3"]);
  // providerActive at the ceiling → no headroom → fails closed.
  assert.equal(evaluateCard(inputs({ providerLimit: 3, providerActive: { "zai/glm-5.3": 3 } })).result, "REVIEW_REQUIRED");
});

test("evaluateCard: BLOCKED for claimed card and dependency failure", () => {
  const claims = [{ cardId: "T1", role: "implementer", envelopeId: "e1", envelope: { model: "zai/glm-5.3" } }];
  const index = new Map([[ "T1", card() ]]);
  const claimed = evaluateCard({
    card: card(), boardIndex: index,
    activeClaims: claims, pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "available" } },
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(claimed.result, "BLOCKED");
  const dep = card({ cardId: "T2", dependencies: ["T9"] });
  const index2 = new Map([[ "T2", dep ]]);
  const blocked = evaluateCard({
    card: dep, boardIndex: index2,
    activeClaims: [], pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "available" } },
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(blocked.result, "BLOCKED");
});

test("evaluateCard: STALE for a tampered card hash", () => {
  const stale = card({ hash: "f".repeat(64) });
  const index = new Map([[ "T1", stale ]]);
  const result = evaluateCard({
    card: stale, boardIndex: index,
    activeClaims: [], pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "available" } },
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(result.result, "STALE");
});

test("evaluateCard: DENIED for undeclared role route and unaccepted repository", () => {
  const index = new Map([[ "T1", card() ]]);
  const noRoute = evaluateCard({
    card: card({ role: "ghost" }), boardIndex: index,
    activeClaims: [], pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "available" } },
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(noRoute.result, "DENIED");
  const badRepo = evaluateCard({
    card: card({ repositories: ["/elsewhere"] }), boardIndex: index,
    activeClaims: [], pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "available" } },
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(badRepo.result, "DENIED");
});

test("evaluateCard: REVIEW_REQUIRED when no usable declared route exists", () => {
  const index = new Map([[ "T1", card() ]]);
  const result = evaluateCard({
    card: card(), boardIndex: index,
    activeClaims: [], pulsePolicy: basePulse,
    modelObservations: { "zai/glm-5.3": { status: "unauthenticated" } },
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(result.result, "REVIEW_REQUIRED");
});

test("evaluateCard: REVIEW_REQUIRED when Pulse is disabled", () => {
  const index = new Map([[ "T1", card() ]]);
  const result = evaluateCard({
    card: card(), boardIndex: index,
    activeClaims: [], pulsePolicy: { ...basePulse, enabled: false },
    modelObservations: { "zai/glm-5.3": { status: "available" } },
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(result.result, "REVIEW_REQUIRED");
});

function fixtureCards() {
  return [
    card({ cardId: "T2", title: "Second", priority: "P1" }),
    card({ cardId: "T1", title: "First", priority: "P0" }),
    card({ cardId: "T3", title: "Third", priority: "P3" }),
  ];
}

function fullObservations(models) {
  const observations = {};
  for (const model of models) observations[model] = { status: "available" };
  return observations;
}

test("scanBoard orders cards P0→P3 then card-ID and proposes in selection order", () => {
  const { scan } = scanBoard({
    cards: fixtureCards(),
    placement: basePolicy.placement,
    pulsePolicy: basePulse, modelObservations: fullObservations(["zai/glm-5.3"]),
    acceptedRepositories: basePolicy.acceptedRepositories,
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(scan.schema, PULSE_SCAN_SCHEMA);
  assert.deepEqual(scan.cards.map((c) => c.title), ["First", "Second", "Third"]);
  assert.equal(scan.authorityCreated, false);
  assert.equal(scan.proposedDispatches.length, 3);
  assert.deepEqual(scan.proposedDispatches[0], { title: "First", role: "implementer", model: "zai/glm-5.3", placement: "container" });
});

test("scanBoard proposes at most free capacity and keeps card result stable", () => {
  const claims = [
    { cardId: "T9", role: "implementer", envelopeId: "e1", envelope: { model: "zai/glm-5.3" } },
    { cardId: "T8", role: "implementer", envelopeId: "e2", envelope: { model: "zai/glm-5.3" } },
    { cardId: "T7", role: "implementer", envelopeId: "e3", envelope: { model: "zai/glm-5.3" } },
    { cardId: "T6", role: "implementer", envelopeId: "e4", envelope: { model: "zai/glm-5.3" } },
  ];
  const { scan } = scanBoard({
    cards: fixtureCards(),
    pulsePolicy: basePulse, modelObservations: fullObservations(["zai/glm-5.3"]),
    activeClaims: claims, acceptedRepositories: basePolicy.acceptedRepositories,
  });
  // Preferred route is full (4/4); no authorised fallback observed usable.
  assert.equal(scan.proposedDispatches.length, 0);
  assert.deepEqual(scan.cards.map((c) => c.result), ["READY_FOR_NEXT", "READY_FOR_NEXT", "READY_FOR_NEXT"]);
  const capacityEntry = scan.capacity.find((c) => c.model === "zai/glm-5.3");
  assert.equal(capacityEntry.free, 0);
  assert.equal(capacityEntry.availability, "available");
});

test("scanBoard falls back only to declared fallback routes", () => {
  const claims = [
    { cardId: "T9", role: "implementer", envelopeId: "e1", envelope: { model: "zai/glm-5.3" } },
    { cardId: "T8", role: "implementer", envelopeId: "e2", envelope: { model: "zai/glm-5.3" } },
    { cardId: "T7", role: "implementer", envelopeId: "e3", envelope: { model: "zai/glm-5.3" } },
    { cardId: "T6", role: "implementer", envelopeId: "e4", envelope: { model: "zai/glm-5.3" } },
  ];
  const { scan } = scanBoard({
    cards: fixtureCards(),
    pulsePolicy: basePulse,
    modelObservations: fullObservations(["zai/glm-5.3", "opencode-go/glm-5.3"]),
    activeClaims: claims, acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(scan.proposedDispatches.length, 2); // fallback ceiling of 2
  assert.deepEqual(scan.proposedDispatches.map((p) => p.model),
    ["opencode-go/glm-5.3", "opencode-go/glm-5.3"]);
});

test("scanBoard never proposes without enabled pulse and reports capacity shapes", () => {
  const { scan } = scanBoard({
    cards: fixtureCards(),
    pulsePolicy: null, modelObservations: {},
  });
  assert.equal(scan.proposedDispatches.length, 0);
  assert.equal(scan.capacity.length, 0);
  assert.ok(scan.cards.every((c) => c.result === "REVIEW_REQUIRED"));
});

test("scanBoard diagnostic hash is canonical-JSON SHA-256 of the public scan", () => {
  const { scan, diagnosticHash } = scanBoard({
    cards: fixtureCards(),
    pulsePolicy: basePulse, modelObservations: fullObservations(["zai/glm-5.3"]),
    acceptedRepositories: basePolicy.acceptedRepositories,
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(diagnosticHash, sha256Hex(canonicalJsonString(scan)));
});

test("scanBoard: a review-lane card is BLOCKED and never proposed", () => {
  const review = card({ lane: "review" });
  const index = new Map([["T1", review]]);
  const { scan } = scanBoard({
    cards: [review], boardIndex: index,
    pulsePolicy: basePulse,
    modelObservations: fullObservations(["zai/glm-5.3", "openai-codex/gpt-5.6-sol"]),
    declaredModels: ["zai/glm-5.3", "openai-codex/gpt-5.6-sol"],
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  const entry = scan.cards[0];
  assert.equal(entry.result, "BLOCKED");
  assert.match(entry.reason, /lane/);
  assert.equal(scan.proposedDispatches.length, 0);
  // The reviewer route still reports its own independent capacity.
  const reviewer = scan.capacity.find((c) => c.role === "reviewer");
  assert.ok(reviewer, "reviewer route capacity is reported independently");
  assert.equal(reviewer.free, 1);
});

test("scanBoard: a reviewer card routes through the declared reviewer route, not the implementer route", () => {
  const reviewCard = card({ role: "reviewer" });
  const index = new Map([["T1", reviewCard]]);
  const { scan } = scanBoard({
    cards: [reviewCard], boardIndex: index,
    pulsePolicy: basePulse,
    modelObservations: fullObservations(["zai/glm-5.3", "openai-codex/gpt-5.6-sol"]),
    declaredModels: ["zai/glm-5.3", "openai-codex/gpt-5.6-sol"],
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(scan.cards[0].result, "READY_FOR_NEXT");
  assert.equal(scan.cards[0].role, "reviewer");
  assert.deepEqual(scan.proposedDispatches.map((p) => p.model), ["openai-codex/gpt-5.6-sol"]);
});

test("scanBoard: reviewer capacity refills independently after its claim is consumed", () => {
  const reviewCard = card({ role: "reviewer" });
  const index = new Map([["T1", reviewCard]]);
  const activeClaim = { cardId: "T1", role: "reviewer", envelopeId: "e1", envelope: { model: "openai-codex/gpt-5.6-sol" } };
  const withClaim = scanBoard({
    cards: [reviewCard], boardIndex: index,
    pulsePolicy: basePulse,
    modelObservations: fullObservations(["openai-codex/gpt-5.6-sol"]),
    declaredModels: ["openai-codex/gpt-5.6-sol"],
    activeClaims: [activeClaim],
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(withClaim.scan.cards[0].result, "BLOCKED");
  assert.equal(withClaim.scan.proposedDispatches.length, 0);
  // The claim is consumed (terminal attempt): capacity refills and the card
  // is proposed again on the reviewer route.
  const afterTerminal = scanBoard({
    cards: [reviewCard], boardIndex: index,
    pulsePolicy: basePulse,
    modelObservations: fullObservations(["openai-codex/gpt-5.6-sol"]),
    declaredModels: ["openai-codex/gpt-5.6-sol"],
    activeClaims: [],
    acceptedRepositories: basePolicy.acceptedRepositories,
  });
  assert.equal(afterTerminal.scan.cards[0].result, "READY_FOR_NEXT");
  assert.deepEqual(afterTerminal.scan.proposedDispatches.map((p) => p.model), ["openai-codex/gpt-5.6-sol"]);
});
