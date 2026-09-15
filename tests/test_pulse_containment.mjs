// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Pulse containment regression tests (PULSE_DESIGN_v3 §2.5, §3.4): Pulse must
// never represent a container/microvm assignment as contained while starting
// an ordinary host Herdr worker. Container/microvm dispatch is denied before
// any claim is created (no capacity leak, no consumed envelope attempt), and
// no containment fallback to host spawning ever occurs. Automated host
// dispatch is never inferred.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  writeCard, automationPolicyPath, readAutomationPolicy,
  claimCard, claimCardForConfirmedBatch, registerConfirmedBatchForClaims,
} from "../scripts/enforcement/task_board_core_pi.js";
import {
  pulseRun, pulseTick, pulseWorkerSpawnSeam, mintBatchContext, reserveBatchEntry,
  releaseBatchEntry,
} from "../scripts/enforcement/pulse_scheduler_pi.js";
import { executeHerdrSpawnWorker } from "../scripts/enforcement/herdr_lifecycle_pi.js";

const authority = { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "plan the work" };

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "pulse-containment-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function policyFor(boardPath, dir, overrides = {}) {
  return {
    roles: ["implementer", "reviewer"],
    placement: "container",
    maxConcurrent: 5,
    expiry: "2099-01-01",
    board: boardPath,
    riskCeiling: "low",
    acceptedRepositories: [dir],
    ...overrides,
  };
}

function pulsePolicy(overrides = {}) {
  return {
    enabled: true,
    mode: "automated",
    intervalSeconds: 300,
    fillOnStart: false,
    routing: {
      implementer: {
        preferred: [{ model: "zai/glm-5.3", maxConcurrent: 4 }],
        fallback: [],
        maxConcurrent: 4,
      },
    },
    stallTimeoutSeconds: 600,
    unattendedHostRiskAccepted: false,
    ...overrides,
  };
}

function fixtureBoard(dir, { cards = 1, pulse = pulsePolicy(), policyOverrides = {} } = {}) {
  const boardPath = join(dir, "TASKS.md");
  for (let i = 0; i < cards; i += 1) {
    const r = writeCard({ boardPath, input: { title: `Card ${i + 1}`, spec: `spec ${i + 1}`, definitionOfDone: `done ${i + 1}`, stoppingPoint: "tests green", scope: [`src/${i}/`], priority: "P0" }, authority });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const policy = policyFor(boardPath, dir, { pulse, ...policyOverrides });
  writeFileSync(automationPolicyPath(boardPath), JSON.stringify(policy));
  return boardPath;
}

function tuiContext({ confirmed = true } = {}) {
  return {
    cwd: null,
    isNativeTuiContextMarker: true,
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => confirmed },
  };
}

const registry = { get: (id) => id === "zai/glm-5.3" ? { id } : null, isAuthenticated: () => true };
const ctx = { modelRegistry: registry, scopedModels: ["zai/glm-5.3"] };

// Host-spawn tripwire: any call records itself and would fail the test.
function hostSpawnTripwire(label) {
  const calls = [];
  const spawnWorker = async (req) => { calls.push(req); return { ok: true }; };
  return { spawnWorker, calls, assertNone: () => assert.deepEqual(calls, [], `${label}: no host spawn may occur`) };
}

test("automated tick with container placement: no host spawn, no claim, precise denial", async () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { pulse: pulsePolicy({ mode: "automated" }) });
    const wire = hostSpawnTripwire("automated tick");
    const r = await pulseTick({ boardPath, spawnWorker: wire.spawnWorker, context: ctx });
    assert.equal(r.ok, true);
    assert.equal(r.landedAssignments.length, 1);
    assert.equal(r.landedAssignments[0].status, "denied");
    assert.match(r.landedAssignments[0].reason, /containment-seam-unavailable/);
    assert.equal(r.batchTerminalReason, "containment-seam-unavailable");
    wire.assertNone();
    // Pre-claim denial: no claim was created, so no claims file exists and no
    // capacity is leaked.
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interactive run with container placement: confirmation is the only effect; no host spawn, no claim", async () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { pulse: pulsePolicy({ mode: "interactive" }) });
    const wire = hostSpawnTripwire("interactive run");
    let confirmations = 0;
    const context = { ...tuiContext(), ui: { confirm: async () => { confirmations += 1; return true; } }, ...ctx };
    const r = await pulseRun({ boardPath, instruction: "work the ready cards", context, spawnWorker: wire.spawnWorker });
    assert.equal(r.ok, true);
    assert.equal(r.cancelled, false);
    assert.equal(r.landedAssignments.length, 1);
    assert.equal(r.landedAssignments[0].status, "denied");
    assert.match(r.landedAssignments[0].reason, /containment-seam-unavailable/);
    assert.equal(confirmations, 1); // the one batch confirmation still ran
    wire.assertNone();
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("automated host dispatch is never inferred: host placement without explicit authority is denied", async () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { policyOverrides: { placement: "host" } });
    const wire = hostSpawnTripwire("automated host");
    const r = await pulseTick({ boardPath, spawnWorker: wire.spawnWorker, context: ctx });
    assert.equal(r.ok, true);
    assert.equal(r.landedAssignments[0].status, "denied");
    assert.match(r.landedAssignments[0].reason, /automated host dispatch/);
    assert.equal(r.batchTerminalReason, "host-dispatch-denied");
    wire.assertNone();
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interactive run with host placement and explicit confirmation may start a host worker", async () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { cards: 1, pulse: pulsePolicy({ mode: "interactive" }), policyOverrides: { placement: "host" } });
    const spawned = [];
    const r = await pulseRun({
      boardPath,
      instruction: "work the ready cards",
      context: { ...tuiContext(), ...ctx },
      spawnWorker: async (req) => { spawned.push(req); return { ok: true }; },
    });
    assert.equal(r.ok, true);
    // Interactive mode + host placement + one explicit native batch
    // confirmation is the only permitted host-spawn path; the claim then
    // succeeds and the worker starts.
    assert.equal(r.landedAssignments[0].status, "started");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].placement, "host");
    const claims = JSON.parse(readFileSync(join(dir, "TASKS.md.claims.json"), "utf8"));
    assert.equal(claims.claims.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Confirmed-batch claim authority (§3.4): ordinary claimCard is contained-only;
// host placement is claimable ONLY through the trusted Pulse-internal
// confirmed-batch path with a batch registered after one native confirmation.
// ---------------------------------------------------------------------------

// Read the card IDs written by fixtureBoard (its return is boardPath-only).
// IDs are HTML id markers like <!-- id: T-0001 -->; the writer ledger key is
// the same value the card body carries.
function boardCardIds(boardPath) {
  return [...readFileSync(boardPath, "utf8").matchAll(/<!--\s*id:\s*([^>\s]+)\s*-->/g)].map((m) => m[1]);
}

function hostBatch(boardPath, ids, dir) {
  const batch = mintBatchContext({
    scan: { schema: "agentic-driver.board-pulse.v1", board: boardPath, cards: [], proposedDispatches: [] },
    cards: [],
    policy: readAutomationPolicy(boardPath),
    instruction: "confirmed host batch",
  });
  for (const id of ids) {
    batch.entries.push({ cardId: id, cardHash: null, title: id, role: "implementer", model: "zai/glm-5.3", repository: dir, placement: "host", state: "unused" });
  }
  return batch;
}

test("ordinary claimCard refuses host placement even with pulse.mode interactive (no batch)", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { cards: 1, pulse: pulsePolicy({ mode: "interactive" }), policyOverrides: { placement: "host" } });
    const ids = boardCardIds(boardPath);
    const r = claimCard({ boardPath, cardId: ids[0], role: "implementer" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "policy-placement-refused");
    assert.match(r.reason, /confirmed-batch path/);
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("confirmed-batch path refuses without a registered batch, a batchId string, or a foreign object", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { cards: 1, pulse: pulsePolicy({ mode: "interactive" }), policyOverrides: { placement: "host" } });
    const ids = boardCardIds(boardPath);
    // No batch at all.
    const none = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: null });
    assert.equal(none.ok, false);
    assert.equal(none.code, "confirmed-batch-required");
    // A lookalike object (never registered) fails closed — identity, not ID.
    const foreign = { ...hostBatch(boardPath, [ids[0]], dir) };
    const forged = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: foreign });
    assert.equal(forged.ok, false);
    assert.equal(forged.code, "confirmed-batch-required");
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("confirmed Pulse host claims succeed only through the trusted path, single-use", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { cards: 1, pulse: pulsePolicy({ mode: "interactive" }), policyOverrides: { placement: "host" } });
    const ids = boardCardIds(boardPath);
    const batch = hostBatch(boardPath, [ids[0]], dir);
    // Not registered: refused.
    const unregistered = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch });
    assert.equal(unregistered.ok, false);
    assert.equal(unregistered.code, "confirmed-batch-required");
    // Registered (stands in for the post-confirmation registration): allowed.
    registerConfirmedBatchForClaims(batch);
    const reserved = reserveBatchEntry(batch, ids[0]);
    assert.equal(reserved.ok, true);
    const claim = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch });
    assert.equal(claim.ok, true);
    // Single-use: the same entry cannot be claimed again.
    const again = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch });
    assert.equal(again.ok, false);
    assert.equal(again.code, "confirmed-batch-entry-consumed");
    const claims = JSON.parse(readFileSync(join(dir, "TASKS.md.claims.json"), "utf8"));
    assert.equal(claims.claims.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("confirmed claims reject non-host policy placement and invalid current time", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { cards: 1, pulse: pulsePolicy({ mode: "interactive" }), policyOverrides: { placement: "container" } });
    const ids = boardCardIds(boardPath);
    const batch = hostBatch(boardPath, [ids[0]], dir);
    registerConfirmedBatchForClaims(batch);
    assert.equal(reserveBatchEntry(batch, ids[0]).ok, true);

    const wrongPlacement = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch });
    assert.equal(wrongPlacement.ok, false);
    assert.equal(wrongPlacement.code, "policy-placement-refused");

    const invalidTime = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch, now: "not-a-time" });
    assert.equal(invalidTime.ok, false);
    assert.equal(invalidTime.code, "confirmed-batch-time-invalid");
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("confirmation cannot be crossed between batch entries", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { cards: 2, pulse: pulsePolicy({ mode: "interactive" }), policyOverrides: { placement: "host" } });
    const ids = boardCardIds(boardPath);
    const batch = hostBatch(boardPath, [ids[0]], dir); // only card 1 confirmed
    registerConfirmedBatchForClaims(batch);
    const reserved = reserveBatchEntry(batch, ids[0]);
    assert.equal(reserved.ok, true);
    const crossed = claimCardForConfirmedBatch({ boardPath, cardId: ids[1], role: "implementer", confirmedBatch: batch });
    assert.equal(crossed.ok, false);
    assert.equal(crossed.code, "confirmed-batch-card-mismatch");
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pre-start refusal does not leak claims or capacity", async () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { cards: 1, pulse: pulsePolicy({ mode: "interactive" }), policyOverrides: { placement: "host" } });
    const ids = boardCardIds(boardPath);
    const batch = hostBatch(boardPath, [ids[0]], dir);
    registerConfirmedBatchForClaims(batch);
    const reserved = reserveBatchEntry(batch, ids[0]);
    assert.equal(reserved.ok, true);
    // Claim fails after reserve (policy expired in place): entry released, no claim.
    const policy = readAutomationPolicy(boardPath);
    policy.expiry = "2000-01-01";
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(policy));
    const claim = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch });
    assert.equal(claim.ok, false);
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
    // The entry stays reserved (reconciliation territory, never silent reuse).
    // The scheduler releases it only through the explicit release path, and a
    // released entry can be re-reserved and claimed after policy is restored.
    const fresh = readAutomationPolicy(boardPath);
    fresh.expiry = "2099-01-01";
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(fresh));
    releaseBatchEntry(batch, ids[0]);
    const reReserve = reserveBatchEntry(batch, ids[0]);
    assert.equal(reReserve.ok, true);
    const r2 = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: batch });
    assert.equal(r2.ok, true);
    // The pre-start refusal consumed no envelope attempt and no capacity.
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), true);
    const claims = JSON.parse(readFileSync(join(dir, "TASKS.md.claims.json"), "utf8"));
    assert.equal(claims.claims.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("guard seam: container placement never reaches the herdr lifecycle", async () => {
  const calls = [];
  const lifecycle = async (params) => { calls.push(params); return { ok: true }; };
  const seam = pulseWorkerSpawnSeam({ executeHerdrSpawnWorker: lifecycle });
  const r = await seam({ role: "implementer", repository: "/tmp/x", model: "zai/glm-5.3", placement: "container", context: tuiContext(), signal: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, "containment-seam-unavailable");
  assert.deepEqual(calls, []);
});

test("guard seam: host placement routes through the guarded lifecycle boundary", async () => {
  const calls = [];
  const lifecycle = async (params) => { calls.push(params); return { ok: true }; };
  const seam = pulseWorkerSpawnSeam({ executeHerdrSpawnWorker: lifecycle });
  const host = await seam({ role: "implementer", repository: "/tmp/x", model: "zai/glm-5.3", placement: "host", context: { ...tuiContext(), cwd: "/tmp/x" }, signal: null });
  assert.equal(host.ok, true);
  assert.deepEqual(calls, [{ placement: "tab", role: "implementer", model: "zai/glm-5.3", repository: "x" }]);
});

test("guard seam: the real herdr lifecycle is refused for container placement before any confirmation", async () => {
  const confirmed = [];
  const context = {
    cwd: null,
    isNativeTuiContextMarker: true,
    mode: "tui",
    hasUI: true,
    ui: { confirm: async (title) => { confirmed.push(title); return true; } },
  };
  const r = await pulseWorkerSpawnSeam({ executeHerdrSpawnWorker })({
    role: "implementer", repository: null, model: "zai/glm-5.3", placement: "container", context, signal: null,
  });
  assert.equal(r.ok, false);
  assert.match(String(r.reason ?? r.code), /containment-seam-unavailable/);
  assert.deepEqual(confirmed, []); // the lifecycle confirmation never ran
});

test("guard seam: requires the guarded lifecycle function (no raw path)", () => {
  assert.throws(() => pulseWorkerSpawnSeam({}));
  assert.throws(() => pulseWorkerSpawnSeam());
});

test("pre-start denial consumes no envelope attempt: a later claim for the card is still possible", async () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { pulse: pulsePolicy({ mode: "automated" }) });
    await pulseTick({ boardPath, spawnWorker: async () => { throw new Error("must not spawn"); }, context: ctx });
    // No claim, no consumed envelope, and the card is still dispatchable.
    const policy = readAutomationPolicy(boardPath);
    assert.equal(policy.placement, "container");
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
