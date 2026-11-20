# Logical ownership refinement

This library-only slice adds `release-ownership`, `transfer-ownership` and `reconcile-old`. It does not dispatch workers. Logical ownership is persisted in the authenticated journal/snapshot above the unchanged per-event filesystem writer lock. No operation forcibly retires a live PID/inode lock. The earlier design's handbrake `Release` is a separate operation and is unchanged.

## Contract

`ownership` contains `ownerId`, a nonnegative `generation`, and `managed`. Existing runs without this field retain legacy behavior at generation zero. Every new dispatch intent includes `ownerGeneration`. The first successful ownership control permanently enables managed mode. CLI/Pi do not expose the new events or provide these adapters. A managed run cannot obtain another act/advance through an adapter-free tick. This opt-in compatibility path is not authenticated ownership for legacy runs.

The library's trusted host supplies synchronous callbacks, never caller JSON assertions:

- `ownerControl(request)` must return every request field unchanged plus `approved: true`. Requests bind task digest, event ID, operation, current owner/generation and target owner. Release sets the owner to null. Transfer selects a different synthetic owner identifier. Both increment logical generation and epoch, clear pending/wake evidence, retain uncertain intent and preserve holds/cancellation. Neither resets attempts.
- `observeOwner(request)` must return the exact task digest, non-null owner and generation before a managed act or advance. The returned intent carries that generation. A duplicate managed act/advance returns `ownership-replay-not-dispatch`, not an actionable replay.
- `reconcileOld(request)` must return the exact task digest, dispatch ID, dispatch-time writer/generation/epoch, branch and base, plus terminal status `absent`, `completed` or `failed`. Unknown, merely present and misbound observations retain the old intent. Terminal readback retires uncertainty, not artifact acceptance or DONE. Ordinary readback cannot bypass this stale-effect path.

Callbacks are a trusted host boundary, not an implementation of identity verification. The host must independently obtain observations and reject unsafe identity routes. A task digest includes the canonical repository and frozen contract; the existing per-checkout index binds it to one run. This is not cross-checkout coordination or a same-user security boundary.

## Model-first evidence

`Fix4Ownership.tla` composes `Fix4RunnerRR5` unchanged using an instance. RR5 actions stutter logical state; ownership actions stutter RR5 state. It explores two logical owners, two ownership changes, two effects and generations zero through two. Trusted/bound observations are abstract inputs, not filesystem or host proofs.

TLC 2.19 produced the following results before production implementation. New sanitized outputs are saved alongside earlier evidence with the `tlc-gap3-` prefix. Absolute worktree/temp paths and process IDs are replaced by placeholders; existing evidence was not overwritten.

| Config | Result | Generated | Distinct |
| --- | --- | ---: | ---: |
| Fix4Ownership | safe, all seven invariants pass | 6,191 | 1,488 |
| unsafe-release | ControlAuthorized violated | 7 | 6 |
| unsafe-transfer | ControlAuthorized violated | 7 | 6 |
| unsafe-generation | GenerationAdvanced violated | 7 | 6 |
| unsafe-effect | NoStaleOwnerActs violated | 9 | 8 |
| unsafe-reconcile | NoBlindRetry violated | 527 | 203 |
| RR5 safe rerun | TypeOK, OneWriterNoFork, OwnerStopAvailable pass | 131 | 48 |
| RR5 unsafe-generation rerun | OneWriterNoFork violated | 100 | 43 |
| RR5 unsafe-owner-cap rerun | OwnerStopAvailable violated | 34 | 19 |

The ownership safe run checks TypeOK, OneWriterNoFork, OwnerStopAvailable, ControlAuthorized, GenerationAdvanced, NoStaleOwnerActs and NoBlindRetry. ControlAuthorized and GenerationAdvanced are rule-conformance invariants; they do not independently prove an outcome failure with all other fences intact. NoBlindRetry exposes the outcome of dropping terminal reconciliation: Act, ownership change, unknown reconciliation, another Act leaves two effects outstanding. NoStaleOwnerActs exposes accepting a stale actor/generation. The original RR5 finite results retain their previous meaning and counts.

The unchanged original Fix4Runner safe run also passed all seven original invariants with 49,255 generated / 6,163 distinct states. Single-guard reruns violated CancelledNeverActs (184 distinct), NoActAfterHalt (241), OneWriterNoFork (2,340), CompactionExact (56) and StoreBound (163). The writer-only NoJournalFork check violated at 11,262 distinct states. Unsafe traversal counts depend on invariant selection and exploration order, not just the unsafe behavior.

To reproduce, copy each module and config into a fresh repository scratch directory, including the RR5 dependency. With an explicitly approved installed Java executable and TLC jar, run `"$JAVA" -XX:+UseParallelGC -cp "$TLC_JAR" tlc2.TLC -workers 1 -config Fix4Ownership.cfg Fix4Ownership.tla`. Repeat with each unsafe config. Safe exits zero; invariant controls exit 12. Do not install tools, weaken safe invariants or overwrite prior evidence.

## Behavioral checks and mutants

Five new tests were written and run before production changes; all five failed on the unchanged implementation. Every test has a `// Why:` note. On the implementation, the five-file runner suite passed 71/71. An initial integration run exposed an existing legacy successor simulation; the new stale-ownership check was restricted to managed runs, preserving legacy behavior without weakening the new tests.

`node scripts/workflow_runner_mutation_controls.mjs` kills all fifteen isolated source mutants, including five new controls matching the new model guards: ownership-release, ownership-transfer, ownership-generation, ownership-effect and ownership-reconcile. Each new mutant fails its focused behavioral test. The ten earlier controls also remain killed. Copies and fixture repositories use registered teardown. Full scratch logs remain local; these counts are not a full repository gate or CI result.

## Limits

The composition interleaves atomic ownership and RR5 actions; it does not model byte-level filesystem schedules, host authentication, arbitrary generations or infinite runs. Physical lock concurrency remains covered only by the existing abstraction and sampled runtime schedules. Trusted terminal readback cannot revoke already-issued external work; a host must enforce generation fencing at its own dispatch/effect boundary. The library publishes decisions, not actual worker effects. No live worker, real terminal readback adapter, universal enforcement or procedure adherence proof was exercised. The existing history cap still applies to new ownership operations. CLI/Pi ownership and handbrake-off remain unavailable.
