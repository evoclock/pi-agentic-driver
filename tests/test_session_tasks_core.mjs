// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Session tasks core tests: closed schemas, idempotency keys, promotion
// previews (mandatory, no invented owner fields), worker origin handling,
// and the documented capability loading contract.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_TASKS_SCHEMA, TASK_PROMOTION_SCHEMA,
  validateSessionTask, validateSnapshot, validatePromotionRequest,
  resolveTaskListId, tasksMirrorPath,
  promotionIdempotencyKey, forwardLinkFor, findExistingPromotedCard,
  buildPromotionPreview, buildBatchPromotionPreview,
  reconcileDependencies, applyDependencyEdges, previewToken,
  resolveCallerOrigin, canPromote, hasTasksCapability,
  LEGACY_UNKNOWN_ORIGIN, TASKS_SKILL_CAPABILITY, TASKS_CAPABILITY_ENV,
} from "../scripts/enforcement/session_tasks_core_pi.js";
import { parseBoard } from "../scripts/enforcement/task_board_core_pi.js";

const OWNER_AUTH = Object.freeze({
  source: "instruction",
  sessionOrReportId: "sess-A",
  quotedInstruction: "promote tasks 1 and 2 to the board",
});

function validTask(overrides = {}) {
  return {
    id: "1",
    subject: "Do the thing",
    description: "Describe the thing",
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Snapshot schema (agentic-driver.session-tasks.v1)
// ---------------------------------------------------------------------------

test("snapshot schema accepts the picc-tasks mirror shape", () => {
  assert.equal(validateSnapshot({ tasks: [], highWaterMark: 0 }), true);
  assert.equal(validateSnapshot({ tasks: [validTask()], highWaterMark: 1 }), true);
  assert.equal(validateSnapshot({ tasks: [validTask({ metadata: { origin: "coordinator" } })], highWaterMark: 1 }), true);
});

test("snapshot schema rejects bad status, bad high-water mark, non-object", () => {
  assert.equal(validateSnapshot({ tasks: [validTask({ status: "done" })], highWaterMark: 1 }), false);
  assert.equal(validateSnapshot({ tasks: [], highWaterMark: -1 }), false);
  assert.equal(validateSnapshot({ tasks: [], highWaterMark: 1.5 }), false);
  assert.equal(validateSnapshot(null), false);
  assert.equal(validateSnapshot({ tasks: "no" }), false);
});

test("exact snapshot validation rejects unknown keys", () => {
  assert.equal(validateSnapshot({ tasks: [], highWaterMark: 0, junk: 1 }, { exact: true }), false);
  assert.equal(validateSnapshot({ tasks: [], highWaterMark: 0 }, { exact: true }), true);
});

test("validateSessionTask enforces the closed picc-tasks shape", () => {
  assert.equal(validateSessionTask(validTask()), true);
  assert.equal(validateSessionTask(validTask({ id: 7 })), false);
  assert.equal(validateSessionTask(validTask({ status: "archived" })), false);
  assert.equal(validateSessionTask(validTask({ blockedBy: [3] })), false);
  assert.equal(validateSessionTask(validTask({ metadata: [] })), false);
});

// ---------------------------------------------------------------------------
// taskListId + mirror path
// ---------------------------------------------------------------------------

test("taskListId resolution follows the documented env chain", () => {
  assert.equal(resolveTaskListId({ session: "s1" }), "s1");
  assert.equal(resolveTaskListId({ session: null }), null);
  const saved = { pi: process.env.PI_TASK_LIST_ID, cc: process.env.CLAUDE_CODE_TASK_LIST_ID };
  process.env.PI_TASK_LIST_ID = "env-list";
  assert.equal(resolveTaskListId({ session: "s1" }), "env-list");
  delete process.env.PI_TASK_LIST_ID;
  process.env.CLAUDE_CODE_TASK_LIST_ID = "cc-list";
  assert.equal(resolveTaskListId({ session: "s1" }), "cc-list");
  process.env.PI_TASK_LIST_ID = saved.pi;
  if (saved.cc === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID; else process.env.CLAUDE_CODE_TASK_LIST_ID = saved.cc;
});

test("mirror path is directory-keyed by taskListId under ~/.pi/tasks", () => {
  const path = tasksMirrorPath("sess-42", { tasksRoot: "/tmp/x" });
  assert.equal(path, "/tmp/x/sess-42/tasks.json");
  assert.equal(tasksMirrorPath(""), null);
});

// ---------------------------------------------------------------------------
// Idempotency: taskListId + taskId, slash-free, collision-resistant
// ---------------------------------------------------------------------------

test("idempotency key is slash-free and deterministic", () => {
  const key = promotionIdempotencyKey("sess-A", "7");
  assert.ok(!key.includes("/"));
  assert.equal(key, promotionIdempotencyKey("sess-A", "7"));
  assert.match(key, /^p1-[0-9a-f]+$/);
});

test("another session's same numeric task id does not collide", () => {
  assert.notEqual(promotionIdempotencyKey("sess-A", "7"), promotionIdempotencyKey("sess-B", "7"));
});

test("forwardLinkFor rejects non-key input and produces an importedId without slashes", () => {
  assert.throws(() => forwardLinkFor("not-a-key"), /idempotency key/i);
  const link = forwardLinkFor(promotionIdempotencyKey("sess-A", "7"));
  assert.ok(!link.includes("/"));
});

test("findExistingPromotedCard locates a promoted card via importedId", () => {
  const key = promotionIdempotencyKey("sess-A", "7");
  const board = [
    "# Board",
    "",
    "## backlog",
    "",
    `- [ ] Do the thing [id:: T-0001] [importedId:: ${forwardLinkFor(key)}]`,
  ].join("\n");
  const card = findExistingPromotedCard(board, key);
  assert.ok(card);
  assert.equal(card.cardId, "T-0001");
  assert.equal(findExistingPromotedCard("# Board\\n\\n## backlog\\n", key), null);
});

// ---------------------------------------------------------------------------
// Promotion preview: mandatory, complete, no invented owner fields
// ---------------------------------------------------------------------------

test("preview shows target, source identity, card input, idempotency key", () => {
  const preview = buildPromotionPreview({
    task: validTask(),
    metadata: { origin: "coordinator" },
    taskListId: "sess-A",
    boardPath: "/repo/TASKS.md",
    sessionOrReportId: "sess-A",
  });
  assert.equal(preview.target.canonicalTasksMdPath, "/repo/TASKS.md");
  assert.equal(preview.target.repositoryRoot, "/repo");
  assert.equal(preview.source.taskListId, "sess-A");
  assert.equal(preview.source.taskId, "1");
  assert.equal(preview.source.origin, "coordinator");
  assert.equal(preview.cardInput.title, "Do the thing");
  assert.equal(preview.cardInput.lane, "backlog");
  assert.equal(preview.cardInput.importedId, forwardLinkFor(preview.idempotencyKey));
  assert.ok(preview.missingOwnerFields.includes("authority"));
  assert.ok(preview.missingOwnerFields.includes("definitionOfDone"));
  assert.ok(preview.missingOwnerFields.includes("stoppingPoint"));
  assert.ok(preview.missingOwnerFields.includes("scopePaths"));
});

test("in_progress tasks default to backlog; in-progress lane is owner-explicit only", () => {
  const p1 = buildPromotionPreview({
    task: validTask({ status: "in_progress" }),
    taskListId: "s", boardPath: "/r/TASKS.md", sessionOrReportId: "s",
  });
  assert.equal(p1.cardInput.lane, "backlog", "surviving in_progress tasks default to backlog (dispatchable)");
  const p2 = buildPromotionPreview({
    task: validTask(), laneOverride: "in-progress",
    taskListId: "s", boardPath: "/r/TASKS.md", sessionOrReportId: "s",
  });
  assert.equal(p2.cardInput.lane, "in-progress", "the owner-explicit override is respected");
});

test("preview errors on missing required board fields instead of inventing them", () => {
  assert.throws(
    () => buildPromotionPreview({
      task: validTask({ description: "" }),
      taskListId: "s", boardPath: "/r/TASKS.md", sessionOrReportId: "s",
    }),
    (error) => error.code === "preview-missing-required" && error.missing.includes("specification"),
  );
  assert.throws(
    () => buildPromotionPreview({
      task: validTask({ subject: "  " }),
      taskListId: "s", boardPath: "/r/TASKS.md", sessionOrReportId: "s",
    }),
    (error) => error.code === "preview-missing-required" && error.missing.includes("title"),
  );
});

test("completed tasks are skipped by default (v1) and never auto-promoted", () => {
  assert.throws(
    () => buildPromotionPreview({
      task: validTask({ status: "completed" }),
      taskListId: "s", boardPath: "/r/TASKS.md", sessionOrReportId: "s",
    }),
    (error) => error.code === "completed-task-skip",
  );
  const batch = buildBatchPromotionPreview({
    tasks: [validTask({ status: "completed" }), validTask({ id: "2" })],
    taskListId: "s", boardPath: "/r/TASKS.md", sessionOrReportId: "s",
  });
  assert.equal(batch.previews.length, 1);
  assert.equal(batch.skipped.length, 1);
  assert.match(batch.skipped[0].reason, /completed-task-skip/);
});

test("batch preview skips already-promoted tasks via the idempotency key", () => {
  const batch = buildBatchPromotionPreview({
    tasks: [validTask(), validTask({ id: "2" })],
    taskListId: "s", boardPath: "/r/TASKS.md", sessionOrReportId: "s",
    existingKeys: (key) => key === promotionIdempotencyKey("s", "1"),
  });
  assert.equal(batch.previews.length, 1);
  assert.equal(batch.previews[0].taskId, "2");
  assert.match(batch.skipped[0].reason, /already promoted/);
});

test("preview token binds recovered forward-link state", () => {
  const base = {
    previews: [], skipped: [], target: { canonicalTasksMdPath: "/r/TASKS.md" },
    sessionOrReportId: "sess-A", authorityInput: OWNER_AUTH,
  };
  const first = previewToken({ ...base, recovered: [{ taskId: "1", cardId: "T-0001" }] });
  const changed = previewToken({ ...base, recovered: [{ taskId: "1", cardId: "T-0002" }] });
  assert.notEqual(first, changed);
});

test("promotion request validation: exact keys, fresh verbatim authority required", () => {
  assert.equal(validatePromotionRequest({
    schema: TASK_PROMOTION_SCHEMA, taskIds: ["1"], batch: false, authority: OWNER_AUTH,
  }), true);
  assert.equal(validatePromotionRequest({
    schema: TASK_PROMOTION_SCHEMA, taskIds: ["1"], batch: false,
    authority: { source: "instruction", sessionOrReportId: "s", digest: "a".repeat(64) },
  }), false, "a digest alone is not a fresh owner instruction");
  assert.equal(validatePromotionRequest({
    schema: TASK_PROMOTION_SCHEMA, taskIds: [], batch: false, authority: OWNER_AUTH,
  }), false);
  assert.equal(validatePromotionRequest({
    schema: SESSION_TASKS_SCHEMA, taskIds: ["1"], batch: false, authority: OWNER_AUTH,
  }), false);
  assert.equal(validatePromotionRequest({
    schema: TASK_PROMOTION_SCHEMA, taskIds: ["1"], batch: false, authority: OWNER_AUTH, extra: true,
  }), false);
});

// ---------------------------------------------------------------------------
// Dependency reconciliation (post-write, writer-minted IDs, no dangles)
// ---------------------------------------------------------------------------

test("reconcileDependencies maps batch edges and drops non-batch blockers", () => {
  const tasks = [validTask({ id: "1", blockedBy: ["2", "9"] }), validTask({ id: "2" })];
  const batch = buildBatchPromotionPreview({
    tasks, taskListId: "sess-A", boardPath: "/r/TASKS.md", sessionOrReportId: "sess-A",
  });
  const writerResults = batch.previews.map((preview, i) => ({
    ok: true, idempotencyKey: preview.idempotencyKey, cardId: `T-000${i + 1}`,
  }));
  const rec = reconcileDependencies({ previews: batch.previews, writerResults, sessionTasks: tasks });
  assert.equal(rec.edges.length, 1);
  assert.equal(rec.edges[0].blockedByCardId, "T-0002");
  assert.equal(rec.dropped.length, 1);
  assert.equal(rec.dropped[0].blockerId, "9");
  assert.match(rec.dropped[0].reason, /not promoted in this batch/);
});

test("applyDependencyEdges refuses without a fresh verbatim owner authority record", () => {
  assert.throws(
    () => applyDependencyEdges({ edges: [], authority: { source: "instruction", sessionOrReportId: "s", digest: "a".repeat(64) }, updateCardFn: () => ({}) }),
    /authority/,
  );
  assert.throws(
    () => applyDependencyEdges({ edges: [], authority: OWNER_AUTH, updateCardFn: null }),
    /updateCard/,
  );
  const calls = [];
  const result = applyDependencyEdges({
    edges: [{ taskId: "1", cardId: forwardLinkFor(promotionIdempotencyKey("s", "1")), blockedByCardId: "T-0002" }],
    authority: OWNER_AUTH,
    updateCardFn: (call) => { calls.push(call); return { ok: true }; },
  });
  assert.equal(result.applied.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(calls[0].changes.dependencies[0], "T-0002");
});

test("applyDependencyEdges reports failed edge updates without throwing", () => {
  const result = applyDependencyEdges({
    edges: [{ taskId: "1", cardId: forwardLinkFor(promotionIdempotencyKey("s", "1")), blockedByCardId: "T-0002" }],
    authority: OWNER_AUTH,
    updateCardFn: () => ({ ok: false, errors: ["cardId T-0002 does not exist"] }),
  });
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /does not exist/);
});

// ---------------------------------------------------------------------------
// Worker origin: observed, never trusted; workers cannot promote
// ---------------------------------------------------------------------------

test("unprovable runtime identity records legacy-unknown audit metadata", () => {
  const origin = resolveCallerOrigin({ env: {}, runProcess: () => null });
  assert.equal(origin.origin, LEGACY_UNKNOWN_ORIGIN);
  assert.equal(origin.proven, false);
});

test("a mismatched Herdr observation is never treated as proof", () => {
  const fakeList = JSON.stringify({
    result: { agents: [{ name: "w", pane_id: "other:pane", agent_session: { kind: "path", value: "/other.jsonl" } }] },
  });
  const origin = resolveCallerOrigin({
    env: { HERDR_PANE_ID: "p1", PI_SESSION_FILE: "/mine.jsonl" },
    runProcess: () => fakeList,
  });
  assert.equal(origin.proven, false);
});

test("a matching Herdr observation proves worker origin; proven workers cannot promote", () => {
  const fakeList = JSON.stringify({
    result: { agents: [{ name: "worker-a", pane_id: "wF:p1", agent_session: { kind: "path", value: "/mine.jsonl" } }] },
  });
  const origin = resolveCallerOrigin({
    env: { HERDR_PANE_ID: "wF:p1", PI_SESSION_FILE: "/mine.jsonl" },
    runProcess: () => fakeList,
  });
  assert.equal(origin.proven, true);
  assert.equal(origin.origin, "worker");
  assert.equal(origin.workerName, "worker-a");
  assert.equal(canPromote(origin), false);
});

test("unproven origin does not by itself block owner promotion; authority is still required", () => {
  assert.equal(canPromote(resolveCallerOrigin({ env: {}, runProcess: () => null })), true);
});

test("a malformed Herdr listing fails closed to unproven", () => {
  assert.equal(resolveCallerOrigin({ env: { HERDR_PANE_ID: "p", PI_SESSION_FILE: "/s" }, runProcess: () => "not json" }).proven, false);
  assert.equal(resolveCallerOrigin({ env: { HERDR_PANE_ID: "p", PI_SESSION_FILE: "/s" }, runProcess: () => "{}" }).proven, false);
});

// ---------------------------------------------------------------------------
// Capability loading contract (documented opt-in, not package inclusion)
// ---------------------------------------------------------------------------

test("capability marker is opt-in per session; package presence is not the contract", () => {
  assert.equal(hasTasksCapability({ env: {} }), false);
  assert.equal(hasTasksCapability({ env: { [TASKS_CAPABILITY_ENV]: "1" } }), true);
  assert.equal(hasTasksCapability({ env: { [TASKS_CAPABILITY_ENV]: TASKS_SKILL_CAPABILITY } }), true);
  assert.equal(hasTasksCapability({ env: { [TASKS_CAPABILITY_ENV]: "0" } }), false);
  assert.equal(hasTasksCapability({ capabilities: [TASKS_SKILL_CAPABILITY] }), true);
  assert.equal(hasTasksCapability({ capabilities: ["other.skill"] }), false);
});
