# Worker dispatch evidence contract (`agentic_worker_dispatch`)

Privacy-driven breaking response-shape change, effective from the
session-task-provenance work on `feat/session-task-provenance`.

## Why

Session task IDs, titles, and descriptions are unbounded caller-controlled
strings that can carry secret-like or private planning text. The coordinator
facing dispatch result (model-visible `content` and `details`, including step
records, progress snapshots, the marked journey report, handoff records, and
the provenance projection) must not echo them. Raw task IDs remain internal
to dispatch selection and are still given to the dispatched worker in its
prompt so the worker can resolve the task with `TaskGet`.

## Field contract

- `steps[].taskDisplayId` — opaque display token, deterministic
  `sessionTaskDisplayId(rawId)` = full 64-hex SHA-256 of
  `agentic-driver.session-task-display.v1:<rawId>`. No lossy truncation, no
  fabricated identity. `null` when no task was selected.
- `steps[].progress.taskDisplayId` — same token.
- `report` marked journey receipt line: `step N: taskDisplayId=<token>`.
- `taskProvenance.tasks[].taskDisplayId` + `taskProvenance.tasks[].digest`
  — opaque token plus the deterministic content digest of the frozen local
  capture (title, description, capturedAt never serialized).
- `taskProvenance.status` is limited to the closed
  `PROVENANCE_CAPTURE_STATUSES` enum; unknown statuses fall back to
  `source-unavailable`.

## Breaking change

Earlier shapes exposed `steps[].taskId`, `steps[].progress.taskId`,
`taskProvenance.tasks[].id`, and the receipt line `task=<id>`; these carried
the raw session task ID and are REMOVED. The hashed value is not re-exposed
under the old field name: consumers must read the explicit `taskDisplayId`
fields above. The raw ID is intentionally not recoverable from the token;
map back through the session task store, never through the result.

The worker-facing prompt text (`Task: <rawId> — <subject>`) is unchanged by
design: the dispatched worker needs the real ID for `TaskGet`.
