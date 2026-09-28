// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore, sessionTasks } from "../extensions/task-store-adapter.ts";
import dispatchExtension from "../extensions/herdr-dispatch.ts";
import { registerWorkerDispatchInterface, runWorkerJourney, nextDispatchableTask } from "../scripts/enforcement/herdr_async_dispatch_pi.js";
import { TASK_STATE_ENTRY } from "../scripts/enforcement/session_tasks_core_pi.js";

const state = { highWaterMark: 3, tasks: [
  { id: "1", subject: "first", description: "", status: "pending", blocks: [], blockedBy: [] },
  { id: "2", subject: "blocked", description: "", status: "pending", blocks: [], blockedBy: ["1"] },
  { id: "3", subject: "finished", description: "", status: "completed", blocks: [], blockedBy: [] },
] };
const session = { sessionManager: { getSessionId: () => "offline-adapter-fixture", getBranch: () => [{ type: "custom", customType: TASK_STATE_ENTRY, data: state }] } };

test("session contract, pending selection and read-only advance", () => {
  const store = createTaskStore(session);
  assert.deepEqual(store.list()[0], { id: "1", status: "pending", blockedBy: [], owner: null });
  assert.equal(nextDispatchableTask(store).id, "1");
  store.observeAdvance("1");
  assert.equal(nextDispatchableTask(store), null, "blocked and completed tasks cannot dispatch");
  assert.equal(state.tasks[0].status, "pending");
  assert.deepEqual(state.tasks[1].blockedBy, ["1"]);
  assert.equal(createTaskStore(session).list()[0].id, "1", "advance is scoped to one journey");
});

test("a canonical board is never read or changed by the session adapter", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-adapter-"));
  try {
    const board = join(dir, "TASKS.md");
    writeFileSync(board, "not a valid board");
    const ctx = { ...session, cwd: dir };
    assert.deepEqual(sessionTasks(ctx), state.tasks);
    assert.equal(nextDispatchableTask(createTaskStore(ctx)).id, "1");
    // A throwing board-path property proves neither board resolution nor a
    // filesystem read is attempted by the adapter.
    const guarded = { ...session, get cwd() { throw Error("board access"); } };
    assert.equal(createTaskStore(guarded).list()[0].id, "1");
    assert.equal(readFileSync(board, "utf8"), "not a valid board");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("storeless registration is denied; production wiring observes session tasks and de-duplicates", async () => {
  let bare;
  registerWorkerDispatchInterface({ registerTool(tool) { bare = tool; } });
  const denied = await bare.execute("", { action: "dispatch", role: "worker", stepPrompt: "step" }, null, null, session);
  assert.equal(denied.details.code, "task-store-invalid");
  assert.equal(denied.details.status, "denied");

  const tools = [];
  const pi = { registerTool(tool) { tools.push(tool); } };
  await dispatchExtension(pi);
  await dispatchExtension(pi);
  assert.equal(tools.filter((tool) => tool.name === "agentic_worker_dispatch").length, 1);
  const observed = await tools.find((tool) => tool.name === "agentic_worker_dispatch")
    .execute("", { action: "dispatch", role: "worker", stepPrompt: "step", maxSteps: 1 }, null, null, session);
  assert.notEqual(observed.details.code, "task-store-invalid");
});

test("offline journey uses real session adapter without updating tasks", async () => {
  const calls = [];
  const runProcess = async ({ argv }) => {
    calls.push(argv[1]);
    if (argv[1] === "get") return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "idle", repository: process.cwd() } }) };
    if (argv[1] === "prompt") return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: "worker", agent: "pi", status: "done", repository: process.cwd() } }) };
    return { code: 0, stdout: "[WORKER_REPORT_BEGIN]\ncompleted\n[WORKER_REPORT_END]" };
  };
  const context = { ...session, cwd: process.cwd(), mode: "tui", hasUI: true, ui: { confirm: async () => true } };
  const options = { taskStoreFactory: createTaskStore, runProcess };
  const params = { action: "dispatch", role: "worker", stepPrompt: "step", maxSteps: 2 };
  const first = await runWorkerJourney(params, context, options);
  const second = await runWorkerJourney(params, context, options);
  assert.equal(first.steps[0].taskId, "1");
  assert.equal(second.steps[0].taskId, "1", "the next journey sees the real pending state");
  assert.ok(calls.includes("prompt"));
  assert.equal(state.tasks[0].status, "pending");
});
