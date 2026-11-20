# Prompt delivery state machine

The closed state set is `queued`, `delivered`, `answered`, `failed`, `unknown`, `unattributed`, `held`. The same table in `scripts/enforcement/herdr_communication_pi.js` guards in-memory transitions and persisted delivery updates. A persisted `held` is observable as `held`, not `unknown`. Existing records are read as-is; loss of the in-memory attribution snapshot moves an unproven delivery to `held` on read, without replaying the prompt.

| From | Allowed next states | Cause |
| --- | --- | --- |
| queued | queued, delivered, answered, failed, unknown, unattributed, held | busy/idle query, accepted handoff, proven answer after lost ack, rejected/uncertain handoff, missing snapshot, lost attribution |
| delivered | delivered, answered, unattributed, held | pending query, snapshot-backed report, missing snapshot, lost attribution |
| answered | answered | immutable proven answer |
| failed | failed | rejected before acceptance |
| unknown | unknown, held | uncertain handoff; lost attribution |
| unattributed | unattributed, held | no snapshot; lost attribution |
| held | held | persisted hold cannot be retried or attributed |

`waitingForIdle`, `handoffPending`, and `handoffAttempted` remain process-local coordination flags within `queued`; they never grant a second handoff after an attempt. The TLA+ model abstracts them as `waiting` and `sent`; it does not model concurrent process scheduling, retention, or report text parsing. The safety properties are closed state vocabulary, no answer without proof, no replay from settled states, and faithful reads of a hold.

TLC result (2026-11-12): `$PI_HOME/pi/bin/tlc -config PromptDelivery.cfg -deadlock PromptDelivery.tla` from the repository `.scratch/prompt-delivery` copy: **36 states generated, 15 distinct, no errors**. With `Unsafe = TRUE` (the previous held-to-unknown read), TLC reports **Invariant HeldRoundTrips is violated**, 25 states generated. The fail-first runtime test independently reproduced `actual: 'unknown', expected: 'held'` on `origin/main` before the fix.
