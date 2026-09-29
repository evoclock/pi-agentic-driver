// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// NUDGE §2 total detection classifier (SPEC_TASK43_NUDGE.md v3.3.1). Pure
// module: no I/O, no transport, no authority. #41's poll loop supplies one
// validated observation per poll and applies this classifier exactly once;
// the first matching ordered rule wins, so the classification is total and
// deterministic. Screen text corroborates a block but never changes the
// classification; malformed identity/readiness/provenance is an observation
// error owned by #41 and fails closed there, not a worker state here.

// The closed stuck-reason enum (NUDGE §5). `gone` (absent role) is
// deliberately excluded: #41's absent-role taxonomy owns it.
export const NUDGE_STUCK_REASONS = Object.freeze([
  "blocked-modal",
  "working-sequence-frozen",
  "status-unknown",
  "done-report-unavailable",
]);

// The seven classifier states (NUDGE §2), in rule order.
export const NUDGE_CLASSIFIER_STATES = Object.freeze([
  "complete",
  "gone",
  "stuck-on-dialog",
  "working-on-task",
  "stalled-unknown",
  "idle-eligible",
  "done-without-report",
]);

// Classifier state → stuck reason (NUDGE §5 table). States outside the
// stuck taxonomy map to null: `complete`, `gone`, `working-on-task`, and
// `idle-eligible` are not recovery triggers.
export const NUDGE_STATE_REASON = Object.freeze({
  "stuck-on-dialog": "blocked-modal",
  // Deliberately null: callers must use stalledUnknownReason() to resolve
  // frozen-sequence versus unknown-status evidence.
  "stalled-unknown": null,
  "done-without-report": "done-report-unavailable",
});

// `stalled-unknown` splits on evidence: a frozen working sequence is
// `working-sequence-frozen`; an otherwise-valid `unknown` status is
// `status-unknown`. This is the one state with two reasons.
export function stalledUnknownReason({ status = null, sequenceFrozen = false } = {}) {
  if (sequenceFrozen) return "working-sequence-frozen";
  if (status === "unknown") return "status-unknown";
  return null;
}

const VALID_STATUS = Object.freeze(["idle", "working", "blocked", "done", "unknown"]);

// Validate one agent observation (NUDGE §1.1 validated fields). Returns
// {ok, errors} — malformed identity/status/sequence is an observation error,
// not a worker state, and the caller (the #41 poll loop) fails closed on it.
// This module never guesses a status to keep classifying.
export function validateObservation(observation) {
  const errors = [];
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    return { ok: false, errors: ["observation: must be an object"] };
  }
  if (!VALID_STATUS.includes(observation.agentStatus)) {
    errors.push(`agentStatus: must be one of ${VALID_STATUS.join(", ")} (got ${JSON.stringify(observation.agentStatus ?? null)})`);
  }
  const seq = observation.stateChangeSeq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    errors.push(`stateChangeSeq: must be a safe integer >= 0 (got ${JSON.stringify(seq ?? null)})`);
  }
  if (typeof observation.role !== "string" || observation.role === "") {
    errors.push("role: must be a non-empty string");
  }
  const revision = observation.revision;
  if (revision !== undefined && revision !== null
    && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
    errors.push(`revision: when present must be a safe integer >= 0 (got ${JSON.stringify(revision)})`);
  }
  return { ok: errors.length === 0, errors };
}

// The total ordered classifier (NUDGE §2). Input: one validated agent
// observation plus the report evidence and the frozen-sequence judgment
// supplied by the #41 poll loop (stallPolls is owned solely by #41's
// dispatch config; this module only consumes the derived boolean).
//
// Parameters:
//   agentStatus      — one of idle | working | blocked | done | unknown
//   stateChangeSeq   — safe integer >= 0
//   role             — non-empty role string (validated identity)
//   reportState      — "pending" | "complete" | "unavailable" (#41 §3.2)
//   absentRole       — true when #41 mapped the observation to its
//                      absent-role class (`gone` is #41 taxonomy scope)
//   sequenceFrozen   — boolean: working sequence frozen for >= stallPolls
//                      consecutive observations (judged by the poll loop)
//
// Output: { state, reasonCode, confidenceBasis } — reasonCode is null for
// non-stuck states; confidenceBasis names the ordered rule that decided.
export function classifyObservation({
  agentStatus = null,
  stateChangeSeq = null,
  role = null,
  reportState = null,
  absentRole = false,
  sequenceFrozen = false,
} = {}) {
  const observation = { agentStatus, stateChangeSeq, role };
  const validity = validateObservation(observation);
  if (!validity.ok) {
    return {
      state: null,
      reasonCode: null,
      confidenceBasis: `observation-error: ${validity.errors.join("; ")}`,
    };
  }
  if (typeof reportState !== "string"
    || !["pending", "complete", "unavailable"].includes(reportState)) {
    return {
      state: null,
      reasonCode: null,
      confidenceBasis: `observation-error: reportState must be pending | complete | unavailable (got ${JSON.stringify(reportState)})`,
    };
  }

  // Rule 1 — complete: a complete provenance-valid role report exists,
  // regardless of current idle/done status. Complete precedes idle so a
  // prior report can never trigger new work.
  if (reportState === "complete") {
    return { state: "complete", reasonCode: null, confidenceBasis: "rule-1-complete-over-status" };
  }
  // Rule 2 — gone: #41 returns its absent-role class; `gone` stays #41
  // taxonomy scope and is excluded from the stuck-reason enum.
  if (absentRole === true) {
    return { state: "gone", reasonCode: null, confidenceBasis: "rule-2-absent-role" };
  }
  // Rule 3 — stuck-on-dialog: status is `blocked`. herdr classified the
  // worker blocked; screen text does not determine the cause.
  if (agentStatus === "blocked") {
    return { state: "stuck-on-dialog", reasonCode: "blocked-modal", confidenceBasis: "rule-3-blocked-status" };
  }
  // Rule 4 — working-on-task: status is `working` and the sequence advanced,
  // or fewer than stallPolls consecutive frozen observations exist (i.e.
  // the poll loop has not yet judged the sequence frozen).
  if (agentStatus === "working" && !sequenceFrozen) {
    return { state: "working-on-task", reasonCode: null, confidenceBasis: "rule-4-working-progressing" };
  }
  // Rule 5 — stalled-unknown: working sequence frozen for at least
  // stallPolls, or status is otherwise-valid `unknown`.
  if ((agentStatus === "working" && sequenceFrozen) || agentStatus === "unknown") {
    const reasonCode = stalledUnknownReason({ status: agentStatus, sequenceFrozen });
    return {
      state: "stalled-unknown",
      reasonCode,
      confidenceBasis: agentStatus === "working" ? "rule-5-frozen-sequence" : "rule-5-unknown-status",
    };
  }
  // Rule 6 — idle-eligible: idle with no complete report.
  if (agentStatus === "idle") {
    return { state: "idle-eligible", reasonCode: null, confidenceBasis: "rule-6-idle-no-report" };
  }
  // Rule 7 — done-without-report: done with no extractable complete report;
  // terminal evidence failure `done-report-unavailable`.
  if (agentStatus === "done") {
    return {
      state: "done-without-report",
      reasonCode: "done-report-unavailable",
      confidenceBasis: "rule-7-done-no-report",
    };
  }
  // Unreachable for validated inputs (every validated status is handled
  // above); kept as an explicit fail-closed floor.
  return {
    state: null,
    reasonCode: null,
    confidenceBasis: `observation-error: unclassified status ${JSON.stringify(agentStatus)}`,
  };
}
