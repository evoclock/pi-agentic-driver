// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { normalizeSkillObservation, observationId, summarizeSkillObservations, SKILL_OBSERVATION_ENTRY } from "../scripts/enforcement/task_skill_observability_pi.js";
import { HERDR_ROLE_PATTERN } from "../scripts/enforcement/herdr_communication_pi.js";

const SKILL_PATH = /^([a-z][a-z0-9-]*-pi)\/SKILL\.md$/;
const OBSERVER = "agentic_task_skill_observation";
const rolePattern = new RegExp(HERDR_ROLE_PATTERN);
const submittedSkill = /^\/skill:([a-z][a-z0-9-]*-pi)(?=\s|$)/;
const fields = { type: "object", additionalProperties: false, properties: {
  kind: { type: "string", enum: ["recipe", "activity", "outcome", "report"] },
  taskId: { type: "string" }, attemptId: { type: "string" }, workerId: { type: "string" },
  parentTaskId: { type: "string" }, dispatchId: { type: "string" },
  recipe: { type: "string" }, source: { type: "string" }, version: { type: "string" },
  requiredSkills: { type: "array", items: { type: "string" } }, requiredSteps: { type: "array", items: { type: "string" } },
  skill: { type: "string" }, activity: { type: "string", enum: ["declared", "step", "skip"] },
  stepId: { type: "string" }, ref: { type: "string" },
  outcome: { type: "string", enum: ["success", "failure", "interrupted", "skipped", "unknown"] },
  reason: { type: "string", enum: ["verified-result", "caller-reported-result", "tool-error", "required-evidence-missing", "worker-interrupted", "explicit-skip", "not-captured", "other-evidenced"] },
}, required: ["kind"] };

export default function taskSkillObservability(pi) {
  const skillRoot = resolve(process.env.PI_POTETO_SKILLS_ROOT ?? resolve(homedir(), "pi-poteto-mode", "skills"));
  const workspace = process.env.HERDR_WORKSPACE_ID;
  const tab = process.env.HERDR_TAB_ID;
  const pane = process.env.HERDR_PANE_ID;
  const paneId = typeof workspace === "string" && /^w[a-zA-Z0-9]+$/.test(workspace)
    && typeof tab === "string" && tab.startsWith(`${workspace}:t`)
    && typeof pane === "string" && pane.startsWith(`${workspace}:p`) && pane.length <= 128 ? pane : null;
  const workerId = observationId(paneId ?? "session");
  let sessionId = null;
  let active = null;
  const calls = new Map();
  const entries = (ctx) => (ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [])
    .filter((entry) => entry.type === "custom" && entry.customType === SKILL_OBSERVATION_ENTRY)
    .map((entry) => entry.data);
  const recorded = new Set();
  const record = (value) => {
    const clean = normalizeSkillObservation({ ...value, eventId: /^[a-f0-9]{64}$/.test(value.eventId) ? value.eventId : observationId(value.eventId) }, { persisted: true });
    if (!clean) return false;
    const key = `${clean.sessionId}/${clean.eventId}`;
    if (recorded.has(key)) return true;
    pi.appendEntry(SKILL_OBSERVATION_ENTRY, clean);
    recorded.add(key);
    return true;
  };
  const attemptFor = (ctx, taskId, persisted = false) => {
    const id = persisted ? taskId : observationId(taskId);
    const rows = entries(ctx).filter((e) => e.sessionId === sessionId && e.taskId === id && e.workerId === workerId);
    const task = rows.filter((e) => e.kind === "task").at(-1);
    if (!task || task.phase === "completed" || task.phase === "deleted") return null;
    const ended = rows.some((e) => e.kind === "outcome" && e.attemptId === task.attemptId);
    return ended ? null : { taskId: id, attemptId: task.attemptId, workerId, phase: task.phase };
  };

  const begin = (ctx, reason) => {
    sessionId = observationId(ctx.sessionManager.getSessionId?.());
    active = null;
    calls.clear();
    recorded.clear();
    for (const row of entries(ctx)) recorded.add(`${row.sessionId}/${row.eventId}`);
    const started = entries(ctx).filter((row) => row.sessionId === sessionId && row.kind === "task" && row.phase === "started");
    for (const row of started) {
      const current = attemptFor(ctx, row.taskId, true);
      if (!current || current.attemptId !== row.attemptId) continue;
      active = { taskId: current.taskId, attemptId: current.attemptId, workerId: current.workerId };
      if (reason !== "new") record({ ...active, kind: "gap", eventId: randomUUID(), sessionId, reason: "resume-boundary" });
    }
  };
  const ensure = (ctx) => {
    if (observationId(ctx.sessionManager.getSessionId?.()) !== sessionId) begin(ctx, "startup");
  };
  pi.on("session_start", (event, ctx) => begin(ctx, event.reason));
  pi.on("input", (event, ctx) => {
    ensure(ctx);
    const skill = typeof event.text === "string" ? event.text.match(submittedSkill)?.[1] : null;
    if (active && skill) record({ ...active, kind: "command", eventId: randomUUID(), sessionId, skill });
  });
  pi.on("tool_call", (event, ctx) => {
    ensure(ctx);
    if (!active || event.toolName === OBSERVER || event.toolName.startsWith("Task")) return;
    calls.set(event.toolCallId, { ...active, toolClass: event.toolName === "read" ? "read" : "work" });
  });
  pi.on("tool_result", (event, ctx) => {
    ensure(ctx);
    if (event.toolName === "TaskCreate" && !event.isError && event.details?.task?.id) {
      record({ kind: "task", phase: "created", eventId: `task:${event.toolCallId}`, taskId: observationId(event.details.task.id),
        attemptId: observationId(event.toolCallId), workerId, ...(paneId ? { paneId: workerId } : {}), sessionId });
    }
    if (event.toolName === "TaskUpdate" && !event.isError && event.details?.success === true
      && event.details.taskId === event.input?.taskId) {
      const status = event.details.statusChange?.to;
      if (status === event.input.status && ["completed", "deleted"].includes(status)) {
        const previous = attemptFor(ctx, event.input.taskId);
        if (previous) {
          record({ ...previous, kind: "task", phase: status, eventId: `end:${event.toolCallId}`, sessionId });
          if (active?.taskId === previous.taskId && active.attemptId === previous.attemptId) active = null;
          for (const [id, call] of calls) {
            if (call.taskId === previous.taskId && call.attemptId === previous.attemptId) calls.delete(id);
          }
        }
      } else if (event.input.status === "in_progress") {
        const previous = attemptFor(ctx, event.input.taskId);
        const transition = status === "in_progress";
        const startId = `${sessionId}/${observationId(`start:${event.toolCallId}`)}`;
        if (!recorded.has(startId) && (previous || transition)) {
          active = { taskId: observationId(event.input.taskId), attemptId: previous?.attemptId ?? observationId(event.toolCallId), workerId };
          if (transition) record({ ...active, kind: "task", phase: "started", eventId: `start:${event.toolCallId}`, ...(paneId ? { paneId: workerId } : {}), sessionId });
        }
      }
    }
    if (event.toolName === "agentic_herdr_spawn_worker" && !event.isError) {
      const result = event.details;
      if (result?.ok === true && result.status === "spawned" && typeof result.paneId === "string"
        && result.paneId.length <= 128 && typeof result.role === "string" && result.role.length <= 64
        && rolePattern.test(result.role) && result.role !== "coordinator" && !result.role.startsWith("coordinator-")) {
        record({ kind: "spawn", eventId: `spawn:${event.toolCallId}`, sessionId,
          taskId: active?.taskId ?? observationId("coordinator-spawn"),
          attemptId: active?.attemptId ?? observationId("coordinator-spawn"), workerId,
          paneId: observationId(result.paneId), role: result.role });
      }
    }
    const call = calls.get(event.toolCallId);
    calls.delete(event.toolCallId);
    if (!call || observationId(ctx.sessionManager.getSessionId?.()) !== sessionId) return;
    const ref = observationId(event.toolCallId);
    record({ ...call, kind: "tool", eventId: `tool:${event.toolCallId}`, sessionId, ref,
      result: event.isError ? "error" : "ok", toolClass: call.toolClass });
    if (event.isError || call.toolClass !== "read") return;
    const skill = typeof event.input?.path === "string" ? relative(skillRoot, resolve(ctx.cwd ?? process.cwd(), event.input.path)).match(SKILL_PATH)?.[1] : null;
    if (skill) record({ ...call, kind: "read", eventId: `read:${event.toolCallId}`, ref, skill, sessionId });
  });
  pi.registerCommand?.("skill-observation-report", {
    description: "Show local task skill coverage without model inference",
    handler: (_args, ctx) => ctx.ui.notify(JSON.stringify(summarizeSkillObservations(entries(ctx),
      { sessionId: observationId(ctx.sessionManager.getSessionId?.()), persisted: true })), "info"),
  });
  pi.registerTool({
    name: OBSERVER, label: "Task skill observation",
    description: "Declare a recipe or outcome, cite observed task-local tool activity, or report coverage. Reasons are caller-reported unless a failed work tool substantiates tool-error. Legacy verified-result is projected as caller-reported-result; no successful tool proves recipe compliance.",
    parameters: fields,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      ensure(ctx);
      const result = (message, details = { ok: false }) => ({ content: [{ type: "text", text: message }], details });
      if (!sessionId || observationId(ctx.sessionManager.getSessionId?.()) !== sessionId) return result("Observer not captured in this session");
      if (params.kind === "report") {
        const summary = summarizeSkillObservations(entries(ctx), { sessionId, taskId: params.taskId ? observationId(params.taskId) : null, persisted: true });
        return result(JSON.stringify(summary), summary);
      }
      const identity = active && active.taskId === observationId(params.taskId) ? active : null;
      if (!identity && (!params.taskId || !params.attemptId || !params.workerId)) return result("A task, attempt and worker are required without an observed active task");
      if (identity && ((params.attemptId && observationId(params.attemptId) !== identity.attemptId)
        || (params.workerId && observationId(params.workerId) !== identity.workerId))) return result("Active task identity cannot be overridden");
      const observation = normalizeSkillObservation({ ...identity, ...params,
        eventId: observationId(`declaration:${toolCallId}`), sessionId,
        taskId: params.taskId ? observationId(params.taskId) : identity?.taskId,
        attemptId: params.attemptId ? observationId(params.attemptId) : identity?.attemptId,
        workerId: params.workerId ? observationId(params.workerId) : identity?.workerId,
        parentTaskId: params.parentTaskId ? observationId(params.parentTaskId) : undefined,
        dispatchId: params.dispatchId ? observationId(params.dispatchId) : undefined,
        ref: params.ref ? observationId(params.ref) : undefined }, { persisted: true });
      if (!observation) return result("Invalid observation; no event recorded");
      const tool = entries(ctx).find((e) => e.kind === "tool" && e.ref === observation.ref
        && e.sessionId === observation.sessionId && e.taskId === observation.taskId
        && e.attemptId === observation.attemptId && e.workerId === observation.workerId);
      if ((observation.kind === "activity" && observation.activity === "step" && (tool?.result !== "ok" || tool.toolClass !== "work"))
        || (observation.kind === "outcome" && observation.ref && (!tool || tool.toolClass !== "work"))) {
        return result("No matching observed task-local tool reference; no event recorded");
      }
      if (observation.kind === "outcome" && entries(ctx).some((e) => e.kind === "outcome"
        && e.taskId === observation.taskId && e.attemptId === observation.attemptId
        && e.workerId === observation.workerId)) return result("Attempt already has an outcome; a retry needs a distinct attempt");
      if (!record(observation)) return result("Observation could not be stored");
      if (observation.kind === "outcome" && identity) active = null;
      return result("Declaration stored as unverified task evidence", { ok: true, eventId: observation.eventId });
    },
  });
}
