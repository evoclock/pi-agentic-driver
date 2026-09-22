// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Session task list + owner-initiated board promotion (tasks #60 + #63,
// revised v1 scope). Core module: closed schemas, snapshot persistence,
// idempotency keys, dependency reconciliation, and promotion previews.
//
// Authority model:
//   - The session task list is working memory. Any session may write it.
//   - TASKS.md is written by the trusted writer ONLY
//     (task_board_core_pi.js writeCard/updateCard). This module is a writer
//     CLIENT: it never serializes or writes board bytes itself.
//   - Promotion is owner-initiated only. It requires a fresh, verbatim
//     owner quotedInstruction supplied through the owner-facing tool call.
//     It is never automatic, never a session-shutdown hook, and never
//     worker-authorized. A worker cannot promote (resolveCallerOrigin).
//
// Origin provenance (defense in depth, not authentication): caller origin
// is observed, not trusted. Unproven identity is recorded as
// "legacy-unknown" audit metadata. Origin metadata NEVER substitutes for
// the fresh owner authority record.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isValidAuthoritySource, parseBoard } from "./task_board_core_pi.js";

// ---------------------------------------------------------------------------
// Closed schemas (SPEC §6.3)
// ---------------------------------------------------------------------------

export const SESSION_TASKS_SCHEMA = "agentic-driver.session-tasks.v1";
export const TASK_PROMOTION_SCHEMA = "agentic-driver.task-promotion.v1";
export const TASK_STATE_ENTRY = "picc-tasks-state";
export const SESSION_TASK_STATUSES = Object.freeze(["pending", "in_progress", "completed"]);
export const TASK_LIST_STATUSES = Object.freeze(["pending", "in_progress", "completed"]);
export const ORIGIN_VALUES = Object.freeze(["coordinator", "worker"]);
export const LEGACY_UNKNOWN_ORIGIN = "legacy-unknown";
export const PROMOTED_TASK_STATUSES = Object.freeze(["pending", "in_progress"]);
export const PROMOTION_LANES = Object.freeze(["backlog", "in-progress"]);
export const COMPLETED_TASK_POLICY = Object.freeze(["skip", "promote-as-done"]);
export const BATCH_END_POLICY = Object.freeze(["offered", "off"]);
export const TRUSTED_HERDR_EXECUTABLE = "/opt/homebrew/bin/herdr";
export const DEFAULT_PROMOTION_LANE = "backlog";

/** picc-tasks task shape: the closed snapshot shape replay and migration read. */
export function validateSessionTask(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.id !== "string" || value.id === "") return false;
  if (!SESSION_TASK_STATUSES.includes(value.status)) return false;
  if (typeof value.subject !== "string" || typeof value.description !== "string") return false;
  for (const field of ["blocks", "blockedBy"]) {
    if (!Array.isArray(value[field]) || value[field].some((entry) => typeof entry !== "string")) return false;
  }
  for (const field of ["activeForm", "owner"]) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== "string") return false;
  }
  if (value.metadata !== undefined && value.metadata !== null
    && (typeof value.metadata !== "object" || Array.isArray(value.metadata))) return false;
  return true;
}

/**
 * Exact-shape snapshot check. `exact: true` (promotion requests) rejects
 * unknown keys; `exact: false` (snapshots from disk/branch) tolerates the
 * fields other tooling may add, matching picc-tasks' tolerant loader.
 */
export function validateSnapshot(value, { exact = false } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Number.isInteger(value.highWaterMark) || value.highWaterMark < 0) return false;
  if (!Array.isArray(value.tasks)) return false;
  if (exact) {
    const keys = Object.keys(value);
    for (const key of keys) {
      if (key !== "tasks" && key !== "highWaterMark") return false;
    }
  }
  return value.tasks.every((task) => validateSessionTask(task));
}

/** Promotion request: exact keys, closed enums, non-empty task list. */
export function validatePromotionRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["schema", "taskIds", "batch", "authority", "laneOverrides", "completedPolicy"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  if (value.schema !== TASK_PROMOTION_SCHEMA) return false;
  if (!Array.isArray(value.taskIds) || value.taskIds.length === 0
    || !value.taskIds.every((id) => typeof id === "string" && id !== "")) return false;
  if (typeof value.batch !== "boolean") return false;
  if (!isValidAuthoritySource(value.authority)) return false;
  if (typeof value.authority.quotedInstruction !== "string"
    || value.authority.quotedInstruction.trim() === "") return false;
  if (value.laneOverrides !== undefined) {
    if (value.laneOverrides === null || typeof value.laneOverrides !== "object"
      || Array.isArray(value.laneOverrides)) return false;
    for (const [id, lane] of Object.entries(value.laneOverrides)) {
      if (typeof id !== "string" || id === "" || !PROMOTION_LANES.includes(lane)) return false;
    }
  }
  if (value.completedPolicy !== undefined && !COMPLETED_TASK_POLICY.includes(value.completedPolicy)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// taskListId + persistence (picc-tasks-compatible)
// ---------------------------------------------------------------------------

/** taskListId = PI_TASK_LIST_ID ?? CLAUDE_CODE_TASK_LIST_ID ?? session ID. */
export function resolveTaskListId({ session } = {}) {
  const fromEnv = process.env.PI_TASK_LIST_ID ?? process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const sessionId = typeof session === "string" ? session.trim() : "";
  if (!sessionId) return null;
  return sessionId;
}

export function tasksMirrorPath(taskListId, { tasksRoot = null } = {}) {
  if (typeof taskListId !== "string" || taskListId.trim() === "") return null;
  const root = tasksRoot ?? join(homedir(), ".pi", "tasks");
  return join(root, taskListId, "tasks.json");
}

/** Load a picc-tasks mirror file tolerantly (the loader shape, not the writer). */
export function loadSnapshotFile(path) {
  if (typeof path !== "string" || path === "" || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!validateSnapshot(parsed)) return null;
    return { tasks: parsed.tasks, highWaterMark: parsed.highWaterMark };
  } catch {
    return null;
  }
}

/** Atomic temp+rename persist of the session snapshot mirror. */
export function persistSnapshot(path, snapshot) {
  if (!validateSnapshot(snapshot, { exact: true })) {
    throw Object.assign(new Error("snapshot does not satisfy the closed session-tasks schema"), {
      code: "snapshot-schema-invalid",
    });
  }
  mkdirSync(join(path, ".."), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Origin provenance (observed, never trusted)
// ---------------------------------------------------------------------------

/**
 * Best-effort caller-origin observation. A caller is treated as a worker
 * only when a Herdr observation matches this pane's own session evidence;
 * otherwise the origin is "legacy-unknown" audit metadata. The result is
 * advisory context for audit trails — it never authorizes anything and
 * never substitutes for a fresh owner authority record.
 */
export function resolveCallerOrigin({
  env = process.env,
  herdrExecutable = TRUSTED_HERDR_EXECUTABLE,
  runProcess = null,
} = {}) {
  const unproven = Object.freeze({
    origin: LEGACY_UNKNOWN_ORIGIN,
    proven: false,
    reason: "runtime worker identity could not be proven; origin recorded as audit metadata",
  });
  const paneId = typeof env.HERDR_PANE_ID === "string" ? env.HERDR_PANE_ID.trim() : "";
  const sessionFile = typeof env.PI_SESSION_FILE === "string" ? env.PI_SESSION_FILE.trim() : "";
  if (paneId === "" || sessionFile === "") return unproven;
  const argv = [herdrExecutable, "agent", "list"];
  let stdout;
  if (typeof runProcess === "function") {
    const out = runProcess({ argv: Object.freeze(argv) });
    if (typeof out !== "string") return unproven;
    stdout = out;
  } else {
    if (!existsSync(herdrExecutable)) return unproven;
    const proc = spawnSync(herdrExecutable, argv.slice(1), {
      shell: false, timeout: 5000, encoding: "utf8", maxBuffer: 128 * 1024,
    });
    if (proc.error || proc.status !== 0 || typeof proc.stdout !== "string") return unproven;
    stdout = proc.stdout;
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unproven;
  }
  const agents = parsed?.result?.agents;
  if (!Array.isArray(agents)) return unproven;
  for (const agent of agents) {
    if (agent?.pane_id !== paneId) continue;
    const session = agent?.agent_session;
    if (session?.kind === "path" && typeof session.value === "string" && session.value === sessionFile) {
      const name = typeof agent.name === "string" && agent.name !== "" ? agent.name : null;
      if (name === null) return unproven;
      return Object.freeze({ origin: "worker", proven: true, workerName: name, reason: "Herdr observation matched this pane's session file" });
    }
  }
  return unproven;
}

/**
 * Whether this session may act as the owner for promotion. A proven worker
 * pane cannot promote — the check is a precondition, not the authority
 * itself (authority is the fresh quotedInstruction record).
 */
export function canPromote(origin = null) {
  const resolved = origin ?? resolveCallerOrigin();
  return resolved.proven ? resolved.origin !== "worker" : true;
}

// ---------------------------------------------------------------------------
// Promotion idempotency
// ---------------------------------------------------------------------------

const IDEMPOTENCY_VERSION = "p1";
const IDEMPOTENCY_HASH_BITS = 32;
const IDEMPOTENCY_RE = /^[0-9a-f]+$/;

/**
 * Slash-free, collision-resistant idempotency key binding taskListId and
 * taskId. Format: `p1-<sha256(taskListId + "\u0000" + taskId).hex32>`.
 * Two different sessions with the same numeric task id never collide.
 */
export function promotionIdempotencyKey(taskListId, taskId) {
  if (typeof taskListId !== "string" || taskListId.trim() === "") {
    throw Object.assign(new Error("a non-empty taskListId is required for the idempotency key"), {
      code: "idempotency-key-invalid",
    });
  }
  if (typeof taskId !== "string" || taskId === "") {
    throw Object.assign(new Error("a non-empty taskId is required for the idempotency key"), {
      code: "idempotency-key-invalid",
    });
  }
  const digest = createHash("sha256")
    .update(`${taskListId}\u0000${taskId}`, "utf8")
    .digest("hex")
    .slice(0, IDEMPOTENCY_HASH_BITS / 4);
  return `${IDEMPOTENCY_VERSION}-${digest}`;
}

/** The forward link stored on the card: safe for importedId (no "/"). */
export function forwardLinkFor(idempotencyKey) {
  if (typeof idempotencyKey !== "string"
    || !/^p1-[0-9a-f]+$/.test(idempotencyKey)) {
    throw Object.assign(new Error("forwardLinkFor requires a promotion idempotency key"), {
      code: "idempotency-key-invalid",
    });
  }
  return idempotencyKey;
}

/** Backward-compat alias used by earlier drafts. */
export const sessionTaskImportedId = forwardLinkFor;

/**
 * Find an existing card minted from this promotion key. Searches importedId
 * first, then the writer-substituted form. Never parses board bytes itself
 * beyond the writer's own parseBoard (read-only).
 */
export function findExistingPromotedCard(boardMarkdown, idempotencyKey) {
  if (typeof boardMarkdown !== "string") return null;
  const forwardLink = forwardLinkFor(idempotencyKey);
  const parsed = parseBoard(boardMarkdown, { surface: "auto" });
  if (!parsed.ok) return null;
  return parsed.cards.find((card) => card.importedId === forwardLink
    || card.importedId === forwardLink.replace(/-/g, "--")) ?? null;
}

// ---------------------------------------------------------------------------
// Promotion preview (mandatory before any mutation)
// ---------------------------------------------------------------------------

const PREVIEW_TASK_FIELDS = ["id", "subject", "description", "status", "blocks", "blockedBy", "activeForm"];

function requireTaskFields(task) {
  if (!validateSessionTask(task)) {
    throw Object.assign(new Error("the task does not satisfy the closed session-task shape"), {
      code: "task-shape-invalid",
    });
  }
  return task;
}

/**
 * Build one promotion preview. Pure: reads nothing, writes nothing, errors
 * on every missing required board field. Owner-authorized fields
 * (authority, priority, scope, capabilities…) are never invented from task
 * text — absent inputs surface as `missing` entries the owner must supply.
 */
export function buildPromotionPreview({
  task,
  taskListId,
  boardPath,
  sessionOrReportId,
  laneOverride = null,
  completedPolicy = "skip",
  metadata = null,
}) {
  requireTaskFields(task);
  if (typeof taskListId !== "string" || taskListId.trim() === "") {
    throw Object.assign(new Error("taskListId is required for a promotion preview"), {
      code: "preview-invalid",
    });
  }
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required for a promotion preview"), {
      code: "preview-invalid",
    });
  }
  if (typeof sessionOrReportId !== "string" || sessionOrReportId.trim() === "") {
    throw Object.assign(new Error("sessionOrReportId is required for a promotion preview"), {
      code: "preview-invalid",
    });
  }
  if (task.status === "completed" && completedPolicy !== "promote-as-done") {
    throw Object.assign(
      new Error(`task #${task.id} is completed; v1 skips completed tasks unless completedPolicy is "promote-as-done"`),
      { code: "completed-task-skip" },
    );
  }
  const idempotencyKey = promotionIdempotencyKey(taskListId, task.id);
  // v1 default: surviving pending AND in_progress tasks promote into the
  // backlog lane so they remain dispatchable. in-progress lane placement is
  // an owner-explicit override only (laneOverride), never a status default.
  const proposedLane = laneOverride ?? DEFAULT_PROMOTION_LANE;
  if (!PROMOTION_LANES.includes(proposedLane)) {
    throw Object.assign(new Error(`lane "${proposedLane}" is not a promotion lane; use backlog or in-progress`), {
      code: "lane-not-promotable",
    });
  }
  // Title/specification/DoD/stoppingPoint are board-required fields. The
  // preview surfaces what the owner must supply; it never fabricates them.
  const missing = [];
  if (task.subject.trim() === "") missing.push("title");
  if (task.description.trim() === "") missing.push("specification");
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`task #${task.id} cannot be promoted yet; missing required board field(s): ${missing.join(", ")}`),
      { code: "preview-missing-required", missing },
    );
  }
  const dependencies = task.blockedBy
    .map((id) => promotionIdempotencyKey(taskListId, id))
    .map((key) => key.replace(/-/g, "--"));
  return Object.freeze({
    schema: TASK_PROMOTION_SCHEMA,
    preview: true,
    taskId: task.id,
    taskListId,
    idempotencyKey,
    target: Object.freeze({
      repositoryRoot: boardPath.includes("/") ? boardPath.slice(0, boardPath.lastIndexOf("/")) : ".",
      canonicalTasksMdPath: boardPath,
    }),
    source: Object.freeze({
      taskListId,
      taskId: task.id,
      sessionOrReportId,
      subject: task.subject,
      status: task.status,
      origin: metadata?.origin ?? LEGACY_UNKNOWN_ORIGIN,
    }),
    cardInput: Object.freeze({
      title: task.subject,
      description: task.description,
      specification: task.description,
      definitionOfDone: null,
      stoppingPoint: null,
      scopePaths: null,
      lane: proposedLane,
      dependencies,
      importedId: forwardLinkFor(idempotencyKey),
    }),
    missingOwnerFields: Object.freeze(["definitionOfDone", "stoppingPoint", "scopePaths", "authority"]),
    droppedPresentationFields: Object.freeze(["activeForm"]),
  });
}

/**
 * Build one preview per task for a batch. Skipped entries carry `skip`
 * (completed-task default or already promoted) and never appear in
 * `previews`. Non-atomicity is explicit: the batch is a sequence of
 * independent writer calls.
 */
export function buildBatchPromotionPreview({
  tasks,
  taskListId,
  boardPath,
  sessionOrReportId,
  laneOverrides = {},
  completedPolicy = "skip",
  existingKeys = () => null,
  metadataByTaskId = {},
}) {
  if (!Array.isArray(tasks)) {
    throw Object.assign(new Error("tasks must be an array"), { code: "preview-invalid" });
  }
  const previews = [];
  const skipped = [];
  for (const task of tasks) {
    requireTaskFields(task);
    if (task.status === "completed" && completedPolicy !== "promote-as-done") {
      skipped.push({ taskId: task.id, reason: "completed-task-skip (v1 default)" });
      continue;
    }
    const key = promotionIdempotencyKey(taskListId, task.id);
    if (typeof existingKeys === "function" && existingKeys(key)) {
      skipped.push({ taskId: task.id, reason: "already promoted (idempotency key present on the board)" });
      continue;
    }
    try {
      previews.push(buildPromotionPreview({
        task, taskListId, boardPath, sessionOrReportId,
        laneOverride: laneOverrides[task.id] ?? null,
        completedPolicy, metadata: metadataByTaskId[task.id] ?? null,
      }));
    } catch (error) {
      if (error?.code === "preview-missing-required") {
        skipped.push({ taskId: task.id, reason: error.message, missing: error.missing });
        continue;
      }
      throw error;
    }
  }
  return Object.freeze({ previews: Object.freeze(previews), skipped: Object.freeze(skipped) });
}

/**
 * Map a session blockedBy edge onto card IDs minted during the batch.
 * Edges whose blocker did not promote are dropped (recorded), never kept
 * dangling: the writer's validateBoard rejects dangling dependencies.
 */
export function reconcileDependencies({ previews, writerResults, sessionTasks, resolveBlockerCardId = null }) {
  const keyToCardId = new Map();
  for (const result of writerResults ?? []) {
    if (result?.ok && result?.idempotencyKey && result?.cardId) {
      keyToCardId.set(result.idempotencyKey, result.cardId);
    }
  }
  if (!Array.isArray(sessionTasks)) {
    throw Object.assign(new Error("sessionTasks must be the batch's session task array"), {
      code: "dependency-reconcile-invalid",
    });
  }
  const blockedByById = new Map(sessionTasks.map((task) => [task.id, task.blockedBy ?? []]));
  const edges = [];
  const dropped = [];
  for (const preview of previews ?? []) {
    const blockers = blockedByById.get(preview.taskId) ?? [];
    for (const blockerId of blockers) {
      const blockerKey = promotionIdempotencyKey(preview.taskListId, blockerId);
      let cardId = keyToCardId.get(blockerKey);
      if (!cardId && typeof resolveBlockerCardId === "function") {
        // The blocker promoted in an EARLIER run: resolve its minted cardId
        // from the board's authoritative forward link instead of discarding
        // the edge (never silently dropped when the card exists).
        cardId = resolveBlockerCardId(blockerKey) ?? null;
      }
      if (cardId) {
        edges.push({ taskId: preview.taskId, cardId: preview.cardInput.importedId, blockedByCardId: cardId });
      } else {
        dropped.push({ taskId: preview.taskId, blockerId, reason: "blocker was not promoted in this batch and no card carries its forward link" });
      }
    }
  }
  return Object.freeze({ edges: Object.freeze(edges), dropped: Object.freeze(dropped) });
}

/**
 * Apply dependency edges through updateCard-shaped calls. Edges are
 * AGGREGATED per dependent card: every resolved blocker lands in ONE
 * update with the complete dependency list — blockers are never silently
 * discarded, and a failed aggregate update fails loudly per card. Every
 * update carries the same authority record (the writer requires one for
 * every mutation). Edge updates are sequenced after all cards exist.
 */
export function applyDependencyEdges({ edges, authority, updateCardFn, currentDependencies = () => [] }) {
  if (typeof updateCardFn !== "function") {
    throw Object.assign(new Error("applyDependencyEdges requires an updateCard function"), {
      code: "dependency-reconcile-invalid",
    });
  }
  if (!isValidAuthoritySource(authority) || typeof authority.quotedInstruction !== "string") {
    throw Object.assign(new Error("dependency edge application requires a fresh verbatim owner authority record"), {
      code: "authority-required",
    });
  }
  // Aggregate edges by dependent card. The complete list for each card is
  // the resolved batch blockers PLUS the card's current dependencies (the
  // update tool's list fields are full replacement lists — omitting existing
  // entries would silently discard them).
  const byCard = new Map();
  for (const edge of edges ?? []) {
    const dependent = (edge.cardId ?? "").replace(/--/g, "-");
    const targetCardId = edge.dependentCardId ?? edge.targetCardId ?? dependent;
    if (!edge.blockedByCardId) continue;
    if (!byCard.has(targetCardId)) {
      byCard.set(targetCardId, { taskId: edge.taskId, cardId: targetCardId, blockers: new Set() });
    }
    byCard.get(targetCardId).blockers.add(edge.blockedByCardId);
  }
  const applied = [];
  const failed = [];
  for (const [targetCardId, entry] of byCard) {
    let existing = [];
    try { existing = currentDependencies(targetCardId) ?? []; } catch { existing = []; }
    const completeList = [...new Set([...existing, ...entry.blockers])];
    try {
      const result = updateCardFn({
        cardId: targetCardId,
        changes: { dependencies: completeList },
        authority,
      });
      if (result?.ok) {
        applied.push({ taskId: entry.taskId, cardId: targetCardId, blockedBy: completeList });
      } else {
        failed.push({ taskId: entry.taskId, cardId: targetCardId, blockedBy: completeList, reason: (result?.errors ?? []).join("; ") });
      }
    } catch (error) {
      failed.push({ taskId: entry.taskId, cardId: targetCardId, blockedBy: completeList, reason: String(error?.message ?? error).slice(0, 256) });
    }
  }
  return Object.freeze({ applied: Object.freeze(applied), failed: Object.freeze(failed) });
}

// ---------------------------------------------------------------------------
// Preview token: commit consumes a matching prior preview
// ---------------------------------------------------------------------------

/**
 * Compute the preview token: a deterministic digest binding the ENTIRE
 * preview state — task IDs, task contents, target repo/TASKS.md path, all
 * card fields, session identity, and the authority input. Commit MUST
 * present a token that matches a freshly recomputed digest of the same
 * state; a stale or mismatched token is refused. The token is NOT an
 * owner authority: it proves the preview step happened for exactly this
 * state, nothing more.
 */
export function previewToken({ previews, skipped, recovered, target, sessionOrReportId, authorityInput }) {
  const payload = {
    schema: TASK_PROMOTION_SCHEMA,
    previews: (previews ?? []).map((p) => ({
      taskId: p.taskId,
      taskListId: p.taskListId,
      idempotencyKey: p.idempotencyKey,
      cardInput: p.cardInput,
      source: p.source,
    })),
    skipped: skipped ?? [],
    recovered: recovered ?? [],
    target: target ?? null,
    sessionOrReportId: sessionOrReportId ?? null,
    authorityInput: {
      source: authorityInput?.source ?? null,
      sessionOrReportId: authorityInput?.sessionOrReportId ?? null,
      quotedInstructionSha256: typeof authorityInput?.quotedInstruction === "string"
        ? createHash("sha256").update(authorityInput.quotedInstruction, "utf8").digest("hex")
        : null,
    },
  };
  return `pv1-${createHash("sha256").update(canonicalJsonStable(payload), "utf8").digest("hex").slice(0, 32)}`;
}

/** Deterministic JSON serialization (sorted keys, no locale issues). */
function canonicalJsonStable(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJsonStable(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// Worker capability contract (documented loading, not package inclusion)
// ---------------------------------------------------------------------------

export const TASKS_SKILL_CAPABILITY = "tasks.skill.v1";
export const TASKS_CAPABILITY_ENV = "AGENTIC_DRIVER_TASKS_CAPABILITY";

/**
 * Whether this session has loaded the tasks skill capability. Package file
 * inclusion is NOT the contract: the capability is opt-in per session via
 * the env marker (worker briefs set it) or an explicit capability list.
 * Never coupled to any synchronous communication prompt.
 */
export function hasTasksCapability({ env = process.env, capabilities = null } = {}) {
  if (Array.isArray(capabilities)) return capabilities.includes(TASKS_SKILL_CAPABILITY);
  const value = typeof env[TASKS_CAPABILITY_ENV] === "string" ? env[TASKS_CAPABILITY_ENV].trim().toLowerCase() : "";
  return value === "1" || value === "true" || value === "yes" || value === "on" || value === TASKS_SKILL_CAPABILITY;
}

// Re-export the writer's authority-record validator so the extension can
// gate commit on a genuine record without importing the writer module twice.
export { isValidAuthoritySource } from "./task_board_core_pi.js";
