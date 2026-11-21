---
name: pulse
description: Use Board Pulse to check Kanban scheduling capacity or work through ready cards.
license: AGPL-3.0-only
---

# Pulse

Board Pulse moves authorised Kanban work through available role/model capacity
with little ceremony. Use this skill when the user asks to "check the board",
"work through the ready cards", or asks about board scheduling capacity.

Board Pulse is capacity scheduling. It is not worker liveness observation —
that is the separate Herdr `pulse`.

## Steps

1. For "check the board", call `agentic_kanban_pulse` with `action: "check"`. It observes cards and capacity without claiming work.
2. For "work through ready cards", use `run`. It fills eligible capacity under the configured board policy after a native confirmation.
3. Use `enable`, `disable` or `configure` only on a direct current-turn human request; preview the policy change and obtain native confirmation. Without a valid policy, dispatch is refused.
4. Read the result and report capacity and any refusals without presenting proposed work as completed.

## Reading a check result

The result is a closed scan shape:

- `cards[]`: one result per card — `READY_FOR_NEXT`, `BLOCKED`, `STALE`,
  `DENIED`, or `REVIEW_REQUIRED` — with a short human reason. Card IDs and
  hashes stay internal; speak in titles.
- `capacity[]`: per role/model route — configured ceiling, active claims,
  free slots, and availability (`available`, `full`, `unauthenticated`,
  `unavailable`, `unknown`).
- `proposedDispatches[]`: what the scheduler would propose next (titles,
  roles, models, placement).

Pulse is off unless the board's automation policy enables it. Without it,
every card reports `REVIEW_REQUIRED` and nothing is proposed. A check never
claims work, never spawns workers, and never completes cards — completion
remains an explicit human board transition.

## Limits

The Pulse tool checks board policy and confirmation for its actions. This skill only guides selection and reporting; it does not authorize or complete a card.
