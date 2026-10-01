// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore, sessionTasks, captureSessionTaskProvenance, revalidateSessionTaskProvenance } from "../extensions/task-store-adapter.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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

test("journey evidence binds host identity and immutable task content, not mutable state", () => {
  const original = process.env.PI_TASK_LIST_ID;
  const claude = process.env.CLAUDE_CODE_TASK_LIST_ID;
  delete process.env.PI_TASK_LIST_ID;
  delete process.env.CLAUDE_CODE_TASK_LIST_ID;
  let tasks = structuredClone(state.tasks);
  const ctx = { sessionManager: { getSessionId: () => "provenance-host", getBranch: () => [
    { type: "custom", customType: TASK_STATE_ENTRY, data: { highWaterMark: 3, tasks } },
  ] } };
  try {
    const capture = captureSessionTaskProvenance(ctx);
    assert.equal(capture.status, "captured");
    assert.equal(capture.source.kind, "branch");
    const item = capture.tasks[0];
    assert.deepEqual(item.material, { id: "1", title: "first", description: "", capturedAt: item.material.capturedAt });
    assert.equal(item.digest, createHash("sha256").update(JSON.stringify({
      capturedAt: item.material.capturedAt, description: "", id: "1", title: "first",
    })).digest("hex"));
    tasks[0].status = "in_progress";
    tasks[0].owner = "worker";
    tasks[0].blockedBy = ["2"];
    assert.equal(revalidateSessionTaskProvenance(ctx, capture, "1").status, "matched");
    tasks[0].description = "changed";
    assert.equal(revalidateSessionTaskProvenance(ctx, capture, "1").status, "content-drift");
    tasks = tasks.slice(1);
    assert.equal(revalidateSessionTaskProvenance(ctx, capture, "1").status, "task-missing");
    process.env.PI_TASK_LIST_ID = "spoofed";
    assert.equal(captureSessionTaskProvenance(ctx).status, "task-list-mismatch");
    assert.equal(revalidateSessionTaskProvenance(ctx, capture, "1").status, "task-list-mismatch");
    assert.deepEqual(sessionTasks(ctx), tasks, "dispatch observation is unchanged by provenance refusal");
  } finally {
    if (original === undefined) delete process.env.PI_TASK_LIST_ID;
    else process.env.PI_TASK_LIST_ID = original;
    if (claude === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID;
    else process.env.CLAUDE_CODE_TASK_LIST_ID = claude;
  }
});

test("higher disk watermark wins; equal watermark preserves branch precedence", () => {
  const root = join(process.cwd(), ".agentic-driver", "provenance-fixture");
  const mirror = join(root, ".pi", "tasks", "disk-fixture");
  mkdirSync(mirror, { recursive: true });
  try {
    writeFileSync(join(mirror, "tasks.json"), JSON.stringify({ highWaterMark: 4, tasks: [
      { id: "4", subject: "disk", description: "disk content", status: "pending", blocks: [], blockedBy: [] },
    ] }));
    const script = `import { captureSessionTaskProvenance, sessionTasks } from './extensions/task-store-adapter.ts';
      const ctx = { sessionManager: { getSessionId: () => 'disk-fixture', getBranch: () => [{
        type: 'custom', customType: 'picc-tasks-state', data: { highWaterMark: 3, tasks: [
          { id: '1', subject: 'branch', description: '', status: 'pending', blocks: [], blockedBy: [] }
        ] } }] } };
      console.log(JSON.stringify({ capture: captureSessionTaskProvenance(ctx), selected: sessionTasks(ctx) }));`;
    const run = () => {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(), env: { ...process.env, HOME: root, PI_TASK_LIST_ID: "disk-fixture", CLAUDE_CODE_TASK_LIST_ID: "" }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(run().capture.source.kind, "disk");
    assert.equal(run().selected[0].subject, "disk");
    writeFileSync(join(mirror, "tasks.json"), JSON.stringify({ highWaterMark: 3, tasks: [
      { id: "4", subject: "disk", description: "disk content", status: "pending", blocks: [], blockedBy: [] },
    ] }));
    assert.equal(run().capture.source.kind, "branch");
    assert.equal(run().selected[0].subject, "branch");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  assert.equal(first.taskProvenance.status, "captured");
  assert.equal(first.taskProvenance.source.hostSessionId, "offline-adapter-fixture");
  assert.equal(first.taskProvenance.tasks[0].id, "1");
  assert.match(first.taskProvenance.tasks[0].digest, /^[0-9a-f]{64}$/);
  assert.equal(first.taskProvenance.tasks[0].material, undefined);
  assert.equal(second.steps[0].taskId, "1", "the next journey sees the real pending state");
  assert.ok(calls.includes("prompt"));
  assert.equal(state.tasks[0].status, "pending");
});

test("provenance projection leaks no raw task text while drift detection still works", async () => {
  const SENTINEL_TITLE = "S3NT1N3L-T1TL3-αçe";
  const SENTINEL_DESCRIPTION = "S3NT1N3L-D3SCR1PT1ON-private-planning-hunter2";
  const sentinelTasks = structuredClone(state.tasks);
  sentinelTasks[0].subject = SENTINEL_TITLE;
  sentinelTasks[0].description = SENTINEL_DESCRIPTION;
  const sentinelSession = { ...session, sessionManager: { getSessionId: () => "offline-adapter-fixture", getBranch: () => [
    { type: "custom", customType: TASK_STATE_ENTRY, data: { highWaterMark: 3, tasks: sentinelTasks } },
  ] } };
  const runProcess = async ({ argv }) => {
    if (argv[1] === "get") return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "idle", repository: process.cwd() } }) };
    if (argv[1] === "prompt") return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: "worker", agent: "pi", status: "done", repository: process.cwd() } }) };
    return { code: 0, stdout: "[WORKER_REPORT_BEGIN]\ncompleted\n[WORKER_REPORT_END]" };
  };
  let registered;
  // options must ride on registration: execute() reads them from its closure.
  registerWorkerDispatchInterface({ registerTool(tool) { if (!registered) registered = tool; } },
    { taskStoreFactory: createTaskStore, runProcess });
  const toolResult = await registered.execute("", { action: "dispatch", role: "worker", stepPrompt: "step", maxSteps: 1 }, null, null,
    { ...sentinelSession, cwd: process.cwd(), mode: "tui", hasUI: true, ui: { confirm: async () => true } });
  const serialized = JSON.stringify(toolResult);
  assert.ok(toolResult.content?.[0]?.text && toolResult.details, "complete tool result shape");
  assert.ok(!serialized.includes(SENTINEL_TITLE) && !serialized.includes(SENTINEL_DESCRIPTION)
    && !serialized.includes("private-planning") && !serialized.includes("material"),
  "no raw provenance text in serialized content or details");
  assert.equal(toolResult.details.taskProvenance.status, "captured");
  assert.deepEqual(Object.keys(toolResult.details.taskProvenance.tasks[0]).sort(), ["digest", "id"]);
  // Local revalidation still detects description drift against the immutable capture.
  const capture = createTaskStore(sentinelSession).captureProvenance();
  assert.equal(createTaskStore(sentinelSession).revalidateProvenance(capture, "1").status, "matched");
  sentinelTasks[0].description = "tampered";
  assert.equal(createTaskStore(sentinelSession).revalidateProvenance(capture, "1").status, "content-drift");
});
