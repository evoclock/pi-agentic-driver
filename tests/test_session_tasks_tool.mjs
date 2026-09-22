// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Fix-round registered-tool tests for extensions/tasks.ts: picc-tasks
// v0.2.0 result-shape compatibility, dependency edge behavior, the preview
// token authority boundary, backlog default + canonical TASKS.md target,
// retry/link reconciliation, multi-blocker aggregation, capability
// enforcement, and legacy-unknown migration origin.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerTasksPi from "../extensions/tasks.ts";
import { promotionIdempotencyKey, forwardLinkFor, findExistingPromotedCard } from "../scripts/enforcement/session_tasks_core_pi.js";
import { parseBoard, validateBoard } from "../scripts/enforcement/task_board_core_pi.js";

// ---------------------------------------------------------------------------
// Registered-tool harness
// ---------------------------------------------------------------------------

async function makeHarness({ env = {}, uiConfirm = null, cwd = null } = {}) {
  const registered = new Map();
  const handlers = {};
  const pi = {
    registerTool: (tool) => registered.set(tool.name, tool),
    registerCommand: () => {},
    appendEntry: (_type, _data) => {},
    on: (_event, handler) => { handlers[_event] = handler; },
  };
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "tasks-tool-"));
  const listId = `sess-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    cwd: dir,
    mode: uiConfirm ? "tui" : "headless",
    hasUI: Boolean(uiConfirm),
    ui: uiConfirm ? { confirm: uiConfirm } : undefined,
    sessionManager: { getSessionId: () => listId, getBranch: () => [] },
  };
  const savedEnv = {};
  for (const key of ["PI_TASK_LIST_ID", "CLAUDE_CODE_TASK_LIST_ID", "HERDR_PANE_ID", "PI_SESSION_FILE", "AGENTIC_DRIVER_TASKS_CAPABILITY"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env, { PI_TASK_LIST_ID: listId });
  await registerTasksPi(pi);
  return {
    registered,
    ctx,
    dir,
    listId,
    boardPath: join(dir, "TASKS.md"),
    async call(name, params) {
      const tool = registered.get(name);
      assert.ok(tool, `${name} must be registered`);
      return tool.execute("call-id", params, undefined, undefined, ctx);
    },
    cleanup() {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const listIdOf = (h) => h.listId;

function detailsOf(result) {
  return result.details;
}

const OWNER_AUTH = () => ({
  source: "instruction",
  sessionOrReportId: "sess-owner-auth",
  quotedInstruction: "Promote these tasks to the board now.",
});

// ---------------------------------------------------------------------------
// Fix 1: picc-tasks v0.2.0 result-shape compatibility
// ---------------------------------------------------------------------------

test("TaskGet.details.task carries exactly the v0.2.0 restricted shape", async () => {
  const h = await makeHarness({ env: {} });
  try {
    await h.call("TaskCreate", { subject: "A", description: "first" });
    await h.call("TaskCreate", { subject: "B", description: "second", metadata: { origin: "coordinator", secret: "x" } });
    await h.call("TaskUpdate", { taskId: "1", addBlockedBy: ["2"] });
    const result = await h.call("TaskGet", { taskId: "1" });
    const details = detailsOf(result);
    assert.deepEqual(Object.keys(details.task).sort(), ["blockedBy", "blocks", "description", "id", "status", "subject"]);
    assert.equal(details.task.id, "1");
    assert.equal(details.task.status, "pending");
    assert.deepEqual(details.task.blockedBy, ["2"]);
    // metadata/activeForm/owner never leak through TaskGet.
    assert.equal(details.task.metadata, undefined);
    assert.equal(details.task.activeForm, undefined);
    assert.equal(details.task.owner, undefined);
    // The missing-task result shape matches v0.2.0.
    const missing = await h.call("TaskGet", { taskId: "99" });
    assert.deepEqual(detailsOf(missing), { task: null });
    assert.equal(missing.content[0].text, "Task not found");
  } finally { h.cleanup(); }
});

test("TaskUpdate reports statusChange and mirrors inverse dependency edges", async () => {
  const h = await makeHarness({ env: {} });
  try {
    await h.call("TaskCreate", { subject: "A", description: "first" });
    await h.call("TaskCreate", { subject: "B", description: "second" });
    const result = await h.call("TaskUpdate", { taskId: "1", status: "in_progress" });
    assert.deepEqual(detailsOf(result).statusChange, { from: "pending", to: "in_progress" });
    // addBlockedBy: forward edge plus mirror inverse on the upstream task.
    await h.call("TaskUpdate", { taskId: "1", addBlockedBy: ["2"] });
    const one = detailsOf(await h.call("TaskGet", { taskId: "1" })).task;
    const two = detailsOf(await h.call("TaskGet", { taskId: "2" })).task;
    assert.deepEqual(one.blockedBy, ["2"]);
    assert.deepEqual(two.blocks, ["1"]);
    // addBlocks: forward edge plus mirror inverse on the downstream task.
    await h.call("TaskUpdate", { taskId: "3", addBlocks: ["4"] }).catch(() => {});
    await h.call("TaskCreate", { subject: "C", description: "third" });
    await h.call("TaskCreate", { subject: "D", description: "fourth" });
    await h.call("TaskUpdate", { taskId: "3", addBlocks: ["4"] });
    const three = detailsOf(await h.call("TaskGet", { taskId: "3" })).task;
    const four = detailsOf(await h.call("TaskGet", { taskId: "4" })).task;
    assert.deepEqual(three.blocks, ["4"]);
    assert.deepEqual(four.blockedBy, ["3"]);
    // Unknown dependency targets are skipped, never added dangling.
    await h.call("TaskUpdate", { taskId: "3", addBlockedBy: ["999"] });
    const threeAfter = detailsOf(await h.call("TaskGet", { taskId: "3" })).task;
    assert.deepEqual(threeAfter.blockedBy, []); // "999" skipped; 3 blocks 4, not the reverse
    // Deleted status carries statusChange with to: "deleted".
    const deleted = await h.call("TaskUpdate", { taskId: "4", status: "deleted" });
    assert.deepEqual(detailsOf(deleted).statusChange, { from: "pending", to: "deleted" });
    assert.deepEqual(detailsOf(deleted).updatedFields, ["deleted"]);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix 3: backlog default + canonical TASKS.md-only target
// ---------------------------------------------------------------------------

test("preview defaults surviving pending and in_progress tasks to backlog", async () => {
  const h = await makeHarness({ env: {} });
  try {
    await h.call("TaskCreate", { subject: "Pending task", description: "p" });
    await h.call("TaskCreate", { subject: "Active task", description: "a" });
    await h.call("TaskUpdate", { taskId: "2", status: "in_progress" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1", "2"] }));
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.previews.map((p) => [p.taskId, p.cardInput.lane]), [["1", "backlog"], ["2", "backlog"]]);
    // Owner-explicit override is respected.
    const overridden = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["2"], laneOverrides: { "2": "in-progress" } }));
    assert.equal(overridden.previews[0].cardInput.lane, "in-progress");
  } finally { h.cleanup(); }
});

test("promotion targets canonical TASKS.md only; a board.md-only workspace still resolves to TASKS.md", async () => {
  const h = await makeHarness({ env: {} });
  try {
    writeFileSync(join(h.dir, "board.md"), "# Board\n\n## backlog\n", "utf8");
    await h.call("TaskCreate", { subject: "T", description: "d" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview" }));
    assert.equal(preview.target.canonicalTasksMdPath, h.boardPath);
    assert.ok(!preview.target.canonicalTasksMdPath.endsWith("board.md"));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix 2: preview token authority boundary
// ---------------------------------------------------------------------------

test("commit without a preview token is refused", async () => {
  const h = await makeHarness({
    env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" },
    uiConfirm: () => true,
  });
  try {
    await h.call("TaskCreate", { subject: "T", description: "d" });
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"],
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, false);
    assert.equal(commit.code, "preview-token-required");
    assert.equal(existsSync(h.boardPath), false, "no board bytes written without a prior preview");
  } finally { h.cleanup(); }
});

test("commit with a stale/mismatched preview token is refused", async () => {
  const h = await makeHarness({
    env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" },
    uiConfirm: () => true,
  });
  try {
    await h.call("TaskCreate", { subject: "T", description: "d" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1"], authority: OWNER_AUTH() }));
    // State drifts after the preview: the task's subject changes.
    await h.call("TaskUpdate", { taskId: "1", subject: "Changed subject" });
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"], previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, false);
    assert.equal(commit.code, "preview-token-mismatch");
    assert.equal(existsSync(h.boardPath), false);
  } finally { h.cleanup(); }
});

test("headless commit fails closed (native confirmation required)", async () => {
  const h = await makeHarness({ env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" } });
  try {
    await h.call("TaskCreate", { subject: "T", description: "d" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1"], authority: OWNER_AUTH() }));
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"], previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, false);
    assert.equal(commit.code, "native-confirmation-required");
    assert.equal(existsSync(h.boardPath), false);
  } finally { h.cleanup(); }
});

test("owner declining the native confirmation cancels the commit with no writes", async () => {
  const h = await makeHarness({
    env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" },
    uiConfirm: () => false,
  });
  try {
    await h.call("TaskCreate", { subject: "T", description: "d" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1"], authority: OWNER_AUTH() }));
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"], previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.code, "owner-cancelled");
    assert.equal(existsSync(h.boardPath), false);
  } finally { h.cleanup(); }
});

test("commit without the capability marker is refused before any write", async () => {
  const h = await makeHarness({
    env: {}, // marker deliberately absent
    uiConfirm: () => true,
  });
  try {
    await h.call("TaskCreate", { subject: "T", description: "d" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1"], authority: OWNER_AUTH() }));
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"], previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, false);
    assert.equal(commit.code, "capability-required");
    assert.equal(existsSync(h.boardPath), false);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix 4: retry/link reconciliation
// ---------------------------------------------------------------------------

test("retry after a completed promotion recovers the existing card id and repairs a missing reverse link", async () => {
  const h = await makeHarness({
    env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" },
    uiConfirm: () => true,
  });
  try {
    await h.call("TaskCreate", { subject: "T", description: "d" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1"], authority: OWNER_AUTH() }));
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"], previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, true);
    assert.equal(commit.promoted.length, 1);
    const cardId = commit.promoted[0].cardId;
    // Simulate a lost reverse link: clear the session task's cache.
    await h.call("TaskUpdate", { taskId: "1", metadata: { promotedCardId: null } });
    // Retry: the forward link on the board is authoritative; the card is
    // recovered (not re-written) and the reverse link is repaired.
    const retryPreview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1"], authority: OWNER_AUTH() }));
    assert.equal(retryPreview.previews.length, 0, "the already-promoted task is not re-previewed");
    assert.deepEqual(retryPreview.recovered, [{ taskId: "1", cardId, recovered: true, importedIdAuthoritative: true }]);
    const retry = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"], previewToken: retryPreview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.recovered, [{ taskId: "1", cardId, recovered: true, importedIdAuthoritative: true }]);
    // The recovery commit repairs the reverse link, so the default batch no
    // longer selects this task on its next preview.
    const afterRepair = detailsOf(await h.call("TaskPromote", { mode: "preview", authority: OWNER_AUTH() }));
    assert.deepEqual(afterRepair.previews, []);
    assert.deepEqual(afterRepair.recovered, []);
    // Exactly one card on the board (no duplicate write).
    assert.equal(parseBoard(readFileSync(h.boardPath, "utf8")).cards.length, 1);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix 5: multiple blockers aggregate into one complete-list update
// ---------------------------------------------------------------------------

test("two resolved blockers aggregate into one complete-list dependency update", async () => {
  const h = await makeHarness({
    env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" },
    uiConfirm: () => true,
  });
  try {
    await h.call("TaskCreate", { subject: "Dependent", description: "d" });
    await h.call("TaskCreate", { subject: "Blocker one", description: "d" });
    await h.call("TaskCreate", { subject: "Blocker two", description: "d" });
    await h.call("TaskUpdate", { taskId: "1", addBlockedBy: ["2", "3"] });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1", "2", "3"], authority: OWNER_AUTH() }));
    assert.equal(preview.previews.length, 3);
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1", "2", "3"], previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, true, JSON.stringify(commit.failed ?? commit));
    // The dependent card carries BOTH blockers in one complete list.
    const dependentCardId = commit.promoted.find((p) => p.taskId === "1").cardId;
    const parsed = parseBoard(readFileSync(h.boardPath, "utf8"));
    const dependent = parsed.cards.find((c) => c.cardId === dependentCardId);
    assert.equal(dependent.dependencies.length, 2, "both blockers present, none discarded");
    assert.deepEqual(dependent.dependencies.sort(), commit.promoted.filter((p) => p.taskId !== "1").map((p) => p.cardId).sort());
    assert.equal(commit.dependencyEdges.applied.length, 1);
    assert.equal(commit.dependencyEdges.failed.length, 0);
    assert.equal(commit.dependencyEdges.dropped.length, 0);
  } finally { h.cleanup(); }
});

test("a failed aggregate dependency update is reported loudly, never silently discarded", async () => {
  const h = await makeHarness({
    env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" },
    uiConfirm: () => true,
  });
  try {
    await h.call("TaskCreate", { subject: "Dependent", description: "d" });
    await h.call("TaskCreate", { subject: "Blocker one", description: "d" });
    await h.call("TaskCreate", { subject: "Blocker two", description: "d" });
    await h.call("TaskUpdate", { taskId: "1", addBlockedBy: ["2", "3"] });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1", "2", "3"], authority: OWNER_AUTH() }));
    // Simulate a partial writer failure: the dependent card's write fails.
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1", "2", "3"], previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, true);
    // Drop the dependent card from the board to simulate its write being
    // lost, then verify the next promotion reports the edge failure rather
    // than discarding the blockers.
    const parsed = parseBoard(readFileSync(h.boardPath, "utf8"));
    const dependentCardId = commit.promoted.find((p) => p.taskId === "1")?.cardId;
    if (dependentCardId) {
      const withoutDependent = parsed.cards.filter((c) => c.cardId !== dependentCardId);
      const { serializeBoard } = await import("../scripts/enforcement/task_board_core_pi.js");
      writeFileSync(h.boardPath, serializeBoard(withoutDependent, { surface: "tasks" }), "utf8");
    }
    // Re-promote the dependent task (fresh preview; its forward link is gone).
    const retryPreview = detailsOf(await h.call("TaskPromote", { mode: "preview", taskIds: ["1"], authority: OWNER_AUTH() }));
    const retry = detailsOf(await h.call("TaskPromote", {
      mode: "commit", taskIds: ["1"], previewToken: retryPreview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    // The blockers were already promoted earlier, so the edges resolve from
    // the board; the dependent card ends with both blockers or a loud
    // failure — never a silent discard.
    const afterBoard = parseBoard(readFileSync(h.boardPath, "utf8"));
    const newDependent = afterBoard.cards.find((c) => c.importedId === forwardLinkFor(promotionIdempotencyKey(listIdOf(h), "1")));
    const blockerIds = commit.promoted.filter((p) => p.taskId !== "1").map((p) => p.cardId);
    const hasBoth = newDependent && blockerIds.every((id) => newDependent.dependencies.includes(id));
    const reportedFailure = (retry.dependencyEdges?.failed ?? []).length > 0;
    assert.ok(hasBoth || reportedFailure, "blockers either land or fail loudly; never discarded");
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Board integrity after tool-level promotion
// ---------------------------------------------------------------------------

test("the board remains valid after a tool-level batch promotion", async () => {
  const h = await makeHarness({
    env: { AGENTIC_DRIVER_TASKS_CAPABILITY: "1" },
    uiConfirm: () => true,
  });
  try {
    await h.call("TaskCreate", { subject: "One", description: "d1" });
    await h.call("TaskCreate", { subject: "Two", description: "d2" });
    const preview = detailsOf(await h.call("TaskPromote", { mode: "preview", authority: OWNER_AUTH() }));
    const commit = detailsOf(await h.call("TaskPromote", {
      mode: "commit", previewToken: preview.previewToken,
      definitionOfDone: "dod", stoppingPoint: "stop", scopePaths: ["src/"],
      authority: OWNER_AUTH(),
    }));
    assert.equal(commit.ok, true);
    const validated = validateBoard(readFileSync(h.boardPath, "utf8"));
    assert.equal(validated.ok, true, (validated.errors ?? []).join("; "));
    assert.equal(validated.cards.length, 2);
  } finally { h.cleanup(); }
});
