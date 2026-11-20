import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLoopBudget, loadLoopConfig } from "../scripts/enforcement/loop_until_done_pi.js";

// Why: a missing detector must fail as an assertion on the base branch, not an import crash.
test("the stall detector exists and exposes a closed reason vocabulary", async () => {
  const url = new URL("../scripts/enforcement/stall_detector_pi.js", import.meta.url);
  assert.equal(existsSync(fileURLToPath(url)), true, "stall detector module must exist");
  const { STALL_REASONS, STALL_STATES } = await import(url.href);
  assert.deepEqual(STALL_REASONS, ["idle-timeout", "repeated-tool-loop", "blocked-brief"]);
  assert.deepEqual(STALL_STATES, ["idle", "watching", "stalled", "recovery-attempted", "exhausted"]);
});

// Why: a recovery nudge is advice, never an additional dispatch allowance.
test("a detected stall permits one recovery prompt but cannot exceed the loop budget", async () => {
  const url = new URL("../scripts/enforcement/stall_detector_pi.js", import.meta.url);
  assert.equal(existsSync(fileURLToPath(url)), true, "stall detector module must exist");
  const { createStallDetector, DEFAULT_STALL_CONFIG } = await import(url.href);
  let time = 100;
  const detector = createStallDetector({ ...DEFAULT_STALL_CONFIG, idleTimeoutMs: 10 }, () => time);
  const entries = [];
  const budget = createLoopBudget((event) => entries.push({ type: "custom", customType: "loop-until-done-budget.v1", data: event }), () => time, loadLoopConfig());
  budget.start({ steps: 1, goal: "repair", exit: "passes" });
  detector.beginRun();
  time += 10;
  assert.equal(detector.checkIdle(), "idle-timeout");
  assert.equal(detector.requestRecovery(), "idle-timeout");
  assert.equal(detector.requestRecovery(), null, "only one chase per run");
  assert.equal(budget.guard({ toolName: "agentic_worker_dispatch", input: { action: "dispatch", role: "developer", maxSteps: 1, mode: "turn-by-turn", autonomy: "confirmed-default" } }), undefined);
  assert.match(budget.guard({ toolName: "agentic_worker_dispatch", input: { action: "dispatch", role: "developer", maxSteps: 1, mode: "turn-by-turn", autonomy: "confirmed-default" } }).reason, /step limit reached/);
  assert.equal(entries.filter((entry) => entry.data.event === "attempt").length, 1);
  assert.equal(detector.state(), "recovery-attempted");
  detector.exhaust();
  assert.equal(detector.state(), "exhausted");
  assert.equal(detector.requestRecovery(), null);
});
