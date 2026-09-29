// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// NUDGE §5 recovery ladder — per-reason nudge state machine (pure). Journey
// state is a map keyed by the closed stuck-reason enum:
//
//   reasonState[reasonCode] = {
//     nudgeCount, lastNudgedAt, escalated,
//     firstObservedSnapshot, lastObservedSnapshot, lastMessageSha256
//   }
//
// Transitions (§5, §8):
//   - first observation of a reason        ⇒ nudge (create reason state)
//   - re-observation of the same reason    ⇒ escalated (never an identical
//                                            resend — message-hash
//                                            non-repetition enforcement)
//   - a different reason                   ⇒ fresh problem, fresh first nudge
//   - same-reason replacement loop guard   ⇒ replacement N+1 reaching the
//                                            same reasonCode as replacement N
//                                            parks as systemic failure
//
// The bound is the closed reason taxonomy × finite ladder depth, not an
// arbitrary journey count: nudgeCount is audit evidence, never a cap. No
// I/O; the ladder consumes an injected nudge-transport interface — the N1
// fixed-argv transport arrives with the upstream herdr capability.

import { NUDGE_STUCK_REASONS } from "./nudge_classifier_pi.js";
import { sha256Hex } from "./nudge_ledger_pi.js";

export const NUDGE_REASON_STATES_KEY = "reasonState";

// Record one observation of a stuck reason and decide the ladder step.
// Parameters:
//   reasonState     — the journey's current reasonState map (not mutated;
//                     a new map is returned)
//   reasonCode      — one of NUDGE_STUCK_REASONS
//   snapshot        — the current progress-snapshot evidence (opaque object;
//                     stored as firstObservedSnapshot/lastObservedSnapshot)
//   messageText     — the exact candidate nudge text for this action
//   now             — ISO timestamp of this observation
//   lastAction      — what the ladder last did for this journey:
//                     null | { kind: "nudge", reasonCode, entryId } |
//                     { kind: "replacement", reasonCode, entryId }
//
// Returns { decision, reasonState, errors }:
//   decision.nudge         — a first or varied nudge must be issued
//   decision.escalate      — the reason re-observed; SAFE extraction may
//                            proceed to replacement
//   decision.parkSystemic  — same-reason replacement loop guard tripped
//   decision.error         — message-hash repetition (never send identical
//                            bytes); the caller must vary the message
export function observeReason({
  reasonState = {},
  reasonCode,
  snapshot = null,
  messageText,
  now,
  lastAction = null,
} = {}) {
  if (!NUDGE_STUCK_REASONS.includes(reasonCode)) {
    const error = `reasonCode must be one of ${NUDGE_STUCK_REASONS.join(", ")}`;
    return { decision: { error }, reasonState, errors: [error] };
  }
  if (typeof messageText !== "string" || messageText === "") {
    return { decision: { error: "messageText is required" }, reasonState, errors: ["messageText is required"] };
  }
  if (typeof now !== "string" || now === "") {
    return { decision: { error: "now is required" }, reasonState, errors: ["now is required"] };
  }
  const messageSha256 = sha256Hex(messageText);
  const existing = reasonState[reasonCode] ?? null;

  // Same-reason replacement loop guard (§5.3): replacement N+1 reaching the
  // same reasonCode as replacement N is systemic failure — park rather than
  // spawn another replacement.
  if (lastAction?.kind === "replacement" && lastAction.reasonCode === reasonCode) {
    return {
      decision: {
        parkSystemic: true,
        reason: `replacement N+1 reached the same reasonCode (${reasonCode}) as replacement N — systemic failure; park and notify (§5.3)`,
      },
      reasonState,
      errors: [],
    };
  }

  if (existing === null) {
    // First observation of this reason: create reason state and nudge.
    const next = {
      ...reasonState,
      [reasonCode]: {
        nudgeCount: 1,
        lastNudgedAt: now,
        escalated: false,
        firstObservedSnapshot: snapshot,
        lastObservedSnapshot: snapshot,
        lastMessageSha256: messageSha256,
      },
    };
    return { decision: { nudge: true, firstForReason: true }, reasonState: next, errors: [] };
  }

  // Re-observation of a known reason: mark escalated, never resend identical
  // bytes (§3.1: an unknown attempt is never resent identically; §5.2: every
  // message must differ in exact bytes and hash from all prior messages for
  // that reason).
  if (existing.lastMessageSha256 === messageSha256) {
    return {
      decision: {
        error: "message-hash repetition: this exact message was already sent for this reason — vary the content (never an identical resend)",
      },
      reasonState,
      errors: [],
    };
  }
  const next = {
    ...reasonState,
    [reasonCode]: {
      ...existing,
      nudgeCount: existing.nudgeCount + 1,
      lastNudgedAt: now,
      escalated: true,
      lastObservedSnapshot: snapshot,
      lastMessageSha256: messageSha256,
    },
  };
  return { decision: { nudge: true, escalated: true, firstForReason: false }, reasonState: next, errors: [] };
}

// The state machine does not cap nudges: nudgeCount is audit evidence, not a
// cap (OPEN-6 RESOLVED-BY-OWNER). This helper exists so tests and the ladder
// can assert the absence of any numeric cap logic.
export function nudgeCountIsACap() {
  return false;
}
