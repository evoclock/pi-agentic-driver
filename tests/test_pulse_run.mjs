// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pulse interactive run, batch context, policy operations, and timer tests
// (PULSE_DESIGN_v3 §15): immutable single-use batch context, one native
// confirmation, atomic claims, guarded spawns, semantic policy mutation with
// headless host-risk fail-closed, and timer lifecycle.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  writeCard, automationPolicyPath, readAutomationPolicy, claimCard,
  claimCardForConfirmedBatch, registerConfirmedBatchForClaims,
} from "../scripts/enforcement/task_board_core_pi.js";
import {
  pulseRun, pulseTick, mintBatchContext, reserveBatchEntry, consumeBatchEntry,
  releaseBatchEntry, batchExpired, pulsePolicyOperation, createPulseTimer,
  registerPulseTools, pulseWorkerSpawnSeam,
} from "../scripts/enforcement/pulse_scheduler_pi.js";

const authority = { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "plan the work" };

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "pulse-run-"));
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
    mode: "interactive",
    intervalSeconds: 300,
    fillOnStart: true,
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

function fixtureBoard(dir, { cards = 2, pulse = pulsePolicy(), policyOverrides = {} } = {}) {
  const boardPath = join(dir, "TASKS.md");
  const ids = [];
  for (let i = 0; i < cards; i += 1) {
    const r = writeCard({ boardPath, input: { title: `Card ${i + 1}`, spec: `spec ${i + 1}`, definitionOfDone: `done ${i + 1}`, stoppingPoint: "tests green", scope: [`src/${i}/`], priority: i === 0 ? "P0" : "P1" }, authority });
    assert.equal(r.ok, true, JSON.stringify(r));
    ids.push(r.cardId);
  }
  const policy = policyFor(boardPath, dir, { pulse, ...policyOverrides });
  writeFileSync(automationPolicyPath(boardPath), JSON.stringify(policy));
  return { boardPath, ids };
}

function tuiContext({ confirmed = true, modelRegistry = null, scopedModels = null } = {}) {
  return {
    cwd: null,
    isNativeTuiContextMarker: true,
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => confirmed },
    modelRegistry,
    scopedModels,
  };
}

const registry = { get: (id) => id === "zai/glm-5.3" ? { id } : null, isAuthenticated: () => true };

test("host spawn seam converts a canonical policy path to its trusted registry name", async () => {
  const calls = [];
  const seam = pulseWorkerSpawnSeam({
    executeHerdrSpawnWorker: async (params) => { calls.push(params); return { ok: true }; },
  });
  const result = await seam({
    role: "implementer", model: "zai/glm-5.3", placement: "host",
    repository: "/workspace/pi-dev-env", context: { cwd: "/workspace/pi-dev-env" }, signal: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ placement: "tab", role: "implementer", model: "zai/glm-5.3", repository: "pi-dev-env" }]);

  const mismatch = await seam({
    role: "implementer", model: "zai/glm-5.3", placement: "host",
    repository: "/untrusted/pi-dev-env", context: { cwd: "/workspace/pi-dev-env" }, signal: null,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "repository-mismatch");
  assert.equal(calls.length, 1);
});

test("run fails closed without a direct human instruction", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    const r = await pulseRun({ boardPath, instruction: "  ", context: tuiContext(), spawnWorker: async () => ({ ok: true }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "instruction-required");
    assert.equal(r.landedAssignments.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run fails closed when Pulse is disabled or absent", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { pulse: pulsePolicy({ enabled: false }) });
    const r = await pulseRun({ boardPath, instruction: "work the ready cards", context: tuiContext() });
    assert.equal(r.ok, false);
    assert.equal(r.code, "pulse-disabled");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run fails closed headlessly: the one batch confirmation requires the native TUI", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    const r = await pulseRun({ boardPath, instruction: "work the ready cards", context: { cwd: dir }, spawnWorker: async () => ({ ok: true }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "native-confirmation-required");
    assert.equal(r.landedAssignments.length, 0);
    // Nothing was claimed.
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run with one confirmation claims and starts one card; entry consumed after verified start", async () => {
  const dir = freshDir();
  try {
    // Host placement is required for an actual start: container placement is
    // denied with containment-seam-unavailable (no host fallback, ever).
    const { boardPath } = fixtureBoard(dir, { cards: 1, policyOverrides: { placement: "host" } });
    const spawned = [];
    const r = await pulseRun({
      boardPath,
      instruction: "work through the ready cards",
      context: tuiContext({ modelRegistry: registry, scopedModels: ["zai/glm-5.3"] }),
      spawnWorker: async (req) => { spawned.push(req); return { ok: true, role: req.role, modelArgv: ["pi", "--model", req.model] }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.cancelled, false);
    assert.equal(r.landedAssignments.length, 1);
    assert.equal(r.landedAssignments[0].status, "started");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].model, "zai/glm-5.3");
    assert.equal(spawned[0].repository, dir);
    // One claim exists and the envelope is active.
    const claims = JSON.parse(readFileSync(join(dir, "TASKS.md.claims.json"), "utf8"));
    assert.equal(claims.claims.length, 1);
    assert.equal(claims.claims[0].role, "implementer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run cancelled at the one confirmation claims nothing", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { cards: 1 });
    const r = await pulseRun({
      boardPath,
      instruction: "work the ready cards",
      context: tuiContext({ confirmed: false, modelRegistry: registry, scopedModels: ["zai/glm-5.3"] }),
      spawnWorker: async () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.cancelled, true);
    assert.equal(r.landedAssignments.length, 0);
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run respects capacity: two cards, ceiling four, both started in one batch", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { cards: 2, policyOverrides: { placement: "host" } });
    const r = await pulseRun({
      boardPath,
      instruction: "work through the ready cards with local implementers",
      context: tuiContext({ modelRegistry: registry, scopedModels: ["zai/glm-5.3"] }),
      spawnWorker: async () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.landedAssignments.length, 2);
    assert.ok(r.landedAssignments.every((a) => a.status === "started"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run: claim race removes the card from the landed batch and never double-claims", async () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir, { cards: 2, policyOverrides: { placement: "host" } });
    // Pre-claim card 1 outside Pulse: the scan marks it BLOCKED, the batch
    // excludes it entirely (a claim race removes the card from the landed
    // batch), and only card 2 lands. Card 1 is never double-claimed. Host
    // placement is only claimable through the trusted confirmed-batch path,
    // so the pre-claim uses it (registered after a minted, confirmed batch).
    const preBatch = mintBatchContext({
      scan: { schema: "agentic-driver.board-pulse.v1", board: boardPath, cards: [], proposedDispatches: [] },
      cards: [],
      policy: readAutomationPolicy(boardPath),
      instruction: "pre-claim card 1",
    });
    preBatch.entries.push({ cardId: ids[0], cardHash: null, title: "Card 1", role: "implementer", model: "zai/glm-5.3", repository: dir, placement: "host", state: "reserved" });
    registerConfirmedBatchForClaims(preBatch);
    const pre = claimCardForConfirmedBatch({ boardPath, cardId: ids[0], role: "implementer", confirmedBatch: preBatch });
    assert.equal(pre.ok, true);
    const r = await pulseRun({
      boardPath,
      instruction: "work the ready cards",
      context: tuiContext({ modelRegistry: registry, scopedModels: ["zai/glm-5.3"] }),
      spawnWorker: async () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.landedAssignments.length, 1);
    assert.equal(r.landedAssignments[0].status, "started");
    assert.equal(r.landedAssignments[0].title, "Card 2");
    // Card 1 keeps exactly its pre-existing claim; no duplicate claim landed.
    const claims = JSON.parse(readFileSync(join(dir, "TASKS.md.claims.json"), "utf8"));
    assert.equal(claims.claims.filter((c) => c.cardId === ids[0]).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("run: ambiguous spawn leaves the entry reserved and never spawns twice", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { cards: 1, policyOverrides: { placement: "host" } });
    let spawnCalls = 0;
    const r = await pulseRun({
      boardPath,
      instruction: "work the ready cards",
      context: tuiContext({ modelRegistry: registry, scopedModels: ["zai/glm-5.3"] }),
      spawnWorker: async () => { spawnCalls += 1; return { ok: false, reason: "delivery-unknown" }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.landedAssignments[0].status, "denied");
    assert.equal(spawnCalls, 1); // exactly one attempt; no reuse, no second start
    // The claim landed (the attempt is authenticated) but the batch entry was
    // not consumed — reconciliation territory, never duplicate spawn.
    const claims = JSON.parse(readFileSync(join(dir, "TASKS.md.claims.json"), "utf8"));
    assert.equal(claims.claims.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("batch context: mint covers full eligible list, single-use transitions are atomic", async () => {
  const dir = freshDir();
  try {
    const { boardPath, ids } = fixtureBoard(dir, { cards: 2 });
    const { pulseCheck } = await import("../scripts/enforcement/pulse_scheduler_pi.js");
    const check = pulseCheck({ boardPath, modelRegistry: registry, scopedModels: ["zai/glm-5.3"], observedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(check.ok, true);
    const policy = readAutomationPolicy(boardPath);
    const batch = mintBatchContext({ scan: check.scan, cards: check.validated.cards, policy, instruction: "work the ready cards", now: "2026-01-01T00:00:00.000Z" });
    assert.equal(batch.schema, "agentic-driver.pulse-batch.v1");
    assert.equal(batch.entries.length, 2); // full candidate list, not just free slots
    assert.deepEqual(batch.entries.map((e) => e.cardId), ids);
    assert.ok(batch.entries.every((e) => e.state === "unused"));
    assert.equal(batch.maxConcurrency, 5);
    // Reserve → consume path (fixed test clock inside the batch window).
    const AT = "2026-01-01T00:00:00.000Z";
    assert.equal(reserveBatchEntry(batch, ids[0], { now: AT }).ok, true);
    assert.equal(reserveBatchEntry(batch, ids[0], { now: AT }).ok, false); // no double reserve
    assert.equal(consumeBatchEntry(batch, ids[0]).ok, true);
    assert.equal(consumeBatchEntry(batch, ids[0]).ok, false);
    // Release path returns reserved → unused.
    assert.equal(reserveBatchEntry(batch, ids[1], { now: AT }).ok, true);
    assert.equal(releaseBatchEntry(batch, ids[1]).ok, true);
    assert.equal(reserveBatchEntry(batch, ids[1], { now: AT }).ok, true);
    // Unknown card is never reservable.
    assert.equal(reserveBatchEntry(batch, "T-unknown", { now: AT }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("batch context: interactive expiry is the earlier of policy expiry or five minutes", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { cards: 1 });
    const { pulseCheck } = await import("../scripts/enforcement/pulse_scheduler_pi.js");
    const check = pulseCheck({ boardPath, modelRegistry: registry, scopedModels: ["zai/glm-5.3"], observedAt: "2026-01-01T00:00:00.000Z" });
    const policy = readAutomationPolicy(boardPath);
    const batch = mintBatchContext({ scan: check.scan, cards: check.validated.cards, policy, instruction: "work", now: "2026-01-01T00:00:00.000Z" });
    const issued = Date.parse(batch.issuedAt);
    const expires = Date.parse(batch.expiresAt);
    assert.equal(expires - issued, 5 * 60 * 1000);
    assert.equal(batchExpired(batch, "2026-01-01T00:04:59.000Z"), false);
    assert.equal(batchExpired(batch, "2026-01-01T00:05:01.000Z"), true);
    // Expired context refuses reservation.
    assert.equal(reserveBatchEntry(batch, batch.entries[0].cardId, { now: "2026-01-01T00:05:01.000Z" }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy operations: enable/disable persist the closed semantic result", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { pulse: pulsePolicy({ enabled: false }) });
    const ctx = tuiContext();
    const enabled = await pulsePolicyOperation({ action: "enable", instruction: "enable pulse for this board", boardPath, context: ctx });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.persisted, true);
    assert.equal(readAutomationPolicy(boardPath).pulse.enabled, true);
    const disabled = await pulsePolicyOperation({ action: "disable", instruction: "disable pulse", boardPath, context: ctx });
    assert.equal(disabled.ok, true);
    assert.equal(readAutomationPolicy(boardPath).pulse.enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy operations: configure roleRoute and interval; invalid changes fail closed", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { pulse: pulsePolicy({ enabled: false }) });
    const ctx = tuiContext();
    const ok = await pulsePolicyOperation({
      action: "configure", instruction: "set reviewer route and faster interval", boardPath, context: ctx,
      changes: [
        { type: "roleRoute", role: "reviewer", preferred: [{ model: "openai-codex/gpt-5.6-sol", maxConcurrent: 1 }], fallback: [], maxConcurrent: 1 },
        { type: "intervalSeconds", value: 60 },
      ],
    });
    assert.equal(ok.ok, true, ok.reason);
    const stored = readAutomationPolicy(boardPath).pulse;
    assert.equal(stored.routing.reviewer.preferred[0].model, "openai-codex/gpt-5.6-sol");
    assert.equal(stored.intervalSeconds, 60);
    // Unknown routing role fails closed.
    const bad = await pulsePolicyOperation({
      action: "configure", instruction: "add ghost route", boardPath, context: ctx,
      changes: [{ type: "roleRoute", role: "ghost", preferred: [{ model: "zai/glm-5.3", maxConcurrent: 1 }], fallback: [], maxConcurrent: 1 }],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /fails closed/);
    // Nothing was written by the failed change.
    assert.equal(readAutomationPolicy(boardPath).pulse.routing.ghost, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy operations: headless host-risk acceptance fails closed and writes nothing", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { pulse: pulsePolicy({ enabled: false, mode: "interactive" }) });
    const headless = await pulsePolicyOperation({
      action: "configure", instruction: "accept host risk", boardPath,
      changes: [{ type: "unattendedHostRiskAccepted", value: true }],
    });
    assert.equal(headless.ok, false);
    assert.equal(headless.code, "host-risk-headless-denied");
    assert.equal(readAutomationPolicy(boardPath).pulse.unattendedHostRiskAccepted, false);
    // Native denial also writes nothing.
    const denied = await pulsePolicyOperation({
      action: "configure", instruction: "accept host risk", boardPath, context: tuiContext({ confirmed: false }),
      changes: [{ type: "unattendedHostRiskAccepted", value: true }],
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "host-risk-not-accepted");
    assert.equal(readAutomationPolicy(boardPath).pulse.unattendedHostRiskAccepted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy operations: revocation (disable) and policy absence stop new claims", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { pulse: pulsePolicy({ enabled: false }) });
    const r = await pulseTick({ boardPath, spawnWorker: async () => ({ ok: true }) });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.landedAssignments.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("automated tick: container placement is denied with containment-seam-unavailable, no host spawn", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { cards: 2, pulse: pulsePolicy({ mode: "automated", fillOnStart: false }) });
    const spawned = [];
    const r = await pulseTick({
      boardPath,
      spawnWorker: async (req) => { spawned.push(req); return { ok: true }; },
      context: { modelRegistry: registry, scopedModels: ["zai/glm-5.3"] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, false);
    assert.equal(r.landedAssignments.length, 2);
    assert.ok(r.landedAssignments.every((a) => a.status === "denied"));
    assert.equal(spawned.length, 0); // no containment fallback to host spawning
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("automated tick: interactive mode is a no-op (no scheduling effects)", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { cards: 1 });
    const r = await pulseTick({ boardPath, spawnWorker: async () => ({ ok: true }) });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "interactive-mode-tick-is-a-no-op");
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timer lifecycle: no tick before start, single-flight, fillOnStart queues one tick, clear is idempotent", async () => {
  const scheduled = [];
  let tickCount = 0;
  let running = false;
  const timer = createPulseTimer({
    intervalSeconds: 1,
    fillOnStart: true,
    tick: async () => {
      if (running) throw new Error("overlap");
      running = true;
      await new Promise((r) => setTimeout(r, 20));
      running = false;
      tickCount += 1;
    },
    scheduleFn: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clearFn: () => {},
  });
  assert.equal(timer.stats().ticks, 0);
  timer.start();
  assert.equal(scheduled.length, 1); // fillOnStart queued exactly one tick
  assert.equal(scheduled[0].ms, 0);
  await timer.runTickNow(); // first tick runs
  assert.equal(tickCount, 1);
  // The settled tick scheduled exactly one ordinary next tick at the fixed
  // interval; ticks never overlap and nothing is queued while running.
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].ms, 1000);
  await timer.clear();
  await timer.clear(); // idempotent
  assert.equal(timer.stats().stopped, true);
});

test("timer lifecycle: fillOnStart=false schedules the interval, never immediate", () => {
  const scheduled = [];
  const timer = createPulseTimer({
    intervalSeconds: 300,
    fillOnStart: false,
    tick: async () => {},
    scheduleFn: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clearFn: () => {},
  });
  timer.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 300000);
});

test("tool run/enable/configure surface is wired end-to-end through the registered tool", async () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir, { cards: 1, pulse: pulsePolicy({ enabled: false }), policyOverrides: { placement: "host" } });
    const registered = [];
    registerPulseTools({ registerTool: (t) => registered.push(t) }, { spawnWorker: async () => ({ ok: true }) });
    const tool = registered[0];
    const enabled = await tool.execute("t1", { action: "enable", instruction: "enable pulse" }, null, null, { ...tuiContext(), cwd: dir });
    const enabledValue = JSON.parse(enabled.content[0].text);
    assert.equal(enabledValue.ok, true);
    assert.equal(enabledValue.persisted, true);
    assert.equal(readAutomationPolicy(boardPath).pulse.enabled, true);
    const run = await tool.execute("t2", { action: "run", instruction: "work the ready cards" }, null, null, { ...tuiContext({ modelRegistry: registry, scopedModels: ["zai/glm-5.3"] }), cwd: dir });
    const runValue = JSON.parse(run.content[0].text);
    assert.equal(runValue.ok, true);
    assert.equal(runValue.landedAssignments.length, 1);
    assert.equal(runValue.landedAssignments[0].status, "started");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
