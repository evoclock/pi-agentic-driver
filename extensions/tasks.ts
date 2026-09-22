// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// TASKS provider extension (tasks #60 + #63, revised v1). Registers the
// session task tools (TaskCreate/TaskGet/TaskList/TaskUpdate — same names,
// schema, result text, and storage model as picc-tasks) and the
// owner-initiated TaskPromote bridge to the trusted board writer.
//
// Governance invariants (revised v1 scope):
//   - Promotion is NEVER automatic, never a session-shutdown hook, and
//     never worker-authorized. It requires a fresh exact owner
//     quotedInstruction supplied through this tool call.
//   - Preview is mandatory before mutation; missing required board fields
//     are structured refusals, never invented from task text.
//   - The single trusted-writer path: this extension forwards the preview's
//     card input plus the owner's authority record to writeCard /
//     updateCard. It never serializes or writes TASKS.md directly.
//   - Completed tasks are skipped by default; survivors default to the
//     backlog lane (dispatchable). in-progress lane placement does not
//     make a card dispatchable by itself.

import {
  SESSION_TASKS_SCHEMA, TASK_PROMOTION_SCHEMA,
  resolveTaskListId, tasksMirrorPath, loadSnapshotFile, persistSnapshot,
  validateSnapshot, validatePromotionRequest,
  buildPromotionPreview, buildBatchPromotionPreview,
  reconcileDependencies, applyDependencyEdges,
  promotionIdempotencyKey, forwardLinkFor, findExistingPromotedCard,
  resolveCallerOrigin, canPromote, hasTasksCapability,
} from "../scripts/enforcement/session_tasks_core_pi.js";
import { writeCard, updateCard, parseBoard } from "../scripts/enforcement/task_board_core_pi.js";

const TASK_STATE_ENTRY = "picc-tasks-state";

// Board resolution for promotion targets the CANONICAL TASKS.md only. The
// board.md projection is a derived view and is never a write target: if only
// a projection exists, the canonical path is returned so the writer
// bootstraps (or refuses) on the canonical file, never the projection.
function resolveBoardPath(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  return join(cwd, "TASKS.md");
}

const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function failResult(code, reason, extra = {}) {
  return textResult({ ok: false, code, reason, errors: [reason], ...extra });
}

export default async function tasksPi(pi) {
  const core = await import(new URL("../scripts/enforcement/session_tasks_core_pi.js", import.meta.url).href);
  const board = await import(new URL("../scripts/enforcement/task_board_core_pi.js", import.meta.url).href);
  const { isNativeTuiContext } = await import(new URL("../scripts/enforcement/native_tui_context.js", import.meta.url).href);

  // Session task state: the picc-tasks model (in-memory list + high-water
  // mark, session JSONL snapshot entries, disk mirror).
  let tasks = [];
  let highWaterMark = 0;
  let taskListId = null;
  let mirrorPath = null;
  let lastCtx = null;

  const WIDGET_KEY = "picc-tasks";
  const TASK_ICONS = Object.freeze({ pending: "▫", in_progress: "▪", completed: "✓" });

  const isVisible = (task) => task?.metadata?._internal !== true;
  const unresolvedTaskIds = () => new Set(
    tasks.filter((task) => task.status !== "completed").map((task) => task.id),
  );

  const renderTaskListLine = (task) => {
    const parts = [
      `${TASK_ICONS[task.status] ?? "?"} #${task.id}`,
      `[${task.status}]`,
      task.subject,
    ];
    if (task.owner) parts.push(`(${task.owner})`);
    let line = parts.join(" ");
    const unresolved = unresolvedTaskIds();
    const live = task.blockedBy.filter((id) => unresolved.has(id));
    if (live.length > 0) line += ` [blocked by ${live.map((id) => `#${id}`).join(", ")}]`;
    return line;
  };

  const renderTaskListLineForLLM = (task) => {
    const parts = [`#${task.id}`, `[${task.status}]`, task.subject];
    if (task.owner) parts.push(`(${task.owner})`);
    let line = parts.join(" ");
    const unresolved = unresolvedTaskIds();
    const live = task.blockedBy.filter((id) => unresolved.has(id));
    if (live.length > 0) line += ` [blocked by ${live.map((id) => `#${id}`).join(", ")}]`;
    return line;
  };

  const themed = (theme, method, args, fallback) => {
    try {
      if (typeof theme?.[method] === "function") return theme[method](...args);
    } catch { /* UI styling is best-effort */ }
    return fallback;
  };

  const renderWidgetTaskLine = (theme, task, unresolved) => {
    const live = task.blockedBy.filter((id) => unresolved.has(id));
    const parts = [
      TASK_ICONS[task.status] ?? "?",
      `[${task.status}]`,
      task.subject,
    ];
    if (task.owner) parts.push(`(${task.owner})`);
    let line = parts.join(" ");
    if (live.length > 0) line += ` [blocked by ${live.map((id) => `#${id}`).join(", ")}]`;
    if (task.status === "completed") {
      return themed(theme, "strikethrough", [line], line);
    }
    if (task.status === "in_progress") {
      return themed(theme, "bold", [line], line);
    }
    return themed(theme, "fg", [live.length > 0 ? "dim" : "text", line], line);
  };

  // UI is deliberately a best-effort projection of the task state. A context
  // can become stale during /new, /fork, /resume, or /reload; task mutations
  // must still succeed and the next session event will render the projection.
  const refreshUI = (ctx = null) => {
    if (ctx) lastCtx = ctx;
    let uiHost;
    try {
      uiHost = ctx ?? lastCtx;
      if (!uiHost || uiHost.hasUI === false || !uiHost.ui) return;
    } catch {
      return;
    }

    const visible = tasks.filter(isVisible);
    try {
      if (typeof uiHost.ui.setWidget === "function") {
        if (visible.length === 0) {
          uiHost.ui.setWidget(WIDGET_KEY, undefined);
        } else {
          const counts = {
            pending: visible.filter((task) => task.status === "pending").length,
            in_progress: visible.filter((task) => task.status === "in_progress").length,
            completed: visible.filter((task) => task.status === "completed").length,
          };
          const header = `Tasks  ${counts.pending} pending · ${counts.in_progress} in progress · ${counts.completed} done`;
          const unresolved = unresolvedTaskIds();
          const theme = uiHost.ui.theme;
          const rows = [...visible]
            .sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id))
            .map((task) => renderWidgetTaskLine(theme, task, unresolved));
          uiHost.ui.setWidget(WIDGET_KEY, [themed(theme, "fg", ["dim", header], header), ...rows], { placement: "aboveEditor" });
        }
      }
    } catch {
      // A stale UI host must never turn a successful tool mutation into an error.
    }

    try {
      if (typeof uiHost.ui.setStatus === "function") {
        if (visible.length === 0) {
          uiHost.ui.setStatus(WIDGET_KEY, undefined);
        } else {
          const active = visible.filter((task) => task.status === "in_progress").length;
          const done = visible.filter((task) => task.status === "completed").length;
          const total = visible.length;
          uiHost.ui.setStatus(WIDGET_KEY, active > 0 ? `${active} active / ${done}/${total} tasks` : `${done}/${total} tasks`);
        }
      }
    } catch {
      // Footer refresh is independent of the widget and equally best-effort.
    }
  };

  const syncState = (ctx) => {
    if (ctx) lastCtx = ctx;
    taskListId = core.resolveTaskListId({ session: ctx?.sessionManager?.getSessionId?.() ?? null });
    mirrorPath = core.tasksMirrorPath(taskListId);
    // Replay: the branch's last picc-tasks-state entry wins; disk mirror is
    // the fallback (three-way merge on highWaterMark, as picc-tasks does).
    let fromBranch = null;
    try {
      const branch = ctx?.sessionManager?.getBranch?.() ?? [];
      const snapshots = branch.filter((e) => e?.type === "custom" && e?.customType === TASK_STATE_ENTRY);
      if (snapshots.length > 0) fromBranch = snapshots[snapshots.length - 1]?.data ?? null;
    } catch { /* branch not ready; disk fallback */ }
    const fromDisk = mirrorPath ? core.loadSnapshotFile(mirrorPath) : null;
    const branchHwm = Number(fromBranch?.highWaterMark) || 0;
    const diskHwm = Number(fromDisk?.highWaterMark) || 0;
    if (branchHwm === 0 && diskHwm === 0) {
      tasks = []; highWaterMark = 0;
    } else if (diskHwm > branchHwm) {
      tasks = fromDisk.tasks; highWaterMark = diskHwm;
    } else {
      tasks = fromBranch.tasks; highWaterMark = branchHwm;
    }
    refreshUI(ctx);
  };

  const commitChange = (ctx) => {
    if (ctx) lastCtx = ctx;
    const snapshot = { tasks: tasks.map((t) => ({ ...t })), highWaterMark };
    try {
      pi.appendEntry(TASK_STATE_ENTRY, snapshot);
    } catch { /* stale ctx after /new, /fork, /resume: disk mirror holds the snapshot */ }
    if (mirrorPath) {
      try { core.persistSnapshot(mirrorPath, snapshot); } catch { /* non-fatal */ }
    }
    refreshUI(ctx);
  };

  const findTask = (id) => tasks.find((t) => t.id === id);

  const stampOrigin = (task) => {
    const observed = core.resolveCallerOrigin();
    // Origin is observed audit metadata, never trusted caller-supplied input.
    const metadata = { ...(task.metadata ?? {}) };
    delete metadata.originClaimed;
    if (observed.proven) metadata.origin = observed.origin;
    else if (metadata.origin !== "coordinator" && metadata.origin !== "worker") metadata.origin = core.LEGACY_UNKNOWN_ORIGIN;
    return { ...task, metadata };
  };

  if (typeof pi?.registerTool === "function") {
    // --- TaskCreate (picc-tasks-compatible) ---
    pi.registerTool({
      name: "TaskCreate",
      label: "TaskCreate",
      description: "Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\n\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\n\nUse this tool proactively in these scenarios:\n\n- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n- Plan mode - When using plan mode, create a task list to track the work\n- User explicitly requests todo list - When the user directly asks you to use the todo list\n- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n- After receiving new instructions - Immediately capture user requirements as tasks\n- When you start working on a task - Mark it as in_progress BEFORE beginning work\n- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n- There is only a single, straightforward task\n- The task can be completed in less than 3 trivial steps\n- The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Task Fields\n\n- **subject**: A brief, actionable title in imperative form (e.g., \"Fix authentication bug in login flow\")\n- **description**: What needs to be done\n- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., \"Fixing authentication bug\"). If omitted, the spinner shows the subject instead.\n\nAll tasks are created with status `pending`.\n\n## Tips\n\n- Create tasks with clear, specific subjects that describe the outcome\n- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed\n- Check TaskList first to avoid creating duplicate tasks\n",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string", description: "A brief title for the task" },
          description: { type: "string", description: "What needs to be done" },
          activeForm: { type: "string", description: "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")" },
          metadata: { type: "object", description: "Arbitrary metadata to attach to the task", additionalProperties: true, properties: {} },
        },
        required: ["subject", "description"],
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        highWaterMark += 1;
        let task = {
          id: String(highWaterMark),
          subject: params.subject,
          description: params.description,
          status: "pending",
          blocks: [],
          blockedBy: [],
          ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
          ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
        };
        task = stampOrigin(task);
        tasks.push(task);
        commitChange(ctx);
        return {
          content: [{ type: "text", text: `Task #${task.id} created successfully: ${task.subject}` }],
          details: { task: { id: task.id, subject: task.subject } },
        };
      },
    });

    // --- TaskGet (picc-tasks-compatible) ---
    pi.registerTool({
      name: "TaskGet",
      label: "TaskGet",
      description: "Use this tool to retrieve a task by its ID from the task list.\n\n## When to Use This Tool\n\n- When you need the full description and context before starting work on a task\n- To understand task dependencies (what it blocks, what blocks it)\n- After being assigned a task, to get complete requirements\n\n## Output\n\nReturns full task details:\n- **subject**: Task title\n- **description**: Detailed requirements and context\n- **status**: 'pending', 'in_progress', or 'completed'\n- **blocks**: Tasks waiting on this one to complete\n- **blockedBy**: Tasks that must complete before this one can start\n\n## Tips\n\n- After fetching a task, verify its blockedBy list is empty before beginning work.\n- Use TaskList to see all tasks in summary form.",
      parameters: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", description: "The ID of the task to retrieve" } }, required: ["taskId"] },
      async execute(_toolCallId, params) {
        const task = findTask(params.taskId);
        if (!task) return { content: [{ type: "text", text: "Task not found" }], details: { task: null } };
        const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`];
        if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
        if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
        // picc-tasks v0.2.0 TaskGet details carry the restricted task shape
        // only: {id, subject, description, status, blocks, blockedBy}. No
        // metadata, activeForm, or owner leak through this surface.
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            task: {
              id: task.id,
              subject: task.subject,
              description: task.description,
              status: task.status,
              blocks: [...task.blocks],
              blockedBy: [...task.blockedBy],
            },
          },
        };
      },
    });

    // --- TaskList (picc-tasks-compatible) ---
    pi.registerTool({
      name: "TaskList",
      label: "TaskList",
      description: "Use this tool to list all tasks in the task list.\n\n## When to Use This Tool\n\n- To see what tasks are available to work on (status: 'pending', no owner, not blocked)\n- To check overall progress on the project\n- To find tasks that are blocked and need dependencies resolved\n- After completing a task, to check for newly unblocked work or claim the next available task\n- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones\n\n## Output\n\nReturns a summary of each task:\n- **id**: Task identifier (use with TaskGet, TaskUpdate)\n- **subject**: Brief description of the task\n- **status**: 'pending', 'in_progress', or 'completed'\n- **owner**: Agent ID if assigned, empty if available\n- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)\n\nUse TaskGet with a specific task ID to view full details including description and comments.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const visible = tasks.filter(isVisible);
        if (visible.length === 0) return { content: [{ type: "text", text: "No tasks found" }], details: { tasks: [] } };
        const unresolved = unresolvedTaskIds();
        const list = visible.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          ...(t.owner !== undefined ? { owner: t.owner } : {}),
          blockedBy: t.blockedBy.filter((id) => unresolved.has(id)),
        }));
        const lines = list.map(renderTaskListLineForLLM);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { tasks: list } };
      },
    });

    // --- TaskUpdate (picc-tasks-compatible) ---
    pi.registerTool({
      name: "TaskUpdate",
      label: "TaskUpdate",
      description: "Use this tool to update a task in the task list.\n\n## When to Use This Tool\n\n**Mark tasks as resolved:**\n- When you have completed the work described in a task\n- When a task is no longer needed or has been superseded\n- IMPORTANT: Always mark your assigned tasks as resolved when you finish them\n- After resolving, call TaskList to find your next task\n\n- ONLY mark a task as completed when you have FULLY accomplished it\n- If you encounter errors, blockers, or cannot finish, keep the task as in_progress\n- When blocked, create a new task describing what needs to be resolved\n- Never mark a task as completed if:\n  - Tests are failing\n  - Implementation is partial\n  - You encountered unresolved errors\n  - You couldn't find necessary files or dependencies\n\n**Delete tasks:**\n- When a task is no longer relevant or was created in error\n- Setting status to `deleted` permanently removes the task\n\n**Update task details:**\n- When requirements change or become clearer\n- When establishing dependencies between tasks\n\n## Fields You Can Update\n\n- **status**: The task status (see Status Workflow below)\n- **subject**: Change the task title (imperative form, e.g., \"Run tests\")\n- **description**: Change the task description\n- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")\n- **owner**: Change the task owner (agent name)\n- **metadata**: Merge metadata keys into the task (set a key to null to delete it)\n- **addBlocks**: Mark tasks that cannot start until this one completes\n- **addBlockedBy**: Mark tasks that must complete before this one can start\n\n## Status Workflow\n\nStatus progresses: `pending` → `in_progress` → `completed`\n\nUse `deleted` to permanently remove a task.\n\n## Staleness\n\nMake sure to read a task's latest state using `TaskGet` before updating it.\n\n## Examples\n\nMark task as in progress when starting work:\n```json\n{\"taskId\": \"1\", \"status\": \"in_progress\"}\n```\n\nMark task as completed after finishing work:\n```json\n{\"taskId\": \"1\", \"status\": \"completed\"}\n```\n\nDelete a task:\n```json\n{\"taskId\": \"1\", \"status\": \"deleted\"}\n```\n\nClaim a task by setting owner:\n```json\n{\"taskId\": \"1\", \"owner\": \"my-name\"}\n```\n\nSet up task dependencies:\n```json\n{\"taskId\": \"2\", \"addBlockedBy\": [\"1\"]}\n```",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string", description: "The ID of the task to update" },
          subject: { type: "string", description: "New subject for the task" },
          description: { type: "string", description: "New description for the task" },
          activeForm: { type: "string", description: "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")" },
          owner: { type: "string", description: "New owner for the task" },
          metadata: { type: "object", description: "Metadata keys to merge into the task. Set a key to null to delete it.", additionalProperties: true, properties: {} },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status for the task" },
          addBlocks: { type: "array", items: { type: "string" }, description: "Task IDs that this task blocks" },
          addBlockedBy: { type: "array", items: { type: "string" }, description: "Task IDs that block this task" },
        },
        required: ["taskId"],
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const idx = tasks.findIndex((t) => t.id === params.taskId);
        if (idx === -1) {
          return { content: [{ type: "text", text: "Task not found" }], details: { success: false, taskId: params.taskId, error: "Task not found", updatedFields: [] } };
        }
        const task = tasks[idx];
        const updatedFields = [];
        let statusChange;
        if (params.subject !== undefined && params.subject !== task.subject) { task.subject = params.subject; updatedFields.push("subject"); }
        if (params.description !== undefined && params.description !== task.description) { task.description = params.description; updatedFields.push("description"); }
        if (params.activeForm !== undefined && params.activeForm !== task.activeForm) { task.activeForm = params.activeForm; updatedFields.push("activeForm"); }
        if (params.owner !== undefined && params.owner !== task.owner) { task.owner = params.owner; updatedFields.push("owner"); }
        if (params.metadata !== undefined) {
          const merged = { ...(task.metadata ?? {}) };
          for (const [k, v] of Object.entries(params.metadata)) {
            if (v === null) delete merged[k]; else merged[k] = v;
          }
          if (Object.keys(merged).length > 0) task.metadata = merged; else delete task.metadata;
          updatedFields.push("metadata");
        }
        if (params.status !== undefined && params.status !== task.status) {
          if (params.status === "deleted") {
            statusChange = { from: task.status, to: "deleted" };
            tasks.splice(idx, 1);
            const n = Number.parseInt(task.id, 10);
            if (!Number.isNaN(n)) highWaterMark = Math.max(highWaterMark, n);
            commitChange(ctx);
            return { content: [{ type: "text", text: `Updated task #${task.id} deleted` }], details: { success: true, taskId: task.id, updatedFields: ["deleted"], statusChange } };
          }
          statusChange = { from: task.status, to: params.status };
          task.status = params.status;
          updatedFields.push("status");
        }
        // Dependency edges (picc-tasks v0.2.0 semantics): append-only with
        // dedupe, target validation, and mirror inverse maintenance. Unknown
        // targets are skipped, never added as dangling references.
        if (Array.isArray(params.addBlocks) && params.addBlocks.length > 0) {
          const validTargets = new Set(tasks.map((t) => t.id));
          const before = task.blocks.length;
          for (const targetId of params.addBlocks) {
            if (!validTargets.has(targetId)) continue;
            if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
            const target = tasks.find((t) => t.id === targetId);
            if (target && !target.blockedBy.includes(task.id)) target.blockedBy.push(task.id);
          }
          if (task.blocks.length > before) updatedFields.push("blocks");
        }
        if (Array.isArray(params.addBlockedBy) && params.addBlockedBy.length > 0) {
          const validTargets = new Set(tasks.map((t) => t.id));
          const before = task.blockedBy.length;
          for (const upstreamId of params.addBlockedBy) {
            if (!validTargets.has(upstreamId)) continue;
            if (!task.blockedBy.includes(upstreamId)) task.blockedBy.push(upstreamId);
            const upstream = tasks.find((t) => t.id === upstreamId);
            if (upstream && !upstream.blocks.includes(task.id)) upstream.blocks.push(task.id);
          }
          if (task.blockedBy.length > before) updatedFields.push("blockedBy");
        }
        commitChange(ctx);
        const details: Record<string, unknown> = { success: true, taskId: task.id, updatedFields };
        if (statusChange) details.statusChange = statusChange;
        return { content: [{ type: "text", text: `Updated task #${task.id} ${updatedFields.join(", ")}` }], details };
      },
    });

    // --- TaskPromote (owner-initiated; preview token + native confirmation + trusted writer) ---
    pi.registerTool({
      name: "TaskPromote",
      label: "TaskPromote",
      description:
        "Promote session tasks to the durable TASKS.md board through the trusted board writer. OWNER-INITIATED ONLY, two mandatory steps: (1) mode 'preview' returns a previewToken bound to the exact task IDs, contents, target TASKS.md, card fields, session identity, and authority input; (2) mode 'commit' must present that exact token AND the host presents one native confirmation dialog to the owner before any write. A model-supplied quotedInstruction is never owner proof. Workers cannot promote. Surviving tasks default to the backlog lane; lane overrides are owner-explicit. definitionOfDone, stoppingPoint, and scopePaths are owner-supplied, never invented.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", enum: ["preview", "commit"], description: "preview (mandatory first) or commit (requires the matching previewToken plus owner confirmation)." },
          taskIds: { type: "array", items: { type: "string" }, description: "Session task IDs to promote. Omit for a batch of all non-completed, non-promoted tasks." },
          previewToken: { type: "string", description: "commit only: the exact previewToken returned by the immediately preceding preview for this same state." },
          definitionOfDone: { type: "string", description: "commit only: the card's definition of done (owner-supplied)." },
          stoppingPoint: { type: "string", description: "commit only: the card's stopping point (owner-supplied)." },
          scopePaths: { type: "array", items: { type: "string" }, description: "commit only: repository-relative scope paths (owner-supplied)." },
          laneOverrides: { type: "object", description: "Optional per-task lane override (backlog | in-progress), keyed by task id. Owner-explicit only; the default is backlog for every surviving task.", additionalProperties: { type: "string", enum: ["backlog", "in-progress"] }, properties: {} },
          completedPolicy: { type: "string", enum: ["skip", "promote-as-done"], description: "Default skip (v1)." },
          authority: {
            type: "object",
            description: "commit only, REQUIRED: { source: 'instruction', sessionOrReportId, quotedInstruction }. The quotedInstruction must match the owner-confirmed instruction from the native confirmation step; a model-invented quote is not owner proof and is rejected.",
            additionalProperties: false,
            properties: {
              source: { type: "string", enum: ["instruction"] },
              sessionOrReportId: { type: "string" },
              quotedInstruction: { type: "string" },
            },
            required: ["source", "sessionOrReportId", "quotedInstruction"],
          },
        },
        required: ["mode"],
      },
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const boardPath = resolveBoardPath(cwd);
        const resolvedListId = taskListId ?? core.resolveTaskListId({ session: ctx?.sessionManager?.getSessionId?.() ?? null });
        if (!resolvedListId) return failResult("task-list-unavailable", "no taskListId could be resolved (PI_TASK_LIST_ID, then CLAUDE_CODE_TASK_LIST_ID, then the session id)");

        // Origin observation: audit metadata only. A proven worker pane is
        // refused outright; unproven identity still requires the full owner
        // confirmation boundary (the confirmation is the gate, not origin).
        const origin = core.resolveCallerOrigin();
        if (!core.canPromote(origin)) {
          return failResult("worker-promotion-refused", "a worker session cannot promote; promotion requires the owner in an owner session");
        }

        // Capability gate (enforced, not informational): commit requires the
        // session to declare the tasks capability marker. Session tools stay
        // available without it; the authority-bearing surface does not.
        if (input?.mode === "commit" && !core.hasTasksCapability({})) {
          return failResult("capability-required", `commit requires the session capability marker ${core.TASKS_CAPABILITY_ENV}; package presence is not the loading contract`);
        }

        // Select tasks: explicit IDs or the non-promoted, non-completed batch.
        let selected;
        if (Array.isArray(input?.taskIds) && input.taskIds.length > 0) {
          selected = input.taskIds.map((id) => findTask(id)).filter((t) => t !== undefined);
          const missing = input.taskIds.filter((id) => findTask(id) === undefined);
          if (missing.length > 0) return failResult("task-not-found", `task(s) not found: ${missing.join(", ")}`);
        } else {
          selected = tasks.filter((t) => t.status !== "completed" && !t.metadata?.promotedCardId);
        }

        const boardMarkdown = boardPath && existsSync(boardPath) ? readFileSync(boardPath, "utf8") : "";
        const metadataByTaskId = Object.fromEntries(tasks.map((t) => [t.id, t.metadata ?? {}]));

        // Retry reconciliation FIRST (before any preview): a task whose
        // forward link already exists on the board is recovered as an
        // idempotent success — the card ID comes from the board's importedId
        // (authoritative), and a missing reverse link is repaired below.
        const recovered = [];
        const stillToPromote = [];
        for (const task of selected) {
          const key = core.promotionIdempotencyKey(resolvedListId, task.id);
          const existingCard = boardMarkdown !== "" ? core.findExistingPromotedCard(boardMarkdown, key) : null;
          if (existingCard) {
            recovered.push({ taskId: task.id, cardId: existingCard.cardId, recovered: true, importedIdAuthoritative: true });
          } else {
            stillToPromote.push(task);
          }
        }

        const batch = core.buildBatchPromotionPreview({
          tasks: stillToPromote,
          taskListId: resolvedListId,
          boardPath,
          sessionOrReportId: input?.authority?.sessionOrReportId ?? resolvedListId,
          laneOverrides: input?.laneOverrides ?? {},
          completedPolicy: input?.completedPolicy ?? "skip",
          existingKeys: () => null, // already handled by the recovery pass above
          metadataByTaskId,
        });

        if (input?.mode === "preview" || input?.mode === undefined) {
          const target = { repositoryRoot: cwd, canonicalTasksMdPath: boardPath };
          const token = core.previewToken({
            previews: batch.previews,
            skipped: batch.skipped,
            recovered,
            target,
            sessionOrReportId: input?.authority?.sessionOrReportId ?? resolvedListId,
            authorityInput: input?.authority ?? null,
          });
          return textResult({
            ok: true,
            mode: "preview",
            previewOnly: true,
            previewToken: token,
            target,
            previews: batch.previews,
            skipped: batch.skipped,
            recovered,
            note: "Preview only — nothing was written. Commit requires this exact previewToken, the owner-supplied fields, and one native owner confirmation presented by the host.",
          });
        }

        // --- commit path ---
        if (input?.mode === "commit") {
          // 1. Authority record shape: the record itself must be a genuine
          //    instruction with a verbatim quotedInstruction (a digest alone
          //    is not accepted). Validated independently of the preview list
          //    so a recovery-only commit (nothing left to write) is still
          //    authority-gated. The writer enforces this again per call.
          if (!input?.authority || !core.isValidAuthoritySource(input.authority)
            || typeof input.authority.quotedInstruction !== "string"
            || input.authority.quotedInstruction.trim() === "") {
            return failResult("authority-required", "commit requires a genuine owner authority record: { source: 'instruction', sessionOrReportId, quotedInstruction }; a digest alone is not accepted");
          }
          // 2. Matching prior preview is MANDATORY. The token binds task IDs,
          //    task contents, the target repo/TASKS.md, all card fields,
          //    session identity, and the authority input. Commit never
          //    constructs a fresh preview in place of the caller's; it
          //    recomputes the digest of the state the caller's preview saw
          //    and refuses any mismatch (stale, drifted, or missing token).
          if (typeof input?.previewToken !== "string" || input.previewToken === "") {
            return failResult("preview-token-required", "commit requires the previewToken from the immediately preceding preview; run mode 'preview' first");
          }
          const expectedToken = core.previewToken({
            previews: batch.previews,
            skipped: batch.skipped,
            recovered,
            target: { repositoryRoot: cwd, canonicalTasksMdPath: boardPath },
            sessionOrReportId: input?.authority?.sessionOrReportId ?? resolvedListId,
            authorityInput: input?.authority ?? null,
          });
          if (input.previewToken !== expectedToken) {
            return failResult("preview-token-mismatch", "the previewToken does not match the current promotion state; the tasks, target, card fields, or authority input changed since the preview — run a fresh preview");
          }
          // 3. Owner confirmation boundary: a model-supplied
          //    quotedInstruction is NOT owner proof. The host presents one
          //    native confirmation dialog showing the exact preview state;
          //    the confirmed instruction text is what the writer records.
          //    Headless contexts fail closed.
          if (!isNativeTuiContext(ctx) || typeof ctx?.ui?.confirm !== "function") {
            return failResult("native-confirmation-required", "commit requires the interactive native TUI so the owner can confirm the exact promotion (fails closed)");
          }
          let confirmed;
          try {
            const previewLines = batch.previews.map((p) => `- task #${p.taskId}: "${p.cardInput.title}" → ${p.cardInput.lane} @ ${p.target.canonicalTasksMdPath}`);
            confirmed = await ctx.ui.confirm(
              "Promote session tasks to TASKS.md",
              [
                `Board: ${boardPath}`,
                previewLines.length ? previewLines.join("\n") : "(nothing left to promote)",
                `Authority to record: "${input.authority.quotedInstruction.slice(0, 200)}"`,
                "One confirmation for this exact preview; changed state requires a fresh preview.",
              ].join("\n"),
            );
          } catch (error) {
            return failResult("confirmation-failed", String(error?.message || error).slice(0, 256));
          }
          if (confirmed !== true) {
            return textResult({ ok: false, mode: "commit", cancelled: true, code: "owner-cancelled", reason: "the owner did not confirm this promotion", errors: ["the owner did not confirm this promotion"], persisted: false });
          }
          if (batch.previews.length === 0 && recovered.length === 0) {
            return textResult({ ok: true, mode: "commit", promoted: [], recovered, skipped: batch.skipped, note: "nothing to promote" });
          }
          const missingOwner = batch.previews.filter((p) =>
            !input.definitionOfDone || !input.stoppingPoint || !Array.isArray(input.scopePaths) || input.scopePaths.length === 0);
          if (missingOwner.length > 0) {
            return failResult("owner-fields-required", "commit requires owner-supplied definitionOfDone, stoppingPoint, and scopePaths; they are never invented from task text");
          }
          // 4. One trusted-writer call per task, in preview order. NOT
          //    atomic: partial success is reported and reconciled via the
          //    idempotency key.
          const writerResults = [];
          for (const preview of batch.previews) {
            const result = board.writeCard({
              boardPath,
              input: {
                title: preview.cardInput.title,
                description: preview.cardInput.description,
                spec: preview.cardInput.specification,
                definitionOfDone: input.definitionOfDone,
                stoppingPoint: input.stoppingPoint,
                scope: input.scopePaths,
                lane: preview.cardInput.lane,
                dependencies: [],
                importedId: preview.cardInput.importedId,
                provenance: `session-task ${preview.source.taskListId}/${preview.source.taskId}`,
              },
              authority: input.authority,
              surface: "tasks",
            });
            writerResults.push({
              ok: result.ok,
              taskId: preview.taskId,
              idempotencyKey: preview.idempotencyKey,
              cardId: result.ok ? result.cardId : null,
              code: result.ok ? null : result.code,
              errors: result.ok ? [] : (result.errors ?? []),
            });
          }
          // 5. Dependency edges AFTER writer-minted IDs. Every resolved
          //    blocker for a dependent card is AGGREGATED into one update
          //    with the complete list — blockers are never silently
          //    discarded. Non-batch blockers are dropped and recorded
          //    (never dangling).
          const rec = core.reconcileDependencies({
            previews: batch.previews,
            writerResults,
            sessionTasks: selected,
            // Blockers promoted in an earlier run resolve from the board's
            // authoritative forward link — never silently discarded.
            resolveBlockerCardId: (blockerKey) =>
              core.findExistingPromotedCard(existsSync(boardPath) ? readFileSync(boardPath, "utf8") : "", blockerKey)?.cardId ?? null,
          });
          const cardIdByKey = new Map(writerResults.filter((r) => r.ok).map((r) => [r.idempotencyKey, r.cardId]));
          const edgeUpdates = core.applyDependencyEdges({
            edges: rec.edges.map((edge) => ({
              ...edge,
              dependentCardId: cardIdByKey.get(core.promotionIdempotencyKey(resolvedListId, edge.taskId)) ?? null,
            })),
            authority: input.authority,
            currentDependencies: (cardId) => {
              const markdown = existsSync(boardPath) ? readFileSync(boardPath, "utf8") : "";
              const parsed = board.parseBoard(markdown);
              return parsed.cards.find((c) => c.cardId === cardId)?.dependencies ?? [];
            },
            updateCardFn: ({ cardId, changes, authority }) => board.updateCard({ boardPath, cardId, changes, authority, surface: "tasks" }),
          });
          // 6. Reverse links: set metadata.promotedCardId on promoted tasks.
          //    The forward link (importedId/provenance on the card) is
          //    authoritative; the reverse link is a cache repaired from it.
          const promoted = [];
          for (const result of writerResults) {
            if (!result.ok) continue;
            const task = findTask(result.taskId);
            if (task) {
              task.metadata = { ...(task.metadata ?? {}), promotedCardId: result.cardId };
              promoted.push({ taskId: result.taskId, cardId: result.cardId });
            }
          }
          for (const result of recovered) {
            const task = findTask(result.taskId);
            if (task) task.metadata = { ...(task.metadata ?? {}), promotedCardId: result.cardId };
          }
          commitChange(ctx);
          return textResult({
            ok: promoted.length > 0 || recovered.length > 0 || writerResults.every((r) => r.ok),
            mode: "commit",
            atomic: false,
            target: { repositoryRoot: cwd, canonicalTasksMdPath: boardPath },
            promoted,
            recovered,
            failed: writerResults.filter((r) => !r.ok),
            skipped: batch.skipped,
            dependencyEdges: { applied: edgeUpdates.applied, failed: edgeUpdates.failed, dropped: rec.dropped },
            note: "Batch promotion is a sequence of independent writer calls; re-run the same promotion to reconcile via the idempotency key.",
          });
        }
        return failResult("invalid-input", "mode must be 'preview' or 'commit'");
      },
    });
  }

  // Rich, read-only view for the owner. It intentionally includes internal
  // tasks and presentation fields that the model-facing TaskList omits.
  if (typeof pi?.registerCommand === "function") {
    pi.registerCommand("tasks", {
      description: "Show all tasks (richer view than the LLM-facing TaskList).",
      argumentHint: "",
      handler: async (_args, ctx) => {
        try {
          if (tasks.length === 0) {
            ctx?.ui?.notify?.("No tasks yet. Use TaskCreate to add one.", "info");
            return;
          }
          const blocks = [];
          for (const task of tasks) {
            const internal = task.metadata?._internal === true ? " [internal]" : "";
            blocks.push(`${renderTaskListLine(task)}${internal}`);
            blocks.push(`    ${task.description}`);
            if (task.activeForm) blocks.push(`    active: ${task.activeForm}`);
          }
          ctx?.ui?.notify?.(blocks.join("\n"), "info");
        } catch (error) {
          // Informational only: a stale context after session replacement is
          // not a command failure and must never surface to the user/agent.
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("stale after session replacement")) {
            // Other UI failures are also non-fatal; the command has no state
            // mutation to roll back.
          }
        }
      },
    });
  }

  pi.on?.("session_start", async (_event, ctx) => { syncState(ctx); });
  pi.on?.("session_tree", async (_event, ctx) => { syncState(ctx); });
  pi.on?.("session_shutdown", () => { lastCtx = null; });
  syncState(typeof pi?.ctx !== "undefined" ? pi.ctx : null);

  return {
    registered: ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskPromote"],
    capability: { marker: core.TASKS_CAPABILITY_ENV, skill: core.TASKS_SKILL_CAPABILITY, loaded: core.hasTasksCapability({}) },
  };
}
