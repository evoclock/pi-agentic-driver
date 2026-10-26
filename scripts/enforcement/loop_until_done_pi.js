// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import {
  buildStallNudge,
  createStallDetector,
  DEFAULT_STALL_CONFIG,
  STALL_REASONS,
  validateStallConfig,
} from "./stall_detector_pi.js";

export const LOOP_COMMAND = "loop-until-done";
const CONFIG = new URL("../../.agentic-driver/loop-until-done.defaults.json", import.meta.url);

export function loadLoopConfig(read = (url) => readFileSync(url, "utf8")) {
  let config;
  try { config = JSON.parse(read(CONFIG)); } catch { throw new Error("Invalid loop configuration: expected readable JSON."); }
  if (!config || Array.isArray(config) || typeof config !== "object"
    || !["maxDurationMs,maxSteps,wake", "maxDurationMs,maxSteps,stall,wake"].includes(Object.keys(config).sort().join(","))
    || !Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1
    || !Number.isSafeInteger(config.maxDurationMs) || config.maxDurationMs < 1
    || !config.wake || Array.isArray(config.wake) || typeof config.wake !== "object"
    || !["interval", "until-done"].includes(config.wake.mode)
    || (config.wake.mode === "interval"
      ? Object.keys(config.wake).sort().join(",") !== "mode,periodMs"
        || !Number.isSafeInteger(config.wake.periodMs) || config.wake.periodMs < 1 || config.wake.periodMs > 2147483647
      : Object.keys(config.wake).join(",") !== "mode")) {
    throw new Error("Invalid loop configuration: positive safe integer limits and a valid wake mode are required.");
  }
  const stallConfig = Object.prototype.hasOwnProperty.call(config, "stall") ? config.stall : DEFAULT_STALL_CONFIG;
  const stall = validateStallConfig(stallConfig);
  if (!stall.ok) throw new Error(`Invalid loop configuration: ${stall.errors.join("; ")}`);
  return { ...config, stall: stall.config };
}
const ENTRY_TYPE = "loop-until-done-budget.v1";
const GUIDE = new URL("./loop_until_done_guide.md", import.meta.url);
const WORKER_ROUTES = new Set([
  "agentic_worker_dispatch_async",
  "agentic_herdr_communication",
  "agentic_herdr_spawn_worker",
  "agentic_kanban_board_dispatch",
  "agentic_kanban_pulse",
]);
const REGISTERED = new WeakSet();

export function parseLoopRequest(args, config = loadLoopConfig()) {
  const text = typeof args === "string" ? args.trim() : "";
  const separator = text.indexOf("::");
  const prefix = separator < 0 ? "" : text.slice(0, separator).trim();
  const exit = separator < 0 ? "" : text.slice(separator + 2).trim();
  const match = /^(\d+)\s+(.+)$/s.exec(prefix);
  const steps = match ? Number(match[1]) : NaN;
  const goal = match?.[2]?.trim() ?? "";
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > config.maxSteps || !goal || !exit
    || goal.length > 2000 || exit.length > 1000) {
    throw new Error(`Use /${LOOP_COMMAND} <1-${config.maxSteps} steps> <approved goal> :: <observable exit check>`);
  }
  return { steps, goal, exit };
}

// One admitted dispatch attempt consumes one step, even if the worker fails or
// native confirmation is refused. Consuming before execution prevents parallel
// tool calls and retries from overspending the session's allowance.
export function createLoopBudget(record, now = () => Date.now(), config = loadLoopConfig()) {
  if (typeof record !== "function" || typeof now !== "function") throw new Error("A Pi session entry writer and clock are required for a durable loop budget.");
  let active = null;
  let used = false;
  return {
    restore(entries) {
      // Count the entire append-only session, not just the current branch: tree
      // navigation must not restore spent steps or reopen a finished run.
      const records = entries.filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE)
        .map((entry) => entry.data);
      const starts = records.filter((data) => data?.event === "start");
      const chases = records.filter((data) => data?.event === "chase");
      used = starts.length > 0;
      const steps = starts[0]?.steps;
      const startedAt = starts[0]?.startedAt;
      const recordedStall = starts[0]?.stall ?? DEFAULT_STALL_CONFIG;
      const valid = starts.length === 1 && starts[0]?.maxSteps === config.maxSteps && starts[0]?.maxDurationMs === config.maxDurationMs
        && JSON.stringify(starts[0]?.wake) === JSON.stringify(config.wake)
        && JSON.stringify(recordedStall) === JSON.stringify(config.stall)
        && Number.isSafeInteger(steps) && steps >= 1 && steps <= config.maxSteps
        && Number.isSafeInteger(startedAt) && startedAt >= 0
        && chases.length <= 1 && chases.every((data) => STALL_REASONS.includes(data.reason))
        && records.every((data) => ["start", "attempt", "expire", "stop", "chase"].includes(data?.event));
      if (!used) active = records.length ? { steps: 0, remaining: 0, chased: true } : null;
      else if (!valid) active = { steps: 0, remaining: 0, chased: true };
      else if (records.some((data) => data.event === "stop")) active = null;
      else {
        const recordedExpiry = records.some((data) => data.event === "expire");
        const sameRun = active?.startedAt === startedAt;
        active = { steps, startedAt, expired: recordedExpiry || (sameRun && active.expired),
          expiryRecorded: recordedExpiry || (sameRun && active.expiryRecorded),
          remaining: Math.max(0, steps - records.filter((data) => data.event === "attempt").length),
          chased: chases.length === 1 };
      }
    },
    start(request) {
      if (used || active) throw new Error("A loop has already started in this session; it cannot be restarted or reset.");
      const startedAt = now();
      if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("A valid clock is required to open a bounded loop.");
      record({ event: "start", steps: request.steps, startedAt, maxSteps: config.maxSteps, maxDurationMs: config.maxDurationMs,
        wake: config.wake, stall: config.stall });
      used = true;
      active = { ...request, startedAt, remaining: request.steps, chased: false };
    },
    claimChase(reason) {
      if (!active || active.chased || !Number.isSafeInteger(active.steps) || active.steps < 1 || !STALL_REASONS.includes(reason)) {
        return false;
      }
      record({ event: "chase", reason });
      active.chased = true;
      return true;
    },
    stop() {
      if (!active) return;
      record({ event: "stop" });
      active = null;
    },
    snapshot() { return active && { ...active }; },
    hasStarted() { return used; },
    hasChased() { return active?.chased === true; },
    guard(event) {
      if (!active) return undefined;
      const tool = event?.toolName;
      const input = event?.input ?? {};
      if (tool === "agentic_worker_dispatch") {
        if (input.action === "pulse") return undefined;
        if (input.action !== "dispatch" || input.maxSteps !== 1
          || input.mode !== "turn-by-turn" || input.autonomy !== "confirmed-default"
          || !["developer", "reviewer"].includes(input.role)
          || input.model !== undefined || input.cast !== undefined) {
          return { block: true, reason: "Loop dispatch requires one confirmed step for an authorized developer or reviewer, without a model override." };
        }
        const current = now();
        if (active.expired || !Number.isSafeInteger(current) || current < active.startedAt
          || current - active.startedAt >= config.maxDurationMs) {
          active.expired = true;
          // Persist expiry before refusing so extension reload or clock rollback
          // cannot reopen the run. A failed write throws and blocks this call;
          // the next call retries persistence before it can return a refusal.
          if (!active.expiryRecorded) {
            record({ event: "expire" });
            active.expiryRecorded = true;
          }
          return { block: true, reason: "Loop time limit reached; no further worker dispatch is permitted in this session run." };
        }
        if (active.remaining === 0) {
          return { block: true, reason: "Loop step limit reached; no further worker dispatch is permitted in this session run." };
        }
        // If persistence fails, Pi blocks the tool_call. Never admit an
        // exchange whose attempt was not recorded first.
        record({ event: "attempt" });
        active.remaining -= 1;
        return undefined;
      }
      if (WORKER_ROUTES.has(tool)) {
        const readOnly = (tool === "agentic_worker_dispatch_async" && ["poll", "observe", "read"].includes(input.action))
          || (tool === "agentic_herdr_communication" && ["list", "get", "delivery", "wait", "read"].includes(input.action))
          || (tool === "agentic_kanban_pulse" && input.action === "check");
        if (!readOnly) return { block: true, reason: "This worker route bypasses the active loop's step counter." };
      }
      return undefined;
    },
  };
}

export function registerLoopUntilDone(pi, now = () => Date.now(), config = loadLoopConfig()) {
  if (REGISTERED.has(pi)) return undefined;
  if (typeof pi?.registerCommand !== "function" || typeof pi?.on !== "function" || typeof pi?.appendEntry !== "function") {
    throw new Error("Pi session entry, command and tool-call APIs are required for /loop-until-done.");
  }
  // Validate injected configuration as well as the on-disk default before registration.
  config = loadLoopConfig(() => JSON.stringify(config));
  REGISTERED.add(pi);
  const budget = createLoopBudget((data) => pi.appendEntry(ENTRY_TYPE, data), now, config);
  const detector = createStallDetector(config.stall, now);
  let pendingWake = null;
  let pendingIdleWatch = null;
  let currentContext = null;
  let admitted = false;
  let successful = false;
  const cancelWake = () => { if (pendingWake !== null) clearTimeout(pendingWake); pendingWake = null; };
  const cancelIdleWatch = () => { if (pendingIdleWatch !== null) clearTimeout(pendingIdleWatch); pendingIdleWatch = null; };
  const resetStallWatch = () => { cancelIdleWatch(); detector.reset(); };
  const reportChaseFailure = (ctx) => {
    try { ctx?.ui?.notify?.("Stall recovery failed and will not retry.", "warning"); } catch { /* A stale or unavailable UI must not trigger another chase. */ }
  };
  const chase = (reason, deliverAs = null, ctx = currentContext) => {
    const state = budget.snapshot();
    const current = now();
    if (!state || state.chased || state.expired || !Number.isSafeInteger(current) || current < state.startedAt
      || current - state.startedAt >= config.maxDurationMs) return false;
    let claimed = false;
    try {
      claimed = budget.claimChase(reason);
    } catch {
      resetStallWatch();
      admitted = false;
      successful = false;
      reportChaseFailure(ctx);
      return false;
    }
    if (!claimed) return false;
    resetStallWatch();
    admitted = false;
    successful = false;
    try {
      const message = buildStallNudge(reason);
      if (deliverAs) pi.sendUserMessage(message, { deliverAs });
      else pi.sendUserMessage(message);
    } catch {
      reportChaseFailure(ctx);
    }
    return true;
  };
  const scheduleIdleWatch = () => {
    const state = budget.snapshot();
    if (!config.stall.enabled || !state || state.chased || state.expired || !detector.isRunning()) {
      cancelIdleWatch();
      return;
    }
    cancelIdleWatch();
    pendingIdleWatch = setTimeout(() => {
      pendingIdleWatch = null;
      const reason = detector.checkIdle();
      if (reason !== null) chase(reason, "steer", currentContext);
      else scheduleIdleWatch();
    }, config.stall.idleTimeoutMs);
  };
  const observeProgress = (ctx) => {
    currentContext = ctx ?? currentContext;
    if (!budget.snapshot() || budget.hasChased()) return;
    detector.observeProgress();
    scheduleIdleWatch();
  };
  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    const state = budget.snapshot();
    if (!config.stall.enabled || !state || state.chased || state.expired) {
      resetStallWatch();
      return;
    }
    detector.beginRun();
    scheduleIdleWatch();
  });
  for (const event of ["agent_end", "turn_start", "message_start", "message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    pi.on(event, (_event, ctx) => observeProgress(ctx));
  }
  pi.on("turn_end", (event, ctx) => {
    currentContext = ctx ?? currentContext;
    if (!budget.snapshot() || budget.hasChased()) return;
    detector.observeAssistantMessage(event?.message);
    scheduleIdleWatch();
  });
  pi.on("tool_call", (event, ctx) => {
    currentContext = ctx ?? currentContext;
    const result = budget.guard(event);
    if (event?.toolName === "agentic_worker_dispatch" && event?.input?.action === "dispatch" && !result && budget.snapshot()) admitted = true;
    if (result === undefined && budget.snapshot() && !budget.hasChased()) {
      const reason = detector.observeToolCall(event);
      if (reason === "repeated-tool-loop") chase(reason, "steer", ctx);
      else scheduleIdleWatch();
    }
    return result;
  });
  pi.on("tool_result", (event, ctx) => {
    currentContext = ctx ?? currentContext;
    if (budget.snapshot() && !budget.hasChased()) observeProgress(ctx);
    if (admitted && event?.toolName === "agentic_worker_dispatch" && !event?.isError) successful = true;
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx ?? currentContext;
    cancelIdleWatch();
    const reason = detector.endRun();
    if (reason !== null && chase(reason, null, ctx)) return;
    if (!admitted) return;
    admitted = false;
    if (!successful) { successful = false; return; }
    successful = false;
    const state = budget.snapshot();
    if (!state || state.remaining < 1 || state.expired || pendingWake !== null) return;
    const delay = config.wake.mode === "interval" ? config.wake.periodMs : 0;
    pendingWake = setTimeout(() => {
      pendingWake = null;
      const current = budget.snapshot();
      if (!current || current.remaining < 1 || current.expired) return;
      if (now() < current.startedAt || now() - current.startedAt >= config.maxDurationMs) return;
      pi.sendUserMessage(`Continue the approved loop goal. Verify the exit check first; stop if passed, blocked, or failed. Remaining dispatch attempts: ${current.remaining}.`);
    }, delay);
  });
  for (const event of ["session_start", "session_tree"]) {
    pi.on(event, (_event, ctx) => {
      cancelWake();
      resetStallWatch();
      currentContext = ctx;
      admitted = false;
      successful = false;
      budget.restore(ctx.sessionManager.getEntries());
    });
  }
  pi.on("session_shutdown", () => {
    cancelWake();
    resetStallWatch();
    currentContext = null;
    admitted = false;
    successful = false;
    budget.restore([]);
  });
  pi.registerCommand(LOOP_COMMAND, {
    description: `Work toward a checkable goal with up to ${config.maxSteps} dispatch attempts and a ${config.maxDurationMs} ms time ceiling`,
    argumentHint: `<1-${config.maxSteps} steps> <approved goal> :: <observable exit check> | stop`,
    handler: async (args, ctx) => {
      if (args?.trim() === "stop") {
        cancelWake();
        resetStallWatch();
        admitted = false;
        successful = false;
        budget.stop();
        ctx?.ui?.notify?.("Loop stopped. No remaining step allowance.", "info");
        return;
      }
      // A session gets one allowance, even after stop, settle or branch navigation.
      if (budget.hasStarted()) throw new Error("A loop has already started in this session; it cannot be restarted or reset.");
      const request = parseLoopRequest(args, config);
      if (typeof pi.sendUserMessage !== "function") throw new Error("Pi cannot send the loop request; no budget was opened.");
      const guide = readFileSync(GUIDE, "utf8").replace("$ARGUMENTS", () => JSON.stringify(request));
      budget.start(request);
      try {
        pi.sendUserMessage(`${guide}\n\nEnforced worker-dispatch allowance: ${request.steps} attempts and a ${config.maxDurationMs} ms time ceiling. A refusal or failure consumes an attempt. To close the run, use /${LOOP_COMMAND} stop; it cannot restart in this session. No tool or model can increase this allowance.`);
      } catch (error) {
        cancelWake();
        resetStallWatch();
        budget.stop();
        throw error;
      }
    },
  });
  return budget;
}

export default registerLoopUntilDone;
