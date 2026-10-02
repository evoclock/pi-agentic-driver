// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

# Canonical TASKS.md Obsidian projection (planning item #66)

This document records the contract of the derived Obsidian projection and
the proposal for the future read-only Obsidian plugin (planning item #12).
The projection is implemented in the trusted board writer
(`scripts/enforcement/task_board_core_pi.js`); this document adds no code
authority of its own.

## What exists today (writer side)

After **every** successful write, update, delete, or claim on the canonical
board, the trusted writer recomputes a sibling projection:

- **Path:** `board.md` next to the canonical file. If the canonical board is
  itself named `board.md` (test/dev setups), the projection is
  `board.projection.md` so a view never overwrites its source.
- **Shape:** Obsidian Kanban plugin frontmatter (`kanban-plugin: board`) and
  display lane headings (`## Backlog`, `## In Progress`, `## Review`,
  `## Done`) mapped one-way from the canonical closed lanes.
- **Content:** the same semantic model, serialized through the Obsidian
  surface. Live claims are annotated on the card (`activeClaim`). Priority
  display uses `OBSIDIAN_PRIORITY_MAP` (canonical P0–P3 → Obsidian five
  levels); the reverse trip is documented as lossy and never faithful.
- **Semantics:** full recompute, never an incremental patch. The projection
  is **stale-by-design** the moment the canonical file is hand-edited: no
  reader consults it as authority, and the next trusted write replaces it.
- **Failure mode:** a projection write failure is reported in the writer
  result but never rolls back or invalidates the canonical persist.

A stock Obsidian Kanban plugin pointed at `board.md` renders the board
today, with no pi-side plugin required.

## Validation

`node scripts/enforcement/session_tasks_validate_pi.js --repo-root <root>`
(read-only, rule 30) additionally checks projection consistency:

- if `board.md` exists it must parse as an Obsidian board and its card-ID
  set must equal the canonical set — a mismatch is reported as stale, with
  the fix stated (recomputed on the next trusted write);
- a missing projection is a warning only, never an error;
- `board.md` is never accepted as a promotion target.

## Hard boundary (unchanged)

The trusted board writer is the **sole** writer of durable board bytes.
The projection is a view. Anything that wants to change the board — human,
plugin, or agent — calls the writer (for example through the
`agentic_kanban_board_write` tool surface). Direct Markdown edits to
either file are not dispatchable: the issued-card-ID ledger and the
authority-record HMACs only verify for writer-minted cards.

## Proposal: the Obsidian plugin (item #12, not yet scheduled)

The plugin is deliberately **low priority**. When it is tackled, the
recommended shape is:

1. **Phase 1 — read-only renderer (MVP).** An Obsidian plugin that renders
   the canonical board either by parsing `TASKS.md` directly (vogelkop
   surface) or by reading the `board.md` projection. No editing, no
   commands that mutate, no second data store. Kanban columns from lanes,
   badges from priority/flags/dependencies, claim annotation from
   `activeClaim`. This phase is where all rendering risk is retired.
2. **Phase 2 — writer-routed edits.** Any edit affordance (lane drag,
   checkbox, flag toggle) shells out to a small trusted-writer CLI entry
   point (`task_board_core_pi.js` already exposes pure `writeCard` /
   `updateCard` / `deleteCard` functions a thin CLI can wrap). Edits carry
   the human's own authority record through the same validation as every
   other write; a rejection surfaces verbatim in the UI. The plugin never
   serializes board bytes itself.
3. **Phase 3 — promotion surface (optional).** A queue view of un-promoted
   cards or session survivors is *out of scope* unless the owner asks;
   promotion stays on the owner-facing `TaskPromote` tool with native
   confirmation.

Integration constraints that hold in every phase:

- one semantic model, two surfaces — the plugin adds no fields the writer
  does not know about;
- no reverse priority mapping: an Obsidian-side priority change edits the
  card through the writer, never by rewriting the emoji;
- the plugin holds no secret, no ledger, and no authority record of its
  own;
- `tasks validate` stays the single operational check; the plugin ships
  no parallel validator.

Nothing in this proposal is scheduled work; it exists so item #12 starts
from a written contract instead of archaeology.
