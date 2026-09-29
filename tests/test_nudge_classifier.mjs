// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// NUDGE §2/§9 classifier tests: total coverage of every valid status/report
// combination, every ordered rule, done-without-report, and the
// complete-over-idle precedence.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyObservation, validateObservation,
  NUDGE_STUCK_REASONS, NUDGE_STATE_REASON, stalledUnknownReason,
} from "../scripts/enforcement/nudge_classifier_pi.js";

function obs(overrides = {}) {
  return {
    agentStatus: "working", stateChangeSeq: 5, role: "implementer",
    reportState: "pending", absentRole: false, sequenceFrozen: false,
    ...overrides,
  };
}

test("rule 1: complete report wins over every status, including idle (complete-over-idle precedence)", () => {
  for (const status of ["idle", "working", "blocked", "done", "unknown"]) {
    const result = classifyObservation(obs({ agentStatus: status, reportState: "complete" }));
    assert.equal(result.state, "complete", status);
    assert.equal(result.reasonCode, null);
    assert.equal(result.confidenceBasis, "rule-1-complete-over-status");
  }
});

test("rule 1: a prior complete report cannot trigger new work even with an advanced sequence", () => {
  const result = classifyObservation(obs({ agentStatus: "idle", reportState: "complete", stateChangeSeq: 99 }));
  assert.equal(result.state, "complete");
});

test("rule 2: absent role classifies gone and never emits a stuck reason", () => {
  const result = classifyObservation(obs({ absentRole: true }));
  assert.equal(result.state, "gone");
  assert.equal(result.reasonCode, null);
  assert.equal(result.confidenceBasis, "rule-2-absent-role");
  assert.ok(!NUDGE_STUCK_REASONS.includes("gone"));
});

test("rule 3: blocked status is stuck-on-dialog with reason blocked-modal, regardless of screen text", () => {
  const result = classifyObservation(obs({ agentStatus: "blocked" }));
  assert.equal(result.state, "stuck-on-dialog");
  assert.equal(result.reasonCode, "blocked-modal");
  assert.equal(result.confidenceBasis, "rule-3-blocked-status");
});

test("rule 4: working with an advanced sequence is working-on-task", () => {
  const result = classifyObservation(obs({ agentStatus: "working", stateChangeSeq: 12 }));
  assert.equal(result.state, "working-on-task");
  assert.equal(result.reasonCode, null);
  assert.equal(result.confidenceBasis, "rule-4-working-progressing");
});

test("rule 4: working below the frozen threshold (sequenceFrozen false) is still working-on-task", () => {
  const result = classifyObservation(obs({ agentStatus: "working", sequenceFrozen: false }));
  assert.equal(result.state, "working-on-task");
});

test("rule 5: working sequence frozen for >= stallPolls is stalled-unknown with working-sequence-frozen", () => {
  const result = classifyObservation(obs({ agentStatus: "working", sequenceFrozen: true }));
  assert.equal(result.state, "stalled-unknown");
  assert.equal(result.reasonCode, "working-sequence-frozen");
  assert.equal(result.confidenceBasis, "rule-5-frozen-sequence");
});

test("rule 5: otherwise-valid unknown status is stalled-unknown with status-unknown", () => {
  const result = classifyObservation(obs({ agentStatus: "unknown" }));
  assert.equal(result.state, "stalled-unknown");
  assert.equal(result.reasonCode, "status-unknown");
  assert.equal(result.confidenceBasis, "rule-5-unknown-status");
});

test("rule 5 split: frozen sequence takes precedence over unknown status inside stalled-unknown", () => {
  assert.equal(stalledUnknownReason({ status: "unknown", sequenceFrozen: true }), "working-sequence-frozen");
  assert.equal(stalledUnknownReason({ status: "unknown", sequenceFrozen: false }), "status-unknown");
});

test("rule 6: idle with no complete report is idle-eligible, not a stuck state", () => {
  const result = classifyObservation(obs({ agentStatus: "idle", reportState: "pending" }));
  assert.equal(result.state, "idle-eligible");
  assert.equal(result.reasonCode, null);
  assert.equal(result.confidenceBasis, "rule-6-idle-no-report");
});

test("rule 7: done without an extractable complete report is done-without-report", () => {
  for (const reportState of ["pending", "unavailable"]) {
    const result = classifyObservation(obs({ agentStatus: "done", reportState }));
    assert.equal(result.state, "done-without-report", reportState);
    assert.equal(result.reasonCode, "done-report-unavailable");
    assert.equal(result.confidenceBasis, "rule-7-done-no-report");
  }
});

test("complete-over-idle precedence: complete beats idle AND beats done-without-report inputs", () => {
  assert.equal(classifyObservation(obs({ agentStatus: "idle", reportState: "complete" })).state, "complete");
  assert.equal(classifyObservation(obs({ agentStatus: "done", reportState: "complete" })).state, "complete");
});

test("ordering: blocked beats working-progressing and gone beats blocked (rule order is total)", () => {
  // absentRole outranks blocked status.
  assert.equal(classifyObservation(obs({ agentStatus: "blocked", absentRole: true })).state, "gone");
  // blocked outranks an advancing sequence.
  assert.equal(classifyObservation(obs({ agentStatus: "blocked", stateChangeSeq: 99 })).state, "stuck-on-dialog");
});

test("state→reason mapping table is closed and matches NUDGE §5", () => {
  assert.deepEqual(NUDGE_STATE_REASON, {
    "stuck-on-dialog": "blocked-modal",
    "stalled-unknown": null,
    "done-without-report": "done-report-unavailable",
  });
  assert.deepEqual(NUDGE_STUCK_REASONS, [
    "blocked-modal", "working-sequence-frozen", "status-unknown", "done-report-unavailable",
  ]);
});

test("every valid status/report combination classifies to exactly one state (totality)", () => {
  for (const status of ["idle", "working", "blocked", "done", "unknown"]) {
    for (const reportState of ["pending", "complete", "unavailable"]) {
      for (const sequenceFrozen of [false, true]) {
        for (const absentRole of [false, true]) {
          const result = classifyObservation(obs({ agentStatus: status, reportState, sequenceFrozen, absentRole }));
          if (validityOf({ status, reportState }).ok) {
            assert.ok(result.state !== null, `${status}/${reportState}/${sequenceFrozen}/${absentRole}`);
            assert.ok(
              result.reasonCode === null || NUDGE_STUCK_REASONS.includes(result.reasonCode),
              `${result.state} emitted reason ${result.reasonCode}`,
            );
          }
        }
      }
    }
  }
});

function validityOf({ status, reportState }) {
  return validateObservation({ agentStatus: status, stateChangeSeq: 0, role: "r" })
    && { ok: typeof reportState === "string" };
}

test("malformed observation is an observation error, never a worker state (fails closed)", () => {
  for (const bad of [
    { agentStatus: "running", stateChangeSeq: 0, role: "r", reportState: "pending" },
    { agentStatus: "working", stateChangeSeq: -1, role: "r", reportState: "pending" },
    { agentStatus: "working", stateChangeSeq: 1.5, role: "r", reportState: "pending" },
    { agentStatus: "working", stateChangeSeq: 0, role: "", reportState: "pending" },
    { agentStatus: "working", stateChangeSeq: 0, role: "r", reportState: "extracted" },
    null,
  ]) {
    const result = classifyObservation(bad ?? {});
    assert.equal(result.state, null, JSON.stringify(bad));
    assert.match(result.confidenceBasis, /^observation-error:/);
  }
});

test("validateObservation rejects a negative revision but accepts a safe one", () => {
  assert.equal(validateObservation({ agentStatus: "idle", stateChangeSeq: 0, role: "r", revision: -2 }).ok, false);
  assert.equal(validateObservation({ agentStatus: "idle", stateChangeSeq: 0, role: "r", revision: 7 }).ok, true);
});
