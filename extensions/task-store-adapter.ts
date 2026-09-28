// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  TASK_STATE_ENTRY, resolveTaskListId, tasksMirrorPath, loadSnapshotFile, validateSnapshot,
} from "../scripts/enforcement/session_tasks_core_pi.js";

// Match TaskList's branch-first/high-water-mark observation in tasks.ts.
// The session mirror is a fallback; neither reader changes either source.
export function sessionTasks(ctx) {
  const id = resolveTaskListId({ session: ctx?.sessionManager?.getSessionId?.() ?? null });
  let branch = null;
  try {
    const entries = ctx?.sessionManager?.getBranch?.() ?? [];
    const snapshots = entries.filter((entry) => entry?.type === "custom" && entry?.customType === TASK_STATE_ENTRY);
    const candidate = snapshots.at(-1)?.data;
    if (validateSnapshot(candidate)) branch = candidate;
  } catch { /* disk mirror remains available */ }
  const disk = id ? loadSnapshotFile(tasksMirrorPath(id)) : null;
  const snapshot = (Number(disk?.highWaterMark) || 0) > (Number(branch?.highWaterMark) || 0) ? disk : branch ?? disk;
  return snapshot?.tasks ?? [];
}

// One instance per journey: observeAdvance only skips an already-dispatched
// head in this journey. It never updates TaskList or persists a completion.
export function createTaskStore(ctx) {
  const skipped = new Set();
  return {
    list() {
      return sessionTasks(ctx).filter((task) => !skipped.has(task.id)).map((task) => ({
        id: task.id, status: task.status, blockedBy: [...(task.blockedBy ?? [])], owner: task.owner ?? null,
      }));
    },
    observeAdvance(id) { skipped.add(id); },
  };
}
