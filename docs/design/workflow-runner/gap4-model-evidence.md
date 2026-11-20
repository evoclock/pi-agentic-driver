# G4 authority model evidence

The standalone `Gap4Authority.tla` isolates the external authority trust boundary. Extending Fix4Runner would mix its authenticated-cache assumptions with the deliberately hostile cache in this model. Existing Fix4Runner invariants are unchanged.

Checked with TLC 2.19 and the existing Java installation. Each config was copied with the spec to an ignored `.scratch/workflow-runner/gap4-run/pending-cancel/<config>/` directory. Run there with `java -XX:+UseParallelGC -cp <TLA2TOOLS_JAR> tlc2.TLC -workers auto -config <config>.cfg Gap4Authority.tla`. Raw output is not tracked. Counts below are observed, not estimates. Concurrent TLC workers can change counts before a first counterexample.

| Config | Generated | Distinct | Result | Violated invariant | Trace transitions |
|---|---:|---:|---|---|---:|
| Gap4Authority | 298777109 | 14271032 | PASS | None | n/a |
| unsafe-anchor | 112817 | 12527 | FAIL (expected) | CancelDurable | 7 |
| unsafe-cas-conflict | 4139 | 690 | FAIL (expected) | LeaseFenced | 5 |
| unsafe-daemon-restart | 308 | 116 | FAIL (expected) | ReplayIdempotent | 3 |
| unsafe-local-durability | 14257 | 1997 | FAIL (expected) | CancelDurable | 5 |
| unsafe-lost-reply | 3013 | 549 | FAIL (expected) | CancelDurable | 3 |
| unsafe-partition | 638 | 166 | FAIL (expected) | LeaseFenced | 3 |
| unsafe-pending-cancel-dropped | 557 | 146 | FAIL (expected) | PendingCancelSurvivesRestart | 2 |
| unsafe-replay | 865 | 208 | FAIL (expected) | ReplayIdempotent | 4 |
| unsafe-stale-restore | 333 | 109 | FAIL (expected) | EpochSeqMonotonic | 3 |
| Fix4Runner.cfg safe | 49255 | 6163 | PASS | None | n/a |

Every authority config checks TypeOK, CancelDurable, NoEffectAfterAuthoritativeCancel, NoAdvanceOnUnknownEffect, ReplayIdempotent, EpochSeqMonotonic, LeaseFenced and PendingCancelSurvivesRestart. All ten configurations were rerun after adding client crash/restart, because the new interleavings affect existing witnesses. Each unsafe config switches exactly one guard off. The safe authority graph has no invariant violation; its scope is the bounded abstraction, not deployed runtime correctness.

## Mapping and limits

One task and two effects suffice to exhibit rollback and unknown-effect blocking. Six immutable request identities represent two competing claims, cancel, two effects and one settlement. Sequence and epoch are bounded at four committed mutations. The authority owns cancel, request results, lease and effect outcomes. `acknowledgedCancels`, original responses and high-water marks are specification ghosts outside attacker reach. The writable journal/checkpoint retain only the cancellation fact needed for the rollback witness, not serialized bytes or HMACs.

`Send` captures the client epoch, sequence and lease. `ReadEpoch` may interleave before admission; CAS uses the captured body. `CommitCancel`, `CasAdmitClaim`, `CasAdmitEffect` and `CasSettle` linearize commits. `Acknowledge` is separate. `DropReply`, `Replay` and `DuplicateDelivery` cover lost replies and at-least-once transport. A single retained request/reply slot abstracts duplicated network messages; it does not prove arbitrary concurrent RPC scheduling. `Refuse` may park without mutation; liveness is not claimed.

Claims check whether an existing lease has expired before admission; `LeaseExpiry` models lazy clearing on an attempted call. `LeaseLive` checks authority time at every effect and settlement. Claims issue a fresh epoch/lease; time has one expiry boundary. `DaemonCrashRestart` invalidates the old lease and retains durable requests; a later claim can establish a new lease. The restart control drops request records, immediately violating the retained-original-response portion of ReplayIdempotent. The durability control acknowledges cancel before fsync, then loses volatile state. Restore attempts below current sequence/epoch stutter when guarded and rewind when unguarded.

With AnchorGuard disabled, RestartReplay promotes the rolled-back cache to the cancellation authority. This intentionally models the old in-store-only design, not a remote API capable of clearing cancel. DeleteCheckpoint and TruncateJournalToPrefix affect no authority state in the safe model. PartitionGuard disabled permits a local effect without an authority admission, violating LeaseFenced. CasGuard disabled admits a stale competing claim. LeaseFenced includes CAS and authoritative admission as well as live lease fencing.

## Pending cancellation and client restart

The earlier model had no client crash action and therefore missed loss of a volatile pending owner cancel. `AcceptOwnerCancel` now allocates the immutable cancel request ID (abstract ID 3), records the accepted intent ghost, and saves the full abstract request body in durable `pendingCancels` before submission. `ClientCrashRestart` discards volatile client observations and in-flight slots but retains the outbox and saved body. `SubmitPendingCancel` restores that body and original ID, including after restart. The model bounds client restart to one occurrence while a cancel is pending; it makes no liveness promise under permanent partition.

`PendingCancelSurvivesRestart` requires every accepted cancel to remain committed or durably queued after restart, with submission IDs drawn only from accepted IDs. Disabling only PendingSaveGuard yields `AcceptOwnerCancel -> ClientCrashRestart`, violating that invariant. The safe model checks the new invariant together with all existing invariants.

The shared client requires `stateDir` for cancellation/admission. It fsyncs an immutable per-request pending file, publishes it atomically, and fsyncs the directory before the first submit. Newly created directory entries are also fsync'd. Restart loads every pending request in the task namespace. Status/read operations retry the queue with original bodies; `retryPendingCancels()` is also explicit. No new effect is admitted while the queue is nonempty. A record is removed and the directory fsync'd only after authoritative success. Missing or failed local durability refuses acceptance instead of silently using memory. CLI/Pi configure a repository-local client state directory; the daemon worker must run the same restart contract against backend A.

This covers normal crash/restart, not hostile same-uid deletion of the pending store before authority commit. Such a cancel was never acknowledged as durably committed at the authority. The filesystem fsync protocol assumes normal filesystem durability semantics; tests do not simulate power loss or prove device firmware behavior.

## Runtime checks

The fail-first client run observed 22 assertion failures before the interface/remote modules existed; tests were committed before implementation. Four core regressions then failed against the old core before wiring, including the real filesystem rollback. Additional focused fail-first runs exposed claim expiry and an externally advanced client epoch. Before the pending-outbox extension, the targeted `node --test tests/test_workflow_runner*.mjs` run observed 111/111 passing: core/cache 40, shared authority 13, authority/core integration 6, remote authority 10, crash/lock 9, attribution/readback 15, model conformance 7, procedure 7 and CLI/Pi tools 4. The standalone mutation runner then killed all 13 controls. It copies current dependencies and explicit synthetic authorities; the obsolete pre-authority halt-only mutant is replaced by a failed-admission mutant because cancellation is now independently fenced by the authority.

The pending-cancel extension was committed fail-first as `9905cd3`: 18 shared tests observed 14 passes and four assertion failures before implementation. The failures cover fake and remote-HTTP restart, a missing durable store, and a failed store write. The updated shared suite then passed 18/18, including an explicit fake-authority TENANT_MISMATCH refusal with no retry. At the pending-outbox implementation head, the full targeted suite passed 116/116 (shared authority now 18, all other counts unchanged), and all 16 isolated mutation controls were killed. The exact official check ran under the shared gate lock and returned BLOCKED / exit 3 because the independently advanced base contains `tests/test_workflow_runner_ownership.mjs`, absent from this prescribed pinned-base branch. No fail-first lock was edited to bypass that result. This is an integration blocker, not a safe-model failure; Buildkite and mergeability must be observed separately.

No real authority host, token, daemon, service account or worker is used by these tests. Official gate and CI outcomes must be recorded separately for their checked heads.

This model excludes owner/root compromise, authentication/tenant validation, request-body hashing, actual fsync implementation, arbitrary retention lengths and physical effects that were admitted before cancellation. Cancellation prevents new admission; it does not undo an already-admitted physical effect. A model pass is not proof about the HTTP server or local daemon implementation. Runtime tests must exercise the same failure boundaries.
