// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { HERDR_ROLE_PATTERN } from "./herdr_communication_pi.js";

export const SKILL_OBSERVATION_ENTRY = "agentic-driver.task-skill-observation.v1";
const DIGEST = /^[a-f0-9]{64}$/;
const ROLE = new RegExp(HERDR_ROLE_PATTERN);
const STEP = /^(?:[1-9]|[1-9][0-9])$/;
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
const RECIPES = new Set(["investigation", "bug-fix", "feature", "refactoring", "prototype", "perf-issue", "hillclimb", "runtime-forensics", "trace-forensics", "visual-parity", "eval", "authoring-a-skill", "autonomous-run", "orchestrate", "opening-a-pr", "shipping", "babysit", "multi-phase-plan", "autopilot-full", "autopilot-stack", "session-pickup", "pause-safely", "worktree-cleanup"]);
const SKILLS = new Set(["architect-pi", "arena-pi", "automate-me-pi", "benchmark-checklist-pi", "blast-radius-pi", "bro-pi", "correct-pi", "create-formal-verification-skill-pi", "create-verification-skill-pi", "figure-it-out-pi", "how-pi", "in-your-own-words-pi", "interrogate-pi", "ketchup-pi", "ketchup-video-pi", "maintain-formal-verification-skill-pi", "maintain-verification-skill-pi", "make-bot-ui-pi", "no-comments-pi", "poteto-help-pi", "poteto-mode-pi", "recall-pi", "reflect-pi", "setup-pstack-pi", "sharpen-pi", "show-me-your-work-pi", "statechart-pi", "swarm-pi", "tdd-pi", "teach-pi", "technical-writing-pi", "typescript-best-practices-pi", "unslop-pi", "why-pi", "principle-attack-the-premise-pi", "principle-boundary-discipline-pi", "principle-build-the-lever-pi", "principle-encode-lessons-in-structure-pi", "principle-exhaust-the-design-space-pi", "principle-experience-first-pi", "principle-explain-the-number-pi", "principle-fix-root-causes-pi", "principle-foundational-thinking-pi", "principle-guard-the-context-window-pi", "principle-laziness-protocol-pi", "principle-make-operations-idempotent-pi", "principle-migrate-callers-then-delete-legacy-apis-pi", "principle-minimize-reader-load-pi", "principle-model-the-domain-pi", "principle-never-block-on-the-human-pi", "principle-outcome-oriented-execution-pi", "principle-prove-it-works-pi", "principle-redesign-from-first-principles-pi", "principle-separate-before-serializing-shared-state-pi", "principle-sequence-verifiable-units-pi", "principle-subtract-before-you-add-pi", "principle-test-behavior-not-implementation-pi", "principle-type-system-discipline-pi"]);
const OUTCOMES = ["success", "failure", "interrupted", "skipped", "unknown"];
const REASONS = ["verified-result", "caller-reported-result", "tool-error", "required-evidence-missing", "worker-interrupted", "explicit-skip", "not-captured", "other-evidenced"];
const KINDS = ["task", "recipe", "read", "activity", "tool", "outcome", "gap", "spawn", "command"];
const CAPTURE_LIMITS = Object.freeze([
  "availability-inventory-not-captured", "playbook-and-reference-reads-not-captured",
  "other-skill-roots-not-captured", "pre-observer-history-not-captured",
  "role-without-matched-spawn-not-captured", "skill-command-expansion-and-use-not-verified",
  "cross-session-input-may-be-incomplete",
]);

// Untrusted identifiers are never retained verbatim. Hashing is for privacy and
// stable correlation, not authentication or proof of source identity.
export function observationId(value) {
  if (typeof value !== "string" || !value || value.length > 256) return null;
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function ids(values, allowed, min = 1) {
  return Array.isArray(values) && values.length >= min && values.length <= 32
    && new Set(values).size === values.length && values.every((value) => allowed(value));
}

// A closed projection of metadata, never an event or tool argument passthrough.
export function normalizeSkillObservation(input, { persisted = false } = {}) {
  if (!input || !KINDS.includes(input.kind)) return null;
  const opaque = (value) => persisted && DIGEST.test(value) ? value : observationId(value);
  const id = Object.fromEntries(["eventId", "sessionId", "taskId", "workerId", "attemptId"]
    .map((field) => [field, opaque(input[field])]));
  if (Object.values(id).some((value) => !value)) return null;
  const out = { kind: input.kind, ...id };
  for (const field of ["parentTaskId", "dispatchId"]) {
    if (input[field] == null) continue;
    const value = opaque(input[field]);
    if (!value) return null;
    out[field] = value;
  }
  if (input.kind === "task") {
    if (!["created", "started", "completed", "deleted"].includes(input.phase)) return null;
    out.phase = input.phase;
    if (input.paneId != null) {
      if (!opaque(input.paneId) || opaque(input.paneId) !== id.workerId) return null;
      out.paneId = id.workerId;
    }
  }
  if (input.kind === "spawn") {
    if (!opaque(input.paneId) || typeof input.role !== "string" || !ROLE.test(input.role)
      || input.role.length > 64 || input.role === "coordinator" || input.role.startsWith("coordinator-")) return null;
    out.paneId = opaque(input.paneId); out.role = input.role;
  }
  if (input.kind === "recipe") {
    if (!RECIPES.has(input.recipe) || input.source !== "pi-poteto-mode" || !VERSION.test(input.version)
      || !ids(input.requiredSkills, (s) => SKILLS.has(s)) || !ids(input.requiredSteps, (s) => STEP.test(s))) return null;
    Object.assign(out, { recipe: input.recipe, source: input.source, version: input.version,
      requiredSkills: [...input.requiredSkills], requiredSteps: [...input.requiredSteps], requirementsProvenance: "caller-declared" });
  }
  if (input.kind === "read" || input.kind === "activity" || input.kind === "command") {
    if (!SKILLS.has(input.skill) || ((input.kind === "read" || input.activity === "step") && !opaque(input.ref))
      || (input.ref != null && !opaque(input.ref))) return null;
    out.skill = input.skill;
    if (input.ref) out.ref = opaque(input.ref);
    if (input.kind === "command") out.commandProvenance = "command-submitted";
    if (input.kind === "activity") {
      if (!["declared", "step", "skip"].includes(input.activity)) return null;
      out.activity = input.activity;
      if (input.activity === "step" || input.activity === "skip") {
        if (!STEP.test(input.stepId) || (input.activity === "skip" && input.reason !== "explicit-skip")) return null;
        out.stepId = input.stepId;
        if (input.activity === "skip") out.reason = "explicit-skip";
      }
    }
  }
  if (input.kind === "tool") {
    if (!opaque(input.ref) || !["ok", "error"].includes(input.result)
      || !["work", "read"].includes(input.toolClass)) return null;
    out.ref = opaque(input.ref); out.result = input.result; out.toolClass = input.toolClass;
  }
  if (input.kind === "outcome") {
    if (!OUTCOMES.includes(input.outcome) || !REASONS.includes(input.reason)
      || (input.ref != null && !opaque(input.ref))) return null;
    out.outcome = input.outcome;
    out.reason = input.reason === "verified-result" ? "caller-reported-result" : input.reason;
    if (input.ref) out.ref = opaque(input.ref);
  }
  if (input.kind === "gap") {
    if (input.reason !== "resume-boundary") return null;
    out.reason = input.reason;
  }
  return out;
}

export function aggregateSkillObservations(events) {
  const unique = new Map();
  for (const raw of events) {
    const event = normalizeSkillObservation(raw, { persisted: true });
    if (event) unique.set(`${event.sessionId}/${event.eventId}`, unique.get(`${event.sessionId}/${event.eventId}`) ?? event);
  }
  const rows = [...unique.values()];
  const report = summarizeSkillObservations(rows, { persisted: true });
  const spawns = new Map();
  for (const row of rows.filter((event) => event.kind === "spawn")) {
    const roles = spawns.get(row.paneId) ?? new Set();
    roles.add(row.role); spawns.set(row.paneId, roles);
  }
  const attempts = report.attempts.map((attempt) => {
    const roles = spawns.get(attempt.workerId);
    return attempt.workerIdentityProvenance === "herdr-pane-observed" && roles?.size === 1
      ? { ...attempt, role: [...roles][0], roleProvenance: "coordinator-spawn-recorded" } : attempt;
  });
  const count = (values) => Object.fromEntries([...new Set(values)].sort().map((value) =>
    [value, values.filter((item) => item === value).length]));
  const skills = rows.filter((row) => row.kind === "read" || row.kind === "command");
  return { schema: SKILL_OBSERVATION_ENTRY, captureLimits: report.captureLimits,
    sessions: new Set(rows.map((row) => row.sessionId)).size, attempts: attempts.length,
    recipes: count(attempts.map((attempt) => attempt.recipe?.name ?? "not-captured")),
    skills: { loads: count(skills.filter((row) => row.kind === "read").map((row) => row.skill)),
      commandSubmissions: count(skills.filter((row) => row.kind === "command").map((row) => row.skill)) },
    roles: count(attempts.map((attempt) => attempt.role ?? "not-captured")),
    outcomes: count(attempts.map((attempt) => attempt.outcome)),
    reasons: count(attempts.map((attempt) => attempt.reason)) };
}

export function summarizeSkillObservations(events, { sessionId, taskId, persisted = false } = {}) {
  const opaque = (value) => persisted && DIGEST.test(value) ? value : observationId(value);
  const session = sessionId ? opaque(sessionId) : null;
  const task = taskId ? opaque(taskId) : null;
  const unique = new Map();
  for (const raw of events) {
    const event = normalizeSkillObservation(raw, { persisted });
    if (!event || (session && event.sessionId !== session) || (task && event.taskId !== task)) continue;
    const key = `${event.sessionId}/${event.eventId}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  const tasks = new Map();
  for (const event of unique.values()) {
    if (event.kind === "spawn") continue;
    const key = `${event.sessionId}/${event.taskId}/${event.workerId}/${event.attemptId}`;
    if (!tasks.has(key)) tasks.set(key, { sessionId: event.sessionId, taskId: event.taskId,
      workerId: event.workerId, attemptId: event.attemptId, parentTaskId: event.parentTaskId ?? null,
      dispatchId: event.dispatchId ?? null, events: [] });
    tasks.get(key).events.push(event);
  }
  const attempts = [...tasks.values()].map(({ events: rows, ...identity }) => {
    const parentIds = [...new Set(rows.map((e) => e.parentTaskId).filter(Boolean))];
    const dispatchIds = [...new Set(rows.map((e) => e.dispatchId).filter(Boolean))];
    const linkProvenance = (values) => values.length === 0 ? "not-asserted" : values.length === 1 ? "caller-declared" : "conflicting-caller-declarations";
    const recipes = rows.filter((e) => e.kind === "recipe");
    const declarations = new Set(recipes.map((e) => JSON.stringify([e.recipe, e.source, e.version,
      [...e.requiredSkills].sort(), [...e.requiredSteps].sort()])));
    const conflictingRecipes = declarations.size > 1;
    const recipe = conflictingRecipes ? null : recipes[0];
    const requirementsProvenance = conflictingRecipes ? "conflicting-caller-declarations" : recipe ? "caller-declared" : "unknown";
    const reads = rows.filter((e) => e.kind === "read");
    const activities = rows.filter((e) => e.kind === "activity");
    const tools = new Map(rows.filter((e) => e.kind === "tool").map((e) => [e.ref, e]));
    const outcomes = rows.filter((e) => e.kind === "outcome");
    const terminal = outcomes.length === 1 ? outcomes[0] : null;
    const steps = (recipe?.requiredSteps ?? []).map((stepId) => {
      const cited = activities.some((e) => e.activity === "step" && e.stepId === stepId && tools.get(e.ref)?.result === "ok" && tools.get(e.ref)?.toolClass === "work");
      const skipped = activities.some((e) => e.activity === "skip" && e.stepId === stepId);
      return { stepId, status: cited ? "cited-activity" : skipped ? "skipped" : "missing",
        ...(skipped && !cited ? { reason: "explicit-skip" } : {}) };
    });
    const loaded = new Set(reads.map((e) => e.skill));
    const citedSkills = new Set(activities.filter((e) => e.activity === "step" && tools.get(e.ref)?.result === "ok" && tools.get(e.ref)?.toolClass === "work").map((e) => e.skill));
    const missingSkills = (recipe?.requiredSkills ?? []).filter((skill) => !citedSkills.has(skill));
    const observedFailure = terminal?.outcome === "failure" && terminal.reason === "tool-error" && tools.get(terminal.ref)?.result === "error" && tools.get(terminal.ref)?.toolClass === "work";
    const unknownWorker = identity.workerId === observationId("session");
    const observedPane = rows.some((e) => e.kind === "task" && e.paneId === identity.workerId);
    const commands = rows.filter((e) => e.kind === "command");
    return { ...identity,
      workerId: unknownWorker ? null : identity.workerId,
      workerIdentityProvenance: unknownWorker ? "not-captured" : observedPane ? "herdr-pane-observed" : "caller-declared",
      role: null, roleProvenance: "not-captured",
      commandSubmissions: commands.length, submittedSkills: [...new Set(commands.map((e) => e.skill))],
      parentTaskId: parentIds.length === 1 ? parentIds[0] : null,
      parentTaskLinkProvenance: linkProvenance(parentIds),
      dispatchId: dispatchIds.length === 1 ? dispatchIds[0] : null,
      dispatchLinkProvenance: linkProvenance(dispatchIds),
      recipe: recipe ? { name: recipe.recipe, source: recipe.source, version: recipe.version,
      provenance: "caller-declared" } : null,
      requirementsProvenance, expectedSkills: recipe?.requiredSkills ?? [],
      available: "not-captured", loadEvents: reads.length, distinctLoaded: loaded.size, loadedSkills: [...loaded],
      declaredUses: activities.filter((e) => e.activity === "declared").length, citedSkills: [...citedSkills],
      requiredSteps: steps, missingSkills, captureGap: rows.some((e) => e.kind === "gap"),
      reportedOutcome: terminal?.outcome ?? "unknown", reportedReason: terminal?.reason ?? "not-captured",
      outcome: observedFailure ? "failure" : "unknown",
      reason: observedFailure ? "tool-error" : outcomes.length > 1 ? "conflicting-reports" : "not-verified",
      compliant: false,
      coverage: conflictingRecipes ? "requirements-conflicting" : !recipe ? "requirements-unknown" : steps.some((s) => s.status !== "cited-activity") || missingSkills.length
        ? "declared-incomplete" : "declared-cited-not-verified",
    };
  });
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, attempts.filter((a) => a.outcome === outcome).length]));
  const reasons = Object.fromEntries(["tool-error", "conflicting-reports", "not-verified"].map((reason) => [reason, attempts.filter((a) => a.reason === reason).length]));
  return { schema: SKILL_OBSERVATION_ENTRY, sessionId: session, captureLimits: [...CAPTURE_LIMITS], attempts,
    totals: { attempts: attempts.length, loadEvents: attempts.reduce((n, a) => n + a.loadEvents, 0),
      distinctSkills: new Set(attempts.flatMap((a) => a.loadedSkills)).size, compliant: 0,
      missingSteps: attempts.reduce((n, a) => n + a.requiredSteps.filter((s) => s.status === "missing").length, 0),
      skippedSteps: attempts.reduce((n, a) => n + a.requiredSteps.filter((s) => s.status === "skipped").length, 0),
      requirementsUnknown: attempts.filter((a) => a.requirementsProvenance === "unknown").length,
      requirementsConflicting: attempts.filter((a) => a.requirementsProvenance === "conflicting-caller-declarations").length, captureGaps: attempts.filter((a) => a.captureGap).length,
      outcomes, reasons } };
}
