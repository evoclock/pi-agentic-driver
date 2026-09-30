// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  TASK_STATE_ENTRY, resolveTaskListId, tasksMirrorPath, loadSnapshotFile, validateSnapshot,
} from "../scripts/enforcement/session_tasks_core_pi.js";
import { createHash } from "node:crypto";

// Match TaskList's branch-first/high-water-mark observation in tasks.ts.
// The session mirror is a fallback; neither reader changes either source.
function observeSessionTasks(ctx) {
  const id = resolveTaskListId({ session: ctx?.sessionManager?.getSessionId?.() ?? null });
  let branch = null;
  try {
    const entries = ctx?.sessionManager?.getBranch?.() ?? [];
    const snapshots = entries.filter((entry) => entry?.type === "custom" && entry?.customType === TASK_STATE_ENTRY);
    const candidate = snapshots.at(-1)?.data;
    if (validateSnapshot(candidate)) branch = candidate;
  } catch { /* disk mirror remains available */ }
  const disk = id ? loadSnapshotFile(tasksMirrorPath(id)) : null;
  const fromDisk = (Number(disk?.highWaterMark) || 0) > (Number(branch?.highWaterMark) || 0);
  const snapshot = fromDisk ? disk : branch ?? disk;
  return { tasks: snapshot?.tasks ?? [], taskListId: id, source: fromDisk || (!branch && disk) ? "disk" : branch ? "branch" : "none" };
}

export function sessionTasks(ctx) {
  return observeSessionTasks(ctx).tasks;
}

// Audit evidence only. A task-list environment override may select a different
// mirror; never attribute that mirror to the host session identity.
export function captureSessionTaskProvenance(ctx) {
  const hostSessionId = ctx?.sessionManager?.getSessionId?.();
  const observation = observeSessionTasks(ctx);
  const source = { hostSessionId: typeof hostSessionId === "string" && hostSessionId.trim() ? hostSessionId : null,
    taskListId: observation.taskListId, kind: observation.source };
  if (!source.hostSessionId) return { status: "host-session-unavailable", source, tasks: [] };
  if (source.taskListId !== source.hostSessionId) return { status: "task-list-mismatch", source, tasks: [] };
  if (source.kind === "none") return { status: "source-unavailable", source, tasks: [] };
  const capturedAt = new Date().toISOString();
  const tasks = observation.tasks.map(({ id, subject, description }) => {
    const material = { id, title: subject ?? null, description: description ?? null, capturedAt };
    const canonical = JSON.stringify({ capturedAt, description: material.description, id, title: material.title });
    return Object.freeze({ material: Object.freeze(material), digest: createHash("sha256").update(canonical, "utf8").digest("hex") });
  });
  return Object.freeze({ status: "captured", source: Object.freeze(source), tasks: Object.freeze(tasks) });
}

export function revalidateSessionTaskProvenance(ctx, capture, taskId) {
  if (capture?.status !== "captured") return { status: "capture-unavailable" };
  const current = captureSessionTaskProvenance(ctx);
  if (current.status !== "captured") return { status: current.status };
  if (current.source.hostSessionId !== capture.source.hostSessionId || current.source.taskListId !== capture.source.taskListId
    || current.source.kind !== capture.source.kind)
    return { status: "identity-mismatch" };
  const original = capture.tasks.find((entry) => entry.material.id === taskId);
  const observed = current.tasks.find((entry) => entry.material.id === taskId);
  if (!original || !observed) return { status: "task-missing" };
  return { status: original.material.title === observed.material.title
    && original.material.description === observed.material.description ? "matched" : "content-drift" };
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
    captureProvenance() { return captureSessionTaskProvenance(ctx); },
    revalidateProvenance(capture, id) { return revalidateSessionTaskProvenance(ctx, capture, id); },
  };
}
