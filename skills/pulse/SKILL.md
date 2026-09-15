// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

# Pulse

Board Pulse moves authorised Kanban work through available role/model capacity
with little ceremony. Use this skill when the user asks to "check the board",
"work through the ready cards", or asks about board scheduling capacity.

Board Pulse is capacity scheduling. It is not worker liveness observation —
that is the separate Herdr `pulse`.

## When to use what

- "Check the board" → call `agentic_kanban_pulse` with `action: "check"`.
  This is a pure observation: it reports card results, capacity, and what
  could be proposed, and it claims nothing.
- "Work through the ready cards" → the interactive `run` action (not yet
  implemented; report that it is not available in this rollout step).
- Enable/disable/configure Pulse → the policy actions (not yet implemented;
  the board-bound automation policy is the only policy store).

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
