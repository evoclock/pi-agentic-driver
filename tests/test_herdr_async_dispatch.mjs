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
  assert.equal(working.ok, true, "waiting-approval is a resumable pause, not a failure");
  assert.equal(working.status, "waiting-approval");
  assert.equal(working.stepCount, 0);
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
