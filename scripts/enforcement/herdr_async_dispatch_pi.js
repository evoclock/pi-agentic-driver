// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Async continuous worker dispatch and pulse. One bounded step on top of the
// shipped herdr-communication interface: a worker progresses through an
// existing task sequence (observed, never created) and emits one collated
// marked report. Continuous mode is the default; interactive turn-by-turn is
// explicit opt-in. Journeys are bounded by step count, never by a wall-clock
// timeout; cancellation and terminal failure are explicit and there are no
// invisible retries or resends.

import {
  executeHerdrCommunication,
  HERDR_REPORT_MARKERS,
  HERDR_COMMUNICATION_SCHEMA,
  HERDR_COMMUNICATION_ACTIONS,
} from "./herdr_communication_pi.js";
import { isNativeTuiContext } from "./native_tui_context.js";

export const WORKER_DISPATCH_TOOL = "agentic_worker_dispatch";
export const WORKER_DISPATCH_SCHEMA = "agentic-driver.worker-dispatch.v1";
export const WORKER_DISPATCH_MODES = Object.freeze(["continuous", "turn-by-turn"]);
export const DEFAULT_MODE = "continuous";
const DEFAULT_JOURNEY_STEPS = 50;
const MAX_JOURNEY_STEPS = 200;
const MAX_REPORT_BYTES = 32 * 1024;
const REGISTRATIONS = new WeakSet();

// Terminal journey states. Only `cancelled` and `failed` are failures; every
// other terminal state is an observed outcome, and no state is retried.
export const WORKER_DISPATCH_TERMINAL_STATES = Object.freeze([
  "completed", "exhausted", "role-blocked", "cancelled", "failed", "waiting-approval", "worker-hung",
]);

export const WORKER_DISPATCH_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["dispatch", "pulse"] },
    role: { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 64 },
    mode: { type: "string", enum: WORKER_DISPATCH_MODES },
    maxSteps: { type: "integer", minimum: 1, maximum: MAX_JOURNEY_STEPS },
    stepPrompt: { type: "string", minLength: 1, maxLength: 8192 },
    model: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}(?:\\/[a-z0-9][a-z0-9._-]{0,127})*$", maxLength: 192 },
  },
  required: ["action", "role"],
  allOf: [
    {
      if: { properties: { action: { const: "dispatch" } }, required: ["action"] },
      then: { required: ["stepPrompt"] },
    },
  ],
});

class WorkerDispatchError extends Error {
  constructor(code, message, status = "blocked") {
    super(message);
    this.name = "WorkerDispatchError";
    this.code = code;
    this.status = status;
  }
}

function dispatchError(code, message, status = "blocked") {
  return new WorkerDispatchError(code, message, status);
}

function result(details) {
  return { ok: details.ok === true, ...details };
}

function failure(action, error) {
  const code = error?.code || "dispatch-failed";
  return {
    schema: WORKER_DISPATCH_SCHEMA,
    ok: false,
    action,
    status: error?.status || "blocked",
    code,
    error: String(error?.message || error).slice(0, 512),
    nonAuthorizing: true,
    persisted: false,
  };
}

// Worker pulse: liveness, current state, and dispatch eligibility, observed
// through the existing non-authorizing get seam. Grants no authority.
export async function workerPulse(role, context, options = {}, signal) {
  if (typeof role !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(role) || role.length > 64) {
    throw dispatchError("role-invalid", "worker pulse requires a valid non-coordinator role name", "denied");
  }
  const observation = await executeHerdrCommunication(
    { action: "get", role },
    context,
    options.communication ?? options,
    signal,
  );
  if (observation.ok !== true) {
    throw dispatchError(observation.code || "pulse-failed",
      observation.reason || observation.error || "worker pulse could not observe the role",
      observation.status || "blocked");
  }
  const agent = observation.observation ?? {};
  const status = typeof agent.status === "string" ? agent.status : "unknown";
  return {
    role,
    alive: status !== "unknown" && status !== "gone",
    status,
    dispatchEligible: status === "idle",
    observed: true,
  };
}

// Queue progression observes the next dispatchable item without creating
// duplicate task cards. The injected task store is read-only here; marking a
// dispatched task done is the worker's job through its own task tools.
export function nextDispatchableTask(taskStore) {
  if (!taskStore || typeof taskStore.list !== "function") {
    throw dispatchError("task-store-invalid", "a read-only task store is required to observe the queue", "denied");
  }
  const tasks = taskStore.list();
  if (!Array.isArray(tasks)) throw dispatchError("task-store-invalid", "the task store did not return a task list", "denied");
  return tasks.find((task) => task
    && task.status === "pending"
    && !(Array.isArray(task.blockedBy) && task.blockedBy.length > 0)
    && !task.owner) ?? null;
}

// Tasks already dispatched during this journey are excluded from re-selection
// without mutating the store: the journey keeps its own dispatched set.
function selectNextTask(taskStore, dispatched) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const task = nextDispatchableTask(taskStore);
    if (!task) return null;
    if (!dispatched.has(task.id)) return task;
    // The observed head is already dispatched on this journey; ask the store
    // to advance by observing its next state. If the store never changes, the
    // loop exits via the attempt bound and the journey ends as exhausted.
    if (typeof taskStore.observeAdvance === "function") taskStore.observeAdvance(task.id);
    else return null;
  }
  return null;
}

function journeyReceipt(journey) {
  const body = [
    "[WORKER_JOURNEY_REPORT_BEGIN]",
    `mode: ${journey.mode}`,
    `role: ${journey.role}`,
    `steps: ${journey.steps.length}`,
    `status: ${journey.status}`,
    ...(journey.handoff ? [`handoff: attempted=${journey.handoff.attempted} ok=${journey.handoff.ok ?? false} role=${journey.handoff.role ?? journey.role} reason=${journey.handoff.reason ?? "none"}`] : []),
    ...journey.steps.map((step, index) =>
      `step ${index + 1}: task=${step.taskId ?? "none"} status=${step.status} report=${step.report ?? "(none)"}`),
    "[WORKER_JOURNEY_REPORT_END]",
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_REPORT_BYTES) {
    return `${body.slice(0, MAX_REPORT_BYTES)}\n[WORKER_JOURNEY_REPORT_TRUNCATED]`;
  }
  return body;
}

// One continuous journey. Each step: pulse (liveness + eligibility), observe
// the next dispatchable item, one prompt exchange (no retry on any failure),
// read the marked report, collate. Bounded by maxSteps, never wall-clock.
// A worker that is not idle within an observed exchange cycle is hung for
// dispatch purposes and ends the journey explicitly as worker-hung.
export async function runWorkerJourney(params, context, options = {}, signal) {
  const mode = params.mode ?? DEFAULT_MODE;
  const maxSteps = params.maxSteps ?? DEFAULT_JOURNEY_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_JOURNEY_STEPS) {
    return failure("dispatch", dispatchError("max-steps-invalid",
      `maxSteps must be an integer between 1 and ${MAX_JOURNEY_STEPS}`, "denied"));
  }
  const role = params.role;
  const stepPrompt = params.stepPrompt;
  const taskStore = options.taskStore;
  const spawnReplacement = typeof options.spawnReplacement === "function" ? options.spawnReplacement : null;
  const journey = { mode, role, steps: [], status: "failed", code: null, handoff: null };
  const dispatched = new Set();
  const communicationOptions = options.communication ?? options;

  const finish = (status) => ({
    schema: WORKER_DISPATCH_SCHEMA,
    ok: status === "completed" || status === "exhausted" || status === "waiting-approval",
    action: "dispatch",
    mode,
    role,
    status,
    steps: journey.steps,
    stepCount: journey.steps.filter((step) => step.status === "done").length,
    code: journey.code,
    report: journeyReceipt(journey),
    reportMarkers: { open: "[WORKER_JOURNEY_REPORT_BEGIN]", close: "[WORKER_JOURNEY_REPORT_END]" },
    handoff: journey.handoff,
    nonAuthorizing: true,
    persisted: false,
  });

  // Explicit unstuck path: with native confirmation, spin up a replacement
  // worker for the same trusted repository/role through the existing
  // herdr-lifecycle spawn boundary (fixed argv, shell:false) and resume the
  // pending task sequence. Reuses the same task cards; never duplicates them.
  const handoffToReplacement = async (reason, taskId = null) => {
    journey.status = "worker-hung";
    journey.code = "worker-hung";
    journey.steps.push({ step: journey.steps.length + 1, taskId, status: "worker-hung", error: reason });
    if (!spawnReplacement) {
      journey.handoff = { attempted: false, reason: "replacement spawn is not available in this context" };
      return finish("worker-hung");
    }
    if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
      journey.handoff = { attempted: false, reason: "native TUI confirmation unavailable for replacement spawn" };
      return finish("worker-hung");
    }
    let confirmed;
    try {
      confirmed = await context.ui.confirm("Spin up replacement worker", [
        `Worker role ${role} appears hung (${reason}).`,
        "Spin up one replacement worker through the guarded herdr-lifecycle spawn boundary?",
        "The replacement resumes the same pending task sequence; existing task cards are reused, never duplicated.",
      ].join("\n"));
    } catch (error) {
      journey.handoff = { attempted: false, reason: `confirmation failed: ${error.message}` };
      return finish("worker-hung");
    }
    if (confirmed !== true) {
      journey.handoff = { attempted: false, reason: "native confirmation was not granted for the replacement spawn" };
      return finish("worker-hung");
    }
    let spawned;
    try {
      spawned = await spawnReplacement({ role, context, signal });
    } catch (error) {
      journey.handoff = { attempted: true, ok: false, error: String(error?.message || error).slice(0, 256) };
      return finish("worker-hung");
    }
    journey.handoff = {
      attempted: true,
      ok: spawned?.ok === true,
      role: spawned?.role ?? role,
      repository: spawned?.repository,
      nonAuthorizing: true,
    };
    return finish("worker-hung");
  };

  if (!HERDR_COMMUNICATION_ACTIONS.includes) { /* unreachable guard */ }
  if (mode !== "continuous" && mode !== "turn-by-turn") {
    return failure("dispatch", dispatchError("mode-invalid", "dispatch mode must be continuous or turn-by-turn", "denied"));
  }
  if (!taskStore || typeof taskStore.list !== "function") {
    return failure("dispatch", dispatchError("task-store-invalid", "a read-only task store is required", "denied"));
  }
  if (signal?.aborted) return finish("cancelled");

  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex += 1) {
    if (signal?.aborted) { journey.status = "cancelled"; return finish("cancelled"); }

    // Pulse: liveness and dispatch eligibility, no authority.
    let pulse;
    try {
      pulse = await workerPulse(role, context, communicationOptions, signal);
    } catch (error) {
      journey.status = error?.code === "role_blocked" ? "role-blocked" : "failed";
      journey.code = error?.code || "pulse-failed";
      journey.steps.push({ step: stepIndex, taskId: null, status: journey.status, error: String(error?.message || error).slice(0, 256) });
      return finish(journey.status);
    }
    if (!pulse.alive) {
      return handoffToReplacement("worker role is not alive");
    }
    if (!pulse.dispatchEligible) {
      if (pulse.status === "blocked") {
        journey.status = "role-blocked";
        journey.code = "role_blocked";
        journey.steps.push({ step: stepIndex, taskId: null, status: "role-blocked", workerStatus: pulse.status });
        return finish("role-blocked");
      }
      // Not idle within an observed exchange cycle: hung for dispatch.
      return handoffToReplacement(`worker not idle in the observed exchange cycle (status: ${pulse.status})`);
    }

    // Observe the next dispatchable item; never create or mutate cards.
    let task;
    try {
      task = selectNextTask(taskStore, dispatched);
    } catch (error) {
      journey.status = "failed";
      journey.steps.push({ step: stepIndex, taskId: null, status: "failed", error: String(error?.message || error).slice(0, 256) });
      return finish("failed");
    }
    if (!task) {
      journey.status = "exhausted";
      journey.steps.push({ step: stepIndex, taskId: null, status: "exhausted" });
      return finish("exhausted");
    }

    // Interactive opt-in: stop after each step for explicit approval.
    if (mode === "turn-by-turn" && stepIndex > 1) {
      journey.status = "waiting-approval";
      journey.steps.push({ step: stepIndex, taskId: task.id, status: "waiting-approval" });
      return finish("waiting-approval");
    }

    // Consequential dispatch requires native confirmation, once per step.
    if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
      journey.status = "failed";
      journey.steps.push({ step: stepIndex, taskId: task.id, status: "failed", error: "native TUI confirmation unavailable" });
      return finish("failed");
    }
    let confirmed;
    try {
      confirmed = await context.ui.confirm("Dispatch task to worker", [
        `Dispatch one bounded step to role ${role}?`,
        `Task: ${task.id}${task.subject ? ` — ${task.subject}` : ""}`,
        `Mode: ${mode} (step ${stepIndex} of at most ${maxSteps})`,
        "One prompt exchange, no retries; the worker returns one marked report.",
      ].join("\n"));
    } catch (error) {
      journey.status = "failed";
      journey.steps.push({ step: stepIndex, taskId: task.id, status: "failed", error: `confirmation failed: ${error.message}` });
      return finish("failed");
    }
    if (confirmed !== true) {
      journey.status = "cancelled";
      journey.steps.push({ step: stepIndex, taskId: task.id, status: "cancelled", error: "native confirmation was not granted" });
      return finish("cancelled");
    }

    // One prompt exchange. Any failure is terminal for the journey; there is
    // no invisible retry or resend.
    const exchange = await executeHerdrCommunication(
      { action: "prompt", role, prompt: `${stepPrompt}\nTask: ${task.id}${task.subject ? ` — ${task.subject}` : ""}`, timeoutMs: 120000 },
      context,
      communicationOptions,
      signal,
    );
    if (exchange.ok !== true) {
      const hung = exchange.code === "prompt_stalled" || exchange.code === "process_timeout";
      if (hung) {
        return handoffToReplacement(`exchange ended with ${exchange.code}`, task.id);
      }
      journey.status = exchange.code === "role_blocked" ? "role-blocked" : "failed";
      journey.code = exchange.code || "exchange-failed";
      journey.steps.push({ step: stepIndex, taskId: task.id, status: journey.status, error: exchange.reason || exchange.error || exchange.code });
      return finish(journey.status);
    }
    journey.steps.push({
      step: stepIndex,
      taskId: task.id,
      status: "done",
      workerStatus: exchange.agentStatus,
      report: exchange.report,
    });
    dispatched.add(task.id);
  }

  journey.status = "completed";
  return finish("completed");
  // Unreachable in correct use: every step either dispatches one pending
  // task, or the queue observation returns null and the journey ends with
  // "exhausted". A task store that never drains hits maxSteps and lands here;
  // "completed" then reflects the step bound, and callers inspect stepCount.
}

export function registerWorkerDispatchInterface(pi, options = {}) {
  if (typeof pi?.registerTool !== "function" || REGISTRATIONS.has(pi)) return;
  REGISTRATIONS.add(pi);
  pi.registerTool({
    name: WORKER_DISPATCH_TOOL,
    label: "Worker Dispatch And Pulse",
    description: "Observe worker liveness (pulse) or run one bounded continuous worker journey over the existing task sequence. Continuous mode is the default; turn-by-turn is explicit opt-in. Journeys emit one collated marked report, never create task cards, never retry, and are bounded by step count, not wall-clock.",
    promptSnippet: "Use agentic_worker_dispatch to pulse a worker or run one bounded continuous journey over the existing task sequence; it observes dispatchable tasks without creating cards and grants no authority.",
    promptGuidelines: [
      "agentic_worker_dispatch pulse observes liveness, state, and dispatch eligibility without granting authority.",
      "agentic_worker_dispatch dispatch runs at most maxSteps single-exchange steps; any exchange failure ends the journey explicitly with no retry or resend.",
    ],
    parameters: WORKER_DISPATCH_PARAMETERS,
    async execute(_id, params, signal, _update, context) {
      let value;
      if (params?.action === "pulse") {
        try {
          const pulse = await workerPulse(params.role, context, options, signal);
          value = { schema: WORKER_DISPATCH_SCHEMA, ok: true, action: "pulse", ...pulse, nonAuthorizing: true, persisted: false };
        } catch (error) {
          value = failure("pulse", error);
        }
      } else {
        value = await runWorkerJourney(params ?? {}, context, options, signal);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        details: value,
      };
    },
  });
}

export { HERDR_REPORT_MARKERS, HERDR_COMMUNICATION_SCHEMA };
export default registerWorkerDispatchInterface;
