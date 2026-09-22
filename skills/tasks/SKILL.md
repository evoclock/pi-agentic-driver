# tasks — unified session task list + board promotion (v1)

Owner-facing skill for the pi-agentic-driver session task list and
owner-initiated promotion to the durable `TASKS.md` board.

## Prior art and credit

The session task tools (`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`)
reimplement the documented behavior of
[`@ladbabynpm/picc-tasks`](https://www.npmjs.com/package/@ladbabynpm/picc-tasks)
v0.2.0 (MIT, Copyright (c) 2026 Ladbaby) as prior art: the same tool names,
the same storage model (session JSONL snapshot entries plus a disk mirror at
`~/.pi/tasks/{taskListId}/tasks.json`), and the same result text. No code is
copied; this is a clean AGPL-3.0-only reimplementation to the same behavior
spec. picc-tasks is an independent project by its author, used as reference;
it is not affiliated with, nor does it endorse, pi-agentic-driver.

## Interactive task view

The driver-owned skill preserves picc-tasks' owner-facing UI as well as its
session tools:

- the above-editor widget shows visible tasks with `▫`/`▪`/`✓` status icons,
  status, subject, owner, live unresolved blockers, and a count header;
- the footer status pill shows active and done/total counts;
- `/tasks` is a richer, read-only view with descriptions, `activeForm`, and
  `[internal]` markers.

The widget and pill refresh after every task mutation and on `session_start` or
`session_tree`. UI refresh is best-effort: a stale context after session
replacement is swallowed and never turns a successful mutation or `/tasks`
command into an error.

## What this skill owns

1. The **session task list** — working memory for the current session. Every
   task carries `metadata.origin` (`coordinator` or `worker`, with
   `legacy-unknown` for unprovable runtime identity).
2. **Promotion** — `TaskPromote`, an explicit owner-initiated action that
   turns selected session tasks into `TASKS.md` cards through the trusted
   board writer (`scripts/enforcement/task_board_core_pi.js`). The skill is
   a writer CLIENT: it never serializes or writes board bytes itself, and it
   never creates a second authority store.

## Promotion rules (non-negotiable)

- **Owner-initiated only.** Promotion is never automatic, never a
  session-shutdown hook, and never worker-authorized.
- **Fresh authority.** Every promotion requires the owner's actual
  instruction quoted verbatim (`quotedInstruction`) supplied through the
  owner-facing tool call. A digest alone is not accepted.
- **Preview before mutation.** The preview shows the target repository root
  and canonical `TASKS.md` path, title/description, specification,
  definitionOfDone, stoppingPoint, scopePaths, lane, dependencies,
  session-qualified source identity, and the resulting idempotency key.
  Missing required board fields are errors — owner-authorized fields are
  never invented from task text.
- **Workers cannot promote.** Worker origin is observed (never trusted) and
  recorded as audit metadata; a proven worker pane is refused. Unproven
  identity is recorded as `legacy-unknown` and still requires fresh owner
  authority.
- **Completed tasks are skipped by default** in v1. Surviving
  pending/in_progress tasks default to the `backlog` lane so they remain
  dispatchable. `in-progress` lane placement does not make a card
  dispatchable by itself.

## Idempotency

The promotion key binds `taskListId` + `taskId`
(`p1-<sha256(taskListId + NUL + taskId).hex32>`): slash-free,
collision-resistant across sessions. Retrying the same promotion returns the
existing card and link; another session's same numeric task id never
collides. The forward link is stored on the card as `importedId`; the
reverse link (`metadata.promotedCardId`) is set on the session task after
the writer confirms the write.

## Batch promotion

A batch is a sequence of independent writer calls. **Atomicity is not
claimed.** Partial success is reported per task and reconciled
deterministically using the idempotency key and the card↔session link.
Dependency edges are mapped to writer-minted card IDs only after all cards
in the batch exist; edges pointing outside the batch are dropped and
recorded, never written dangling.

## Worker loading contract

The tasks tools ship in the package, so the session tools are present in any
driver-equipped workspace — but presence is not authorization. The
`AGENTIC_DRIVER_TASKS_CAPABILITY` marker is the per-session loading contract:
worker briefs set it when the coordinator intends the worker to plan with the
session tools, and `TaskPromote` commit **enforces** it — a session without
the marker cannot commit a promotion regardless of what authority text it
supplies. The marker never substitutes for the owner confirmation boundary;
it is an additional fail-closed gate on the authority-bearing surface.
Spawned workers receive briefs through prompts (Herdr `agent start` exposes
no environment mechanism), so the marker must be carried in the worker brief
text and exported by the worker's own shell setup; a worker that cannot set
it cannot promote, which is the intended default.

## Migration from picc-tasks

The driver skill reads the existing picc-tasks mirror file on first run; the
shape is identical, so snapshots replay as-is. Tasks missing
`metadata.origin` are NEVER inferred: there is no trusted runtime source for
a legacy task's creation context, so they backfill to `legacy-unknown` audit
metadata on import. Existing `worker` origin values are preserved unchanged.

**Rollback is not symmetric.** The file layout is preserved (re-installing
picc-tasks finds its data intact), but custom session entries and
UI/reminder behavior changes are retained by the driver skill and are not
reverted by re-installing picc-tasks.

## Validation (rule 30)

`node scripts/enforcement/session_tasks_validate_pi.js --repo-root <root>`
is read-only. It validates session snapshot shape, taskListId resolution,
promotion metadata, linkage integrity, board availability (canonical
`TASKS.md` first; `board.md` never), and promotion target configuration.
Exit 0 only when ready; nonzero with a machine-readable error list
otherwise. It never mutates state, never writes the board, never promotes.

## Out of scope in v1

No Obsidian work. No automatic worker proposal store. No session-end prompt.
No completed-task promotion. No Vogelkop writer-authority changes.
