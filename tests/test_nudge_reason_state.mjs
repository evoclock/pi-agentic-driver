// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// NUDGE §5 per-reason state machine tests: every transition.

import test from "node:test";
import assert from "node:assert/strict";
import { observeReason, nudgeCountIsACap } from "../scripts/enforcement/nudge_reason_state_pi.js";
import { sha256Hex } from "../scripts/enforcement/nudge_ledger_pi.js";

const SNAPSHOT = { schema: "agentic-driver.progress-snapshot.v1", head: "a".repeat(40) };

test("first observation of a reason creates reason state and nudges", () => {
  const { decision, reasonState, errors } = observeReason({
    reasonCode: "blocked-modal", snapshot: SNAPSHOT, messageText: "status?", now: "t1",
  });
  assert.deepEqual(errors, []);
  assert.equal(decision.nudge, true);
  assert.equal(decision.firstForReason, true);
  const state = reasonState["blocked-modal"];
  assert.equal(state.nudgeCount, 1);
  assert.equal(state.lastNudgedAt, "t1");
  assert.equal(state.escalated, false);
  assert.deepEqual(state.firstObservedSnapshot, SNAPSHOT);
  assert.deepEqual(state.lastObservedSnapshot, SNAPSHOT);
  assert.equal(state.lastMessageSha256, sha256Hex("status?"));
});

test("re-observation of the same reason sets escalated and nudges again (varied message)", () => {
  const first = observeReason({ reasonCode: "blocked-modal", snapshot: SNAPSHOT, messageText: "status?", now: "t1" });
  const second = observeReason({
    reasonState: first.reasonState, reasonCode: "blocked-modal",
    snapshot: SNAPSHOT, messageText: "please checkpoint and report", now: "t2",
  });
  assert.equal(second.decision.nudge, true);
  assert.equal(second.decision.escalated, true);
  assert.equal(second.decision.firstForReason, false);
  const state = second.reasonState["blocked-modal"];
  assert.equal(state.nudgeCount, 2);
  assert.equal(state.escalated, true);
  assert.equal(state.lastMessageSha256, sha256Hex("please checkpoint and report"));
  // firstObservedSnapshot is immutable across re-observations.
  assert.deepEqual(state.firstObservedSnapshot, SNAPSHOT);
});

test("message-hash non-repetition: identical bytes for the same reason are refused, never sent", () => {
  const first = observeReason({ reasonCode: "blocked-modal", snapshot: SNAPSHOT, messageText: "status?", now: "t1" });
  const repeat = observeReason({
    reasonState: first.reasonState, reasonCode: "blocked-modal",
    snapshot: SNAPSHOT, messageText: "status?", now: "t2",
  });
  assert.equal(repeat.decision.nudge, undefined);
  assert.match(repeat.decision.error, /message-hash repetition/);
  // The reason state is unchanged by the refused send.
  assert.equal(repeat.reasonState["blocked-modal"].nudgeCount, 1);
});

test("a different reason is a fresh problem with its own first nudge", () => {
  const first = observeReason({ reasonCode: "blocked-modal", snapshot: SNAPSHOT, messageText: "status?", now: "t1" });
  const second = observeReason({
    reasonState: first.reasonState, reasonCode: "working-sequence-frozen",
    snapshot: SNAPSHOT, messageText: "frozen? report progress", now: "t2",
  });
  assert.equal(second.decision.nudge, true);
  assert.equal(second.decision.firstForReason, true);
  assert.equal(second.reasonState["blocked-modal"].nudgeCount, 1, "prior reason untouched");
  assert.equal(second.reasonState["working-sequence-frozen"].nudgeCount, 1);
  assert.equal(second.reasonState["working-sequence-frozen"].escalated, false);
});

test("no journey count cap: nudging continues across many re-observations of the same reason", () => {
  let state = {};
  for (let i = 0; i < 25; i += 1) {
    const result = observeReason({
      reasonState: state, reasonCode: "status-unknown",
      snapshot: SNAPSHOT, messageText: `variation ${i} — please report`, now: `t${i}`,
    });
    assert.equal(result.decision.nudge, true, `nudge ${i} was capped`);
    state = result.reasonState;
  }
  assert.equal(state["status-unknown"].nudgeCount, 25);
  assert.equal(state["status-unknown"].escalated, true);
  assert.equal(nudgeCountIsACap(), false);
});

test("same-reason replacement loop guard: replacement N+1 with the same reasonCode parks as systemic failure", () => {
  const result = observeReason({
    reasonCode: "blocked-modal", snapshot: SNAPSHOT, messageText: "status?", now: "t1",
    lastAction: { kind: "replacement", reasonCode: "blocked-modal", entryId: "e1" },
  });
  assert.equal(result.decision.parkSystemic, true);
  assert.match(result.decision.reason, /systemic failure/);
  assert.equal(result.decision.nudge, undefined);
});

test("loop guard: a different reason after a replacement starts its own reason state and may be nudged", () => {
  const result = observeReason({
    reasonCode: "working-sequence-frozen", snapshot: SNAPSHOT, messageText: "frozen? report", now: "t1",
    lastAction: { kind: "replacement", reasonCode: "blocked-modal", entryId: "e1" },
  });
  assert.equal(result.decision.parkSystemic, undefined);
  assert.equal(result.decision.nudge, true);
  assert.equal(result.decision.firstForReason, true);
});

test("loop guard: a prior nudge does not trip the guard — only a prior replacement does", () => {
  const result = observeReason({
    reasonCode: "blocked-modal", snapshot: SNAPSHOT, messageText: "varied", now: "t1",
    lastAction: { kind: "nudge", reasonCode: "blocked-modal", entryId: "e1" },
  });
  assert.equal(result.decision.parkSystemic, undefined);
  assert.equal(result.decision.nudge, true);
});

test("invalid inputs are rejected without mutating state", () => {
  for (const bad of [
    { reasonCode: "", messageText: "m", now: "t" },
    { reasonCode: "totally-made-up", messageText: "m", now: "t" },
    { reasonCode: "blocked-modal", messageText: "", now: "t" },
    { reasonCode: "blocked-modal", messageText: "m", now: "" },
  ]) {
    const result = observeReason(bad);
    assert.ok(result.decision.error, JSON.stringify(bad));
    assert.deepEqual(result.errors.length >= 1, true);
  }
});

test("the input reasonState map is never mutated", () => {
  const original = {
    "blocked-modal": {
      nudgeCount: 1, lastNudgedAt: "t0", escalated: false,
      firstObservedSnapshot: SNAPSHOT, lastObservedSnapshot: SNAPSHOT,
      lastMessageSha256: sha256Hex("old"),
    },
  };
  const frozen = JSON.parse(JSON.stringify(original));
  observeReason({
    reasonState: original, reasonCode: "blocked-modal",
    snapshot: SNAPSHOT, messageText: "new", now: "t1",
  });
  assert.deepEqual(original, frozen);
});
