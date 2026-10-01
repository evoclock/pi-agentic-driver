# Worker dispatch evidence contract (`agentic_worker_dispatch`)

Privacy-driven breaking response-shape change, effective from the
session-task-provenance work on `feat/session-task-provenance`.

## What the guarantee covers

Only driver-owned task identity fields and the NEW provenance projection are
sanitized:

- Session task IDs, titles, and descriptions are unbounded caller-controlled
  strings that can carry secret-like or private planning text. Fields the
  driver itself constructs from them never carry the raw values.

## What it does NOT cover (explicit boundary)

- `steps[].report`, `steps[].error`, `steps[].gapAnalysis`, and other
  worker/herdr-authored text are UNTRUSTED evidence passed through verbatim.
  The worker receives the raw task ID and subject in its prompt (by design,
  so it can resolve the task with `TaskGet`), and its reports or error
  strings may echo the prompt, task ID, title, or description into the
  coordinator-visible result and marked receipt. Treat them as untrusted
  input; do not parse secrets out of them and do not assume they are clean.
- The display token is a deterministic PSEUDONYM: anyone who knows a raw ID
  (or can guess candidate IDs) can compute its token and correlate steps.
  It prevents disclosure of the raw ID, not correlation. It is not a secret
  and provides no secrecy beyond non-echo.
- Broad redaction of worker-authored text would delete task-outcome evidence
  this slice intentionally preserves. An owner-facing general redaction
  policy, if wanted, is a separate follow-up decision, not part of this
  contract.

## Field contract

- `steps[].taskDisplayId` — opaque display token, deterministic
  `sessionTaskDisplayId(rawId)` = full 64-hex SHA-256 of
  `agentic-driver.session-task-display.v1:<rawId>`. No lossy truncation, no
  fabricated identity. `null` when no task was selected.
- `steps[].progress.taskDisplayId` — same token.
- `report` marked journey receipt line: `step N: taskDisplayId=<token>`.
- `taskProvenance` (NEW on this branch) — `status` limited to the closed
  `PROVENANCE_CAPTURE_STATUSES` enum (a throwing/absent projector falls back
  to `source-unavailable` without altering dispatch), plus per-task
  `{taskDisplayId, digest}` where `digest` is the deterministic digest of the
  frozen LOCAL capture (title, description, capturedAt are never serialized).
- The raw ID stays internal to dispatch selection, the dispatched set, and
  the worker prompt. The result does not include it in driver-owned fields,
  but guessable IDs can be inferred from the deterministic token.

## Breaking change (main → this branch)

On main the result exposed the RAW session task ID through
`steps[].taskId`, `steps[].progress.taskId`, and the receipt line
`task=<id>`. These fields are REMOVED and replaced by the explicit
`taskDisplayId` fields above; the hashed value is not re-exposed under the
old field names, so consumers must read `taskDisplayId`. `taskProvenance`
did not exist on main; its shape is new, not renamed.
