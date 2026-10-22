import test from "node:test";
import assert from "node:assert/strict";
import { loadLoopConfig, parseLoopRequest, registerLoopUntilDone } from "../scripts/enforcement/loop_until_done_pi.js";

const { maxSteps: LOOP_MAX_STEPS, maxDurationMs: LOOP_MAX_DURATION_MS } = loadLoopConfig();

function host(entries = [], now = () => Date.now(), config = loadLoopConfig()) {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, spec) { commands.set(name, spec); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(message) { sent.push(message); },
  };
  const ctx = { sessionManager: { getEntries: () => [...entries] } };
  return { pi, handlers, commands, sent, entries, ctx, budget: registerLoopUntilDone(pi, now, config) };
}

const command = (h) => h.commands.get("loop-until-done").handler;
const tool = (h, toolName, input) => h.handlers.get("tool_call")({ toolName, input });
const dispatch = (h, input = {}) => tool(h, "agentic_worker_dispatch", {
  action: "dispatch", role: "developer", maxSteps: 1,
  mode: "turn-by-turn", autonomy: "confirmed-default", stepPrompt: "approved work", ...input,
});

test("Given an invalid or unbounded request, the command opens no budget", async () => {
  const h = host();
  for (const args of ["", "0 goal :: check", "-1 goal :: check", "1.5 goal :: check",
    `${LOOP_MAX_STEPS + 1} goal :: check`, "2 goal", "2 :: check", "2 goal :: ",
    "Infinity goal :: check", "2 goal :: check" + "x".repeat(1001)]) {
    await assert.rejects(command(h)(args, {}), /Use \/loop-until-done/);
    assert.equal(h.budget.snapshot(), null);
  }
  assert.deepEqual(parseLoopRequest("2 improve flow :: verify real entry"), {
    steps: 2, goal: "improve flow", exit: "verify real entry",
  });
});

test("Given a valid request, each dispatched attempt consumes one token before execution", async () => {
  const h = host();
  await command(h)("2 repair bug :: observed reproduction passes", {});
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Enforced worker-dispatch allowance: 2 attempts/);
  assert.equal(h.budget.snapshot().remaining, 2);
  assert.equal(dispatch(h), undefined);
  assert.equal(h.budget.snapshot().remaining, 1);
  assert.equal(dispatch(h, { role: "reviewer" }), undefined);
  assert.equal(h.budget.snapshot().remaining, 0);
  assert.match(dispatch(h).reason, /step limit reached/);
  assert.equal(h.budget.snapshot().remaining, 0);
  assert.equal(tool(h, "agentic_worker_dispatch", { action: "pulse" }), undefined);
});

test("Given parallel dispatch attempts, no more than the finite allowance can pass", async () => {
  const h = host();
  await command(h)("2 goal :: check", {});
  const results = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => dispatch(h))));
  assert.equal(results.filter((result) => result === undefined).length, 2);
  assert.equal(results.filter((result) => result?.block === true).length, 8);
  assert.equal(h.budget.snapshot().remaining, 0);
});

test("A time ceiling rejects dispatch at the deadline without spending a step", async () => {
  let clock = 1_000_000;
  const h = host([], () => clock);
  await command(h)("3 goal :: check", {});
  assert.equal(dispatch(h), undefined);
  clock += LOOP_MAX_DURATION_MS - 1;
  assert.equal(dispatch(h), undefined, "the final millisecond is still in budget");
  clock += 1;
  assert.match(dispatch(h).reason, /time limit reached/);
  clock -= LOOP_MAX_DURATION_MS;
  h.handlers.get("session_tree")(null, h.ctx);
  assert.match(dispatch(h).reason, /time limit reached/, "a same-session clock rollback cannot reopen an expired budget");
  assert.equal(h.entries.filter((entry) => entry.data.event === "attempt").length, 2);
  assert.equal(tool(h, "agentic_herdr_spawn_worker", {}).block, true);
  await assert.rejects(command(h)("1 restart :: check", {}), /cannot be restarted/);
});

test("Time expiry survives extension reload and tree navigation", async () => {
  let clock = 1_000_000;
  const entries = [];
  const first = host(entries, () => clock);
  await command(first)("2 goal :: check", {});
  clock += LOOP_MAX_DURATION_MS;
  const resumed = host(entries, () => clock);
  resumed.handlers.get("session_start")(null, resumed.ctx);
  assert.match(dispatch(resumed).reason, /time limit reached/);
  resumed.handlers.get("session_tree")(null, resumed.ctx);
  assert.match(dispatch(resumed).reason, /time limit reached/);
  assert.equal(entries.filter((entry) => entry.data.event === "attempt").length, 0);
});

test("A recorded expiry prevents clock rollback from reopening dispatch after extension reload", async () => {
  let clock = 1_000_000;
  const entries = [];
  const first = host(entries, () => clock);
  await command(first)("2 goal :: check", {});
  clock += LOOP_MAX_DURATION_MS;
  assert.match(dispatch(first).reason, /time limit reached/);
  assert.equal(entries.filter((entry) => entry.data.event === "expire").length, 1);
  clock -= LOOP_MAX_DURATION_MS - 1;
  const reloaded = host(entries, () => clock);
  reloaded.handlers.get("session_start")(null, reloaded.ctx);
  assert.match(dispatch(reloaded).reason, /time limit reached/);
  assert.equal(entries.filter((entry) => entry.data.event === "expire").length, 1);
  assert.equal(entries.filter((entry) => entry.data.event === "attempt").length, 0);
});

test("Expiry persistence failure cannot admit dispatch and retries the record", async () => {
  let clock = 1_000_000;
  const h = host([], () => clock);
  await command(h)("2 goal :: check", {});
  clock += LOOP_MAX_DURATION_MS;
  const append = h.pi.appendEntry;
  h.pi.appendEntry = () => { throw new Error("expiry storage failed"); };
  assert.throws(() => dispatch(h), /expiry storage failed/);
  h.pi.appendEntry = append;
  clock -= LOOP_MAX_DURATION_MS - 1;
  assert.match(dispatch(h).reason, /time limit reached/);
  assert.equal(h.entries.filter((entry) => entry.data.event === "expire").length, 1);
});

test("An untrusted clock or legacy start without a timestamp cannot extend a loop", async () => {
  let clock = 1_000_000;
  const h = host([], () => clock);
  await command(h)("2 goal :: check", {});
  clock -= 1;
  assert.match(dispatch(h).reason, /time limit reached/);
  const legacy = host([{ type: "custom", customType: "loop-until-done-budget.v1", data: { event: "start", steps: 2 } }], () => clock);
  legacy.handlers.get("session_start")(null, legacy.ctx);
  assert.match(dispatch(legacy).reason, /step limit reached/);
});

test("Given an active budget, malformed or alternate worker routes are blocked without spending steps", async () => {
  const h = host();
  await command(h)("1 goal :: check", {});
  for (const input of [
    { maxSteps: 2 }, { maxSteps: "1" }, { mode: "continuous" }, { autonomy: "autonomous" },
    { role: "other" }, { model: "override" }, { cast: {} }, { action: "unknown" },
  ]) assert.equal(dispatch(h, input).block, true);
  for (const [name, input] of [
    ["agentic_worker_dispatch_async", { action: "submit" }],
    ["agentic_herdr_communication", { action: "prompt" }],
    ["agentic_herdr_spawn_worker", {}],
    ["agentic_kanban_board_dispatch", {}],
    ["agentic_kanban_pulse", { action: "run" }],
  ]) assert.equal(tool(h, name, input).block, true, name);
  assert.equal(tool(h, "agentic_worker_dispatch_async", { action: "poll" }), undefined);
  assert.equal(tool(h, "agentic_herdr_communication", { action: "delivery" }), undefined);
  assert.equal(tool(h, "read", { path: "README.md" }), undefined);
  assert.equal(h.budget.snapshot().remaining, 1);
});

test("Given a settled turn or tree navigation, spent steps remain spent for the session", async () => {
  const h = host();
  await command(h)("2 goal :: check", {});
  assert.equal(dispatch(h), undefined);
  assert.equal(h.handlers.has("agent_settled"), true);
  h.handlers.get("session_tree")(null, h.ctx);
  assert.equal(h.budget.snapshot().remaining, 1);
  assert.equal(dispatch(h), undefined);
  h.handlers.get("session_tree")(null, h.ctx);
  assert.match(dispatch(h).reason, /step limit reached/);
  await assert.rejects(command(h)("10 new goal :: check", {}), /cannot be restarted/);
  await command(h)("stop", {});
  assert.equal(h.budget.snapshot(), null);
  await assert.rejects(command(h)("1 new goal :: check", {}), /cannot be restarted/);
  h.handlers.get("session_tree")(null, h.ctx);
  await assert.rejects(command(h)("1 new goal :: check", {}), /cannot be restarted/);
});

test("A resumed Pi extension reconstructs a session-wide budget from durable entries", async () => {
  const entries = [];
  const first = host(entries);
  await command(first)("3 goal :: check", {});
  assert.equal(dispatch(first), undefined);
  const reloaded = host(entries);
  reloaded.handlers.get("session_start")(null, reloaded.ctx);
  assert.equal(reloaded.budget.snapshot().remaining, 2);
  assert.equal(dispatch(reloaded), undefined);
  assert.equal(dispatch(reloaded), undefined);
  assert.match(dispatch(reloaded).reason, /step limit reached/);
  assert.equal(entries.filter((entry) => entry.data.event === "attempt").length, 3);
  entries.length = 0; // A different Pi session, not a same-session restart.
  reloaded.handlers.get("session_start")(null, reloaded.ctx);
  await command(reloaded)("1 new session goal :: check", {});
  assert.equal(reloaded.budget.snapshot().remaining, 1);
});

test("An entry-write failure denies an attempt without spending an unrecorded step", async () => {
  const h = host();
  await command(h)("1 goal :: check", {});
  h.pi.appendEntry = () => { throw new Error("session persistence failed"); };
  assert.throws(() => dispatch(h), /session persistence failed/);
  assert.equal(h.budget.snapshot().remaining, 1);
});

test("A send failure closes but cannot restart the session allowance", async () => {
  const h = host();
  h.pi.sendUserMessage = () => { throw new Error("transport failed"); };
  await assert.rejects(command(h)("1 goal :: check", {}), /transport failed/);
  assert.equal(h.budget.snapshot(), null);
  await assert.rejects(command(h)("1 retry :: check", {}), /cannot be restarted/);
  assert.equal(registerLoopUntilDone(h.pi), undefined);
});


test("Invalid configuration fails closed before command registration", () => {
  for (const config of [null, {}, { maxSteps: 0, maxDurationMs: 10, wake: { mode: "until-done" } },
    { maxSteps: 2, maxDurationMs: -1, wake: { mode: "until-done" } },
    { maxSteps: 2, maxDurationMs: 10, wake: { mode: "interval", periodMs: 0 } },
    { maxSteps: 2, maxDurationMs: 10, wake: { mode: "other" } },
    { maxSteps: 2, maxDurationMs: 10, wake: { mode: "until-done", periodMs: 1 } }]) {
    assert.throws(() => loadLoopConfig(() => JSON.stringify(config)), /Invalid loop configuration/);
  }
  assert.throws(() => loadLoopConfig(() => "not json"), /Invalid loop configuration/);
  assert.throws(() => host([], () => 1, {}), /Invalid loop configuration/);
});

test("Configured limits replace the defaults on the real command and guard", async () => {
  let clock = 100;
  const config = { maxSteps: 1, maxDurationMs: 5, wake: { mode: "until-done" } };
  const h = host([], () => clock, config);
  await assert.rejects(command(h)("2 goal :: check", {}), /1-1 steps/);
  await command(h)("1 goal :: check", {});
  clock += 5;
  assert.match(dispatch(h).reason, /time limit reached/);
});

test("A failed exchange never schedules another wake", async () => {
  const h = host([], () => Date.now(), { maxSteps: 2, maxDurationMs: 1000, wake: { mode: "until-done" } });
  await command(h)("2 goal :: check", {});
  dispatch(h);
  h.handlers.get("tool_result")({ toolName: "agentic_worker_dispatch", isError: true });
  h.handlers.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.sent.length, 1);
});

test("Changing configured limits or wake mode on reload cannot enlarge an active run", async () => {
  const entries = [];
  const original = { maxSteps: 2, maxDurationMs: 20, wake: { mode: "until-done" } };
  const first = host(entries, () => 100, original);
  await command(first)("2 goal :: check", {});
  for (const changed of [
    { ...original, maxSteps: 3 },
    { ...original, maxDurationMs: 100 },
    { ...original, wake: { mode: "interval", periodMs: 5 } },
  ]) {
    const resumed = host(entries, () => 100, changed);
    resumed.handlers.get("session_start")(null, resumed.ctx);
    assert.match(dispatch(resumed).reason, /step limit reached/);
  }
});

for (const wake of [{ mode: "until-done" }, { mode: "interval", periodMs: 15 }]) {
  test(`Wake mode ${wake.mode} resumes after an admitted attempt and stops after stop`, async () => {
    const h = host([], () => Date.now(), { maxSteps: 2, maxDurationMs: 1000, wake });
    await command(h)("2 goal :: check", {});
    h.handlers.get("agent_settled")();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.sent.length, 1, "no dispatch means no wake");
    assert.equal(dispatch(h), undefined);
    h.handlers.get("tool_result")({ toolName: "agentic_worker_dispatch", isError: false });
    h.handlers.get("agent_settled")();
    if (wake.mode === "interval") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(h.sent.length, 1, "interval has not elapsed");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1], /Verify the exit check first/);
    await command(h)("stop", {});
    h.handlers.get("agent_settled")();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.sent.length, 2);
  });
}
