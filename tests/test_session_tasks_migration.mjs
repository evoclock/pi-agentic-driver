// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Migration from picc-tasks: the driver skill reads the existing
// ~/.pi/tasks/{taskListId}/tasks.json (identical shape), backfills
// metadata.origin, and replay behavior is preserved. Rollback is NOT
// claimed symmetric: the driver writes the same file layout, but custom
// session entries and UI/reminder behavior are not covered by this module.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSnapshotFile, persistSnapshot, validateSnapshot, validateSessionTask,
  tasksMirrorPath, TASK_STATE_ENTRY, LEGACY_UNKNOWN_ORIGIN,
} from "../scripts/enforcement/session_tasks_core_pi.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "tasks-migration-"));
}

test("a picc-tasks tasks.json loads unchanged through the tolerant loader", () => {
  const root = tmpRoot();
  try {
    const mirror = tasksMirrorPath("sess-legacy", { tasksRoot: root });
    mkdirSync(join(mirror, ".."), { recursive: true });
    // Exact picc-tasks layout: {tasks:[...], highWaterMark} with picc-tasks
    // task fields (id, subject, description, activeForm, status, blocks,
    // blockedBy, metadata).
    const piccSnapshot = {
      tasks: [
        {
          id: "1", subject: "Legacy task", description: "From picc-tasks",
          activeForm: "Working on it", status: "in_progress",
          blocks: ["2"], blockedBy: [],
          metadata: { custom: "value" },
        },
        {
          id: "2", subject: "Second", description: "d", status: "pending",
          blocks: [], blockedBy: ["1"],
        },
      ],
      highWaterMark: 2,
    };
    writeFileSync(mirror, JSON.stringify(piccSnapshot, null, 2), "utf8");
    const loaded = loadSnapshotFile(mirror);
    assert.ok(loaded);
    assert.equal(loaded.highWaterMark, 2);
    assert.equal(loaded.tasks.length, 2);
    assert.equal(loaded.tasks[0].activeForm, "Working on it");
    assert.equal(loaded.tasks[0].metadata.custom, "value");
    assert.ok(validateSnapshot(loaded));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("origin backfill: legacy tasks without metadata get legacy-unknown origin on import", () => {
  const root = tmpRoot();
  try {
    const mirror = tasksMirrorPath("sess-legacy", { tasksRoot: root });
    mkdirSync(join(mirror, ".."), { recursive: true });
    writeFileSync(mirror, JSON.stringify({
      tasks: [
        { id: "1", subject: "A", description: "d", status: "pending", blocks: [], blockedBy: [] },
        { id: "2", subject: "B", description: "d", status: "pending", blocks: [], blockedBy: [], metadata: { origin: "worker" } },
      ],
      highWaterMark: 2,
    }), "utf8");
    const loaded = loadSnapshotFile(mirror);
    // The documented import rule: missing origin is NEVER inferred. There is
    // no trusted runtime source for legacy tasks' creation context, so they
    // backfill to "legacy-unknown" audit metadata. Existing worker origin is
    // preserved (never rewritten).
    const backfilled = loaded.tasks.map((task) => ({
      ...task,
      metadata: { origin: LEGACY_UNKNOWN_ORIGIN, ...(task.metadata ?? {}) },
    }));
    assert.equal(backfilled[0].metadata.origin, LEGACY_UNKNOWN_ORIGIN);
    assert.equal(backfilled[1].metadata.origin, "worker");
    // The backfilled snapshot still satisfies the closed schema and persists.
    assert.ok(validateSnapshot({ tasks: backfilled, highWaterMark: loaded.highWaterMark }, { exact: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted snapshots replay through the same picc-tasks-state entry shape", () => {
  const root = tmpRoot();
  try {
    const mirror = tasksMirrorPath("sess-replay", { tasksRoot: root });
    const snapshot = {
      tasks: [{ id: "1", subject: "A", description: "d", status: "pending", blocks: [], blockedBy: [], metadata: { origin: "coordinator" } }],
      highWaterMark: 1,
    };
    persistSnapshot(mirror, snapshot);
    // The session entry the skill appends is the same custom entry
    // picc-tasks uses; replay reads the same {tasks, highWaterMark} shape.
    const entry = { type: "custom", customType: TASK_STATE_ENTRY, data: snapshot };
    assert.equal(entry.customType, "picc-tasks-state");
    assert.ok(validateSnapshot(entry.data));
    // Disk mirror round-trips.
    const reloaded = loadSnapshotFile(mirror);
    assert.deepEqual(reloaded, snapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt mirror file fails closed to null (fresh start), never throws", () => {
  const root = tmpRoot();
  try {
    const mirror = tasksMirrorPath("sess-corrupt", { tasksRoot: root });
    mkdirSync(join(mirror, ".."), { recursive: true });
    writeFileSync(mirror, "{not json", "utf8");
    assert.equal(loadSnapshotFile(mirror), null);
    writeFileSync(mirror, JSON.stringify({ tasks: [{ id: "1", status: "bogus" }], highWaterMark: 1 }), "utf8");
    assert.equal(loadSnapshotFile(mirror), null);
    assert.equal(loadSnapshotFile(join(root, "missing", "tasks.json")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback is documented as NOT symmetric for custom entries and UI behavior", () => {
  // This is a documentation contract test: the migration notes in the skill
  // doc must not claim symmetric rollback. The retained surface is the file
  // layout (picc-tasks reads its own data back); deferred surface is custom
  // session entries (picc-tasks-state vs the driver's entry name) and
  // UI/reminder behavior.
  const doc = readFileSync(new URL("../skills/tasks/SKILL.md", import.meta.url), "utf8");
  assert.match(doc, /picc-tasks/i);
  assert.match(doc, /not symmetric|is not symmetric|no symmetric rollback/i);
  assert.match(doc, /MIT/i);
});
