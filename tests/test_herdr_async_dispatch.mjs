// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerWorkerDispatchInterface,
  runWorkerJourney,
  workerPulse,
  nextDispatchableTask,
  WORKER_DISPATCH_SCHEMA,
  DEFAULT_MODE,
  WORKER_DISPATCH_MODES,
} from "../scripts/enforcement/herdr_async_dispatch_pi.js";

const root = process.cwd();
const tuiContext = () => ({ mode: "tui", hasUI: true, cwd: root, ui: { confirm: async () => true } });

function herdrFixture({ statuses = {}, reportFor = () => "step report" } = {}) {
  const calls = [];
  const runProcess = async ({ argv }) => {
    const [action, role] = [argv[1], argv[2]];
    calls.push({ action, role, argv: [...argv] });
    if (action === "get") {
      return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: role, agent: "pi", status: statuses[role] ?? "idle", repository: root } }) };
    }
    if (action === "prompt") {
      return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: role, agent: "pi", status: "done", repository: root } }) };
    }
    if (action === "read") {
      return { code: 0, stdout: `[WORKER_REPORT_BEGIN]\n${reportFor(role)}\n[WORKER_REPORT_END]` };
    }
    throw new Error(`unexpected action: ${action}`);
  };
  return { calls, runProcess };
}

function taskStore(tasks) {
  const state = tasks.map((task) => ({ ...task }));
  return {
    list: () => state.map((task) => ({ ...task })),
    // The worker (not the journey) marks tasks done through its own task
    // tools; the store exposes this as an observed advance for fixtures.
    observeAdvance: (id) => { const task = state.find((t) => t.id === id); if (task) task.status = "completed"; },
  };
}

function harness() {
  const tools = [];
  const pi = { registerTool: (tool) => tools.push(tool.name) };
  registerWorkerDispatchInterface(pi);
  return tools;
}

test("continuous is the default dispatch mode and turn-by-turn is explicit", () => {
  assert.equal(DEFAULT_MODE, "continuous");
  assert.deepEqual([...WORKER_DISPATCH_MODES], ["continuous", "turn-by-turn"]);
  assert.deepEqual(harness(), ["agentic_worker_dispatch"]);
});

test("pulse observes liveness, state, and eligibility without authority", async () => {
  const fixture = herdrFixture({ statuses: { worker: "idle" } });
  const pulse = await workerPulse("worker", { cwd: root }, { runProcess: fixture.runProcess });
  assert.equal(pulse.alive, true);
  assert.equal(pulse.status, "idle");
  assert.equal(pulse.dispatchEligible, true);
  assert.equal(pulse.observed, true);

  const busy = herdrFixture({ statuses: { worker: "working" } });
  const busyPulse = await workerPulse("worker", { cwd: root }, { runProcess: busy.runProcess });
  assert.equal(busyPulse.dispatchEligible, false);

  await assert.rejects(
    () => workerPulse("coordinator", { cwd: root }, { runProcess: herdrFixture().runProcess }),
    (error) => error.code === "target_role_denied",
  );

  await assert.rejects(
    () => workerPulse("worker", { cwd: root }, { runProcess: async () => ({ code: 2, stdout: "", stderr: "agent_name_not_found" }) }),
    (error) => error.code === "stale_role_mapping",
  );
});

test("queue progression observes the next dispatchable item without creating cards", () => {
  const store = taskStore([
    { id: "1", status: "completed" },
    { id: "2", status: "pending", blockedBy: ["3"] },
    { id: "3", status: "in_progress", owner: "someone" },
    { id: "4", status: "pending" },
    { id: "5", status: "pending" },
  ]);
  assert.equal(nextDispatchableTask(store).id, "4");
  assert.equal(nextDispatchableTask(taskStore([{ id: "1", status: "completed" }])), null);

  const observed = store.list();
  assert.equal(observed[3].status, "pending", "observation must not mutate task state");
  assert.throws(() => nextDispatchableTask(undefined), (error) => error.code === "task-store-invalid");
  assert.throws(() => nextDispatchableTask({ list: () => "nope" }), (error) => error.code === "task-store-invalid");
});

test("continuous journey collates one marked report and stops when the queue is exhausted", async () => {
  const fixture = herdrFixture();
  const tasks = [
    { id: "10", status: "pending", subject: "first" },
    { id: "11", status: "pending", subject: "second" },
  ];
  const journey = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "progress the sequence" },
    tuiContext(),
    { runProcess: fixture.runProcess, taskStore: taskStore(tasks) },
  );
  assert.equal(journey.ok, true);
  assert.equal(journey.mode, "continuous");
  assert.equal(journey.status, "exhausted");
  assert.equal(journey.stepCount, 2);
  assert.match(journey.report, /^\[WORKER_JOURNEY_REPORT_BEGIN\]/);
  assert.match(journey.report, /\[WORKER_JOURNEY_REPORT_END\]$/);
  assert.equal((journey.report.match(/step \d+:.*status=done/g) ?? []).length, 2);
  const prompts = fixture.calls.filter((call) => call.action === "prompt");
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((call) => call.argv[0] === "agent" && call.argv.includes("--wait")));
  assert.equal(journey.nonAuthorizing, true);
  assert.equal(journey.persisted, false);
});

test("prohibited effects: no card creation, no coordinator role, headless denied, no retries", async () => {
  // Card creation is not in the surface: the journey only reads the store.
  const store = taskStore([{ id: "1", status: "pending" }]);
  let mutated = false;
  const guardedStore = { list: () => store.list(), create: () => { mutated = true; return {}; } };
  const fixture = herdrFixture();
  const journey = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    { runProcess: fixture.runProcess, taskStore: guardedStore },
  );
  assert.equal(mutated, false, "the journey must never create task cards");
  assert.equal(journey.status, "exhausted");

  const deniedRole = await runWorkerJourney(
    { action: "dispatch", role: "coordinator", stepPrompt: "x" },
    tuiContext(),
    { runProcess: herdrFixture().runProcess, taskStore: store },
  );
  assert.equal(deniedRole.ok, false);
  assert.equal(deniedRole.code, "target_role_denied");

  const headless = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    { mode: "print", cwd: root },
    { runProcess: herdrFixture().runProcess, taskStore: store },
  );
  assert.equal(headless.ok, false);
  assert.equal(headless.status, "failed");
  assert.equal(headless.steps[0].error, "native TUI confirmation unavailable");

  // A failed exchange is terminal: exactly one prompt, no resend.
  let prompts = 0;
  const failing = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    {
      taskStore: store,
      runProcess: async ({ argv }) => {
        if (argv[1] === "prompt") { prompts += 1; return { code: 2, stdout: "", stderr: "agent hung up" }; }
        return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "idle", repository: root } }) };
      },
    },
  );
  assert.equal(prompts, 1, "a failed exchange must never be retried or resent");
  assert.equal(failing.ok, false);
  assert.equal(failing.status, "failed");

  // Declined confirmation cancels explicitly.
  const declined = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    { mode: "tui", hasUI: true, cwd: root, ui: { confirm: async () => false } },
    { runProcess: herdrFixture().runProcess, taskStore: store },
  );
  assert.equal(declined.ok, false);
  assert.equal(declined.status, "cancelled");

  // AbortSignal cancellation is explicit, before any prompt.
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    { runProcess: herdrFixture().runProcess, taskStore: store },
    controller.signal,
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.stepCount, 0);
});

test("turn-by-turn is explicit opt-in and stops after the first step", async () => {
  const fixture = herdrFixture();
  const journey = await runWorkerJourney(
    { action: "dispatch", role: "worker", mode: "turn-by-turn", stepPrompt: "one turn only" },
    tuiContext(),
    { runProcess: fixture.runProcess, taskStore: taskStore([{ id: "1", status: "pending" }, { id: "2", status: "pending" }]) },
  );
  assert.equal(journey.ok, true);
  assert.equal(journey.mode, "turn-by-turn");
  assert.equal(journey.status, "waiting-approval");
  assert.equal(journey.stepCount, 1);
  assert.equal(fixture.calls.filter((call) => call.action === "prompt").length, 1);
});

test("role-blocked and non-eligible workers end the journey explicitly", async () => {
  const blocked = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    {
      taskStore: taskStore([{ id: "1", status: "pending" }]),
      runProcess: async ({ argv }) => argv[1] === "get"
        ? { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "blocked", repository: root } }) }
        : { code: 0, stdout: "{}" },
    },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, "role-blocked");
  assert.equal(blocked.stepCount, 0);

  const working = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    {
      taskStore: taskStore([{ id: "1", status: "pending" }]),
      runProcess: async ({ argv }) => argv[1] === "get"
        ? { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "working", repository: root } }) }
        : { code: 0, stdout: "{}" },
    },
  );
  assert.equal(working.ok, false, "an unresponsive agent session ends the journey explicitly");
  assert.equal(working.status, "worker-unresponsive");
  assert.equal(working.stepCount, 0);
  assert.equal(working.handoff.attempted, false, "no spawn seam configured, no handoff attempted");
});

test("journeys are bounded by maxSteps, not a wall-clock timeout", async () => {
  const fixture = herdrFixture();
  const journey = await runWorkerJourney(
    { action: "dispatch", role: "worker", maxSteps: 2, stepPrompt: "x" },
    tuiContext(),
    { runProcess: fixture.runProcess, taskStore: taskStore([
      { id: "1", status: "pending" }, { id: "2", status: "pending" }, { id: "3", status: "pending" },
    ]) },
  );
  assert.equal(journey.ok, true);
  assert.equal(journey.status, "completed");
  assert.equal(journey.stepCount, 2, "the journey stops at maxSteps, independent of elapsed time");
  assert.equal(journey.schema, WORKER_DISPATCH_SCHEMA);
});

test("maxSteps defaults to 50, accepts up to 200, and rejects out-of-bound values", async () => {
  const overBound = await runWorkerJourney(
    { action: "dispatch", role: "worker", maxSteps: 201, stepPrompt: "x" },
    tuiContext(),
    { runProcess: herdrFixture().runProcess, taskStore: taskStore([{ id: "1", status: "pending" }]) },
  );
  assert.equal(overBound.ok, false);
  assert.equal(overBound.code, "max-steps-invalid");

  const zero = await runWorkerJourney(
    { action: "dispatch", role: "worker", maxSteps: 0, stepPrompt: "x" },
    tuiContext(),
    { runProcess: herdrFixture().runProcess, taskStore: taskStore([{ id: "1", status: "pending" }]) },
  );
  assert.equal(zero.code, "max-steps-invalid");

  // Default (no maxSteps) is 50: a store with 51 pending tasks completes 50.
  const state = Array.from({ length: 51 }, (_, index) => ({ id: String(index + 1), status: "pending" }));
  const fixture = herdrFixture();
  const long = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    { runProcess: fixture.runProcess, taskStore: taskStore(state) },
  );
  assert.equal(long.ok, true);
  assert.equal(long.status, "completed");
  assert.equal(long.stepCount, 50);
  assert.equal(fixture.calls.filter((call) => call.action === "prompt").length, 50);
});

test("a worker not idle across observed exchange cycles is unresponsive and ends explicitly", async () => {
  const journey = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    {
      taskStore: taskStore([{ id: "1", status: "pending" }]),
      runProcess: async ({ argv }) => argv[1] === "get"
        ? { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "working", repository: root } }) }
        : { code: 0, stdout: "{}" },
    },
  );
  assert.equal(journey.ok, false);
  assert.equal(journey.status, "worker-unresponsive");
  assert.equal(journey.code, "worker-unresponsive");
  assert.match(journey.report, /status: worker-unresponsive/);
  assert.equal(journey.handoff.attempted, false, "no handoff is attempted without a spawn seam");
  assert.match(journey.handoff.reason, /not available in this context/);
});

test("unresponsive-session replacement handoff records the handoff and reuses task cards", async () => {
  const spawned = [];
  const fixture = herdrFixture();
  const journey = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    {
      runProcess: async ({ argv }) => argv[1] === "get"
        ? { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "working", repository: root } }) }
        : { code: 0, stdout: "{}" },
      taskStore: taskStore([{ id: "1", status: "pending" }]),
      spawnReplacement: async ({ role }) => {
        spawned.push(role);
        return { ok: true, role, repository: root };
      },
    },
  );
  assert.equal(journey.status, "worker-unresponsive");
  assert.equal(journey.handoff.attempted, true);
  assert.equal(journey.handoff.ok, true);
  assert.equal(journey.handoff.role, "worker");
  assert.equal(journey.handoff.nonAuthorizing, true);
  assert.deepEqual(spawned, ["worker"]);
  assert.match(journey.report, /handoff: attempted=true ok=true role=worker/);

  // Declined replacement confirmation records the explicit refusal.
  const declined = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    { mode: "tui", hasUI: true, cwd: root, ui: { confirm: async () => false } },
    {
      runProcess: async ({ argv }) => argv[1] === "get"
        ? { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "working", repository: root } }) }
        : { code: 0, stdout: "{}" },
      taskStore: taskStore([{ id: "1", status: "pending" }]),
      spawnReplacement: async () => { throw new Error("must not be called"); },
    },
  );
  assert.equal(declined.status, "worker-unresponsive");
  assert.equal(declined.handoff.attempted, false);
  assert.match(declined.handoff.reason, /not granted/);

  // A stuck exchange (stalled prompt) triggers the same explicit handoff.
  const stalled = await runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    tuiContext(),
    {
      taskStore: taskStore([{ id: "1", status: "pending" }]),
      runProcess: async ({ argv }) => {
        if (argv[1] === "get") return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "idle", repository: root } }) };
        if (argv[1] === "prompt") return { code: 2, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "stalled" } }) };
        return { code: 0, stdout: "{}" };
      },
      spawnReplacement: async ({ role }) => ({ ok: true, role, repository: root }),
    },
  );
  assert.equal(stalled.status, "worker-unresponsive");
  assert.equal(stalled.handoff.attempted, true);
  assert.equal(stalled.stepCount, 0, "the stuck exchange is never retried on the same worker");
});

test("prohibited effects unchanged: handoff spawns through the lifecycle boundary only", () => {
  // The dispatch module exposes no pane/agent management commands: its only
  // registration is the single dispatch/pulse tool.
  const tools = [];
  const pi = { registerTool: (tool) => tools.push(tool.name) };
  registerWorkerDispatchInterface(pi);
  assert.deepEqual(tools, ["agentic_worker_dispatch"]);
});

test("production wiring: unresponsive handoff spawns a real replacement through the lifecycle boundary", async (t) => {
  const { executeHerdrSpawnWorker } = await import("../scripts/enforcement/herdr_lifecycle_pi.js");
  const lifecycleCalls = [];
  // Hermetic trusted-repository setup: the lifecycle resolves the worker
  // registry from the coordinator cwd (repo-local first, then the Pi profile
  // config), and the worker repository must be a Git root sibling. Build a
  // throwaway coordinator + git-rooted worker repo and chdir into the
  // coordinator for the duration of the test.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const tempBase = mkdtempSync(join(tmpdir(), "herdr-handoff-"));
  const coordinator = join(tempBase, "coordinator");
  const workerRepo = join(tempBase, "worker-repo");
  mkdirSync(join(coordinator, "config"), { recursive: true });
  mkdirSync(workerRepo, { recursive: true });
  writeFileSync(join(coordinator, "config", "herdr-worker-repositories.v1.json"),
    JSON.stringify({ schema: "agentic-driver.herdr-worker-repositories.v1", repositories: ["worker-repo"] }));
  execFileSync("git", ["-C", workerRepo, "init"]); // git root check
  const originalCwd = process.cwd();
  process.chdir(coordinator);
  t.after(() => { process.chdir(originalCwd); rmSync(tempBase, { recursive: true, force: true }); });

  const root = workerRepo;
  const model = "ds4/deepseek-v4-flash";
  // Local journey context resolves the coordinator for the lifecycle; the
  // dispatch observation stubs below still use the module-level repo root.
  const localContext = () => ({ mode: "tui", hasUI: true, cwd: coordinator, ui: { confirm: async () => true } });
  const lifecycleRunProcess = async ({ argv, shell, spawnOptions }) => {
    lifecycleCalls.push([...argv]);
    assert.equal(shell, false);
    assert.equal(spawnOptions.shell, false);
    const [verb, sub] = argv;
    const env = (result) => JSON.stringify({ id: 1, result });
    if (verb === "agent" && sub === "list") return { code: 0, stdout: JSON.stringify({ type: "agents", agents: [] }) };
    if (verb === "tab") return { code: 0, stdout: env({ root_pane: { pane_id: "p1" }, tab: { tab_id: "t1" } }) };
    if (verb === "agent" && sub === "start") return { code: 0, stdout: env({ type: "agent_started", argv, agent: { name: argv[2], agent: "pi", pane_id: "p1", cwd: root } }) };
    if (verb === "agent" && sub === "get") return { code: 0, stdout: env({ type: "agent_info", agent: { name: argv[2], agent: "pi", pane_id: "p1", cwd: root } }) };
    if (verb === "pane") return { code: 0, stdout: JSON.stringify({ type: "pane_info", pane: { pane_id: "p1", cwd: root } }) };
    throw new Error(`unexpected lifecycle call: ${argv.join(" ")}`);
  };

  // The public dispatch seam with the production spawnReplacement wiring from
  // extensions/herdr-dispatch.ts; only process/model-roll seams are stubbed.
  // Directly exercise the same wiring the extension installs.
  const dispatchModule = await import("../scripts/enforcement/herdr_async_dispatch_pi.js");
  const lifecycleModule = await import("../scripts/enforcement/herdr_lifecycle_pi.js");
  const spawnSeam = ({ role, repository, model: modelArg, context, signal }) =>
    lifecycleModule.executeHerdrSpawnWorker(
      { placement: "tab", role, model: modelArg, repository },
      context, { runProcess: lifecycleRunProcess, listModels: `provider model\nds4 deepseek-v4-flash` }, signal,
    );
  void spawnSeam;

  const journey = await dispatchModule.runWorkerJourney(
    { action: "dispatch", role: "worker", stepPrompt: "x" },
    localContext(),
    {
      runProcess: async ({ argv }) => argv[1] === "get"
        ? { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "working", repository: root } }) }
        : { code: 0, stdout: "{}" },
      taskStore: taskStore([{ id: "1", status: "pending" }]),
      model: model,
      repository: "worker-repo",
      spawnReplacement: spawnSeam,
    },
  );
  assert.equal(journey.status, "worker-unresponsive");
  assert.equal(journey.handoff.attempted, true);
  assert.equal(journey.handoff.ok, true, "the replacement spawn must succeed through the lifecycle boundary");
  assert.equal(journey.handoff.role, "worker");
  assert.deepEqual(journey.handoff.modelArgv, ["--model", model]);
  assert.equal(journey.handoff.nonAuthorizing, true);
  assert.match(journey.report, /handoff: attempted=true ok=true role=worker/);

  // Fixed lifecycle argv sequence: list (duplicate check), tab create,
  // agent start (with the validated model tail), agent get, pane get.
  assert.deepEqual(lifecycleCalls.map((argv) => `${argv[0]} ${argv[1]}`), [
    "agent list", "tab create", "agent start", "agent get", "pane get",
  ]);
  const startArgv = lifecycleCalls.find((argv) => argv[1] === "start");
  assert.equal(startArgv[0], "agent");
  assert.deepEqual(startArgv.slice(-2), ["--model", model]);
});
