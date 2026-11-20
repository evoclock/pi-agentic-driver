# Recurrence guards: bounded model and implementation checkpoint

Production guards are implemented in this draft. Final-head verification and CI
remain incomplete; this is not a readiness claim.

## Current follow-ups

The 22:05 audited budget transition now separates native proof into a 40-minute
CI job and sets its aggregate supervisor to 2400s. The observed 1586.978s run has
33.9% headroom under the unchanged 25% formula. The merged shared CI job already
had a 45-minute outer timeout; earlier reports carrying forward 25 minutes were
incorrect. See [BudgetTransition.md](BudgetTransition.md) for the pre-change
model comparison, corrected arithmetic, exact-file allowance and fresh-lease route.

Main #231 is merged: native gates consume its live fetched-base and loader
classification checks. Both sides' mutation contracts and caps were retained.
Pre-push runs fast freshness, inventory and added-term guards plus the complete
CI implementation set directly; the separate review token policy is unchanged.
Root Node cases run serially here after a parallel full-suite run observed a
TLC standard-module extraction error. No test is omitted or softened.

The owner-delegated 20:55 decision selects the existing outward-effect adapter,
not the obsolete `.githooks/pre-push`, as the checked-head push boundary. Every
new adapter push runs `make test-gate` and `make pre-push` asynchronously on the
requested clean commit, checking HEAD and branch before and after each command.
The pre-push target recomputes all root Node tests and the rules-defined Python,
Janus and other implementation suites, including requirements added by a main
merge. Already observed remote effects remain observe-only; they are not replayed.
This does not intercept independent shell pushes or update an installed Pi process.

Java discovery probes JAVA, local Java, keg-only Homebrew Java, then PATH Java.
A macOS launcher stub is skipped. TLC uses TLA2TOOLS (retaining TLA2TOOLS_JAR
compatibility), then the local jar; missing tools fail with repair paths. Review
preflight and native/shared gates consume the same discovered tool environment.

The 21:10 staged-input addition permits a reason-required strict superset of
locked inputs. Each new test file must independently prove fail-first on base.
The successor lock retains immutable predecessor files, verifies their hashes,
and appends added input names and contracts to refresh history. Removal, cap
changes, weakened contracts, ambiguous predecessors and unproven additions stay
blocked. Ordinary baseline/check phases do not gain a refresh exemption.

Before these last additions, full native verification passed in 1324.659s and
the shared gate passed in 162.5s. Full suites reported Node 1706 passed/11 skipped
and Python 162 passed. Those observations do not cover later adapter or expanded
refresh changes; final-head verification is required again.

## Scope and assumptions

`RecurrenceGuards.tla` models edit, baseline, gate run, push, CI and review.
R1 abstracts recorded runtime versus cap as a headroom predicate; R2 abstracts
successful tool probes; R3 abstracts the complete added-line scan, including
tests; R4 rejects unchecked control drift while allowing proved additive-only
refreshes; R5 checks
freshness at review admission. R3 and R5 implementations belong to #230 and
#231 respectively. The argument-override control specifically breaks R5 without
implementing either #231 fix here.

Two workers share a FIFO gate in the serialized configuration. Enqueue and
visible reporting are atomic: queue membership provides a position and report
membership represents publication of holder/start/estimated-wait information.
The holder's start is represented by an acquisition marker and its elapsed
runtime by a bounded counter, not a real wall clock. At the cap, a tick releases
the holder. This assumes a functioning external timeout supervisor and clock;
it does not prove that a hung OS process will be killed. No fairness or eventual
service claim is made. Time can stutter, so runtime safety is not a liveness
proof. A wait estimate would be remaining holder cap plus preceding queued
workers' caps, not a promised completion time.

The separate configuration eliminates the shared queue. It proves only that
shared-lock interference disappears; each slot still needs its own timeout and
resource-isolation checks. It is not evidence that removing the existing
machine-wide lock is safe on this host.

## Reproduction

Set `JAVA` to a working Java executable and `TLA2TOOLS` to a TLC jar outside the
repository. For each adjacent `RecurrenceGuards*.cfg`, run:

```sh
"$JAVA" -XX:+UseParallelGC -cp "$TLA2TOOLS" tlc2.TLC -workers 1 \
  -metadir ".scratch/recurrence-tlc/$name" -config "$cfg" \
  docs/design/verify/RecurrenceGuards.tla
```

Current model results are in `RecurrenceGuards-results.json`: the guarded graph
has 992810 generated / 208998 distinct / zero queued states; the separate-slot
graph has 30950 / 12294 / zero. All eighteen unsafe controls exit 12 on their named
invariants. Negative configs use the registry's `-unsafe-` naming convention;
the allowlist is unchanged.

The model now invalidates inventory and implementation-test samples when main
adds requirements or a new model is added. Targeted merge/new-model controls
first establish a checked old head, then demonstrate that stale samples cannot
justify pushing the new head. Additive refresh retains old contracts and caps,
records the new set and requires fresh fail-first proof and a reason. Controls
for removal, cap changes and unproven refresh each violate R4. Frozen inputs
abstract original inputs, added contracts and added test files as separate set
members. New-input-proof and removed-input controls independently violate R4.

Initial-model observations below are retained as historical evidence, not current
state counts. Observed with TLC 2.19 and Java 27.0.1. Counts are generated/distinct/queued;
negative runs stop at the first counterexample and do not exhaust their graph.

| Config suffix | Exit | States | Violated invariant |
| --- | --- | --- | --- |
| guarded (no suffix) | 0 | 3778 / 1326 / 0 | none |
| separate | 0 | 78 / 78 / 0 | none |
| R1 | 12 | 225 / 201 / 131 | NoRunWithoutCapHeadroom |
| R2 | 12 | 289 / 249 / 155 | NoGateWithMissingTool |
| R3 | 12 | 321 / 273 / 167 | NoAddedBannedTermAnywhere |
| R4 | 12 | 129 / 129 / 95 | NoConfigChangeAfterLock |
| R5 | 12 | 2349 / 1045 / 227 | StaleNeverReviewed |
| R6 | 12 | 34 / 34 / 32 | VisibleBoundedLock |
| override | 12 | 2397 / 1061 / 228 | StaleNeverReviewed |
| runtime | 12 | 1692 / 882 / 283 | VisibleBoundedLock |

## Test-first checkpoint

The initial four conformance cases failed by assertion in the native baseline,
with zero errors. An audited, unchanged-configuration refresh added FIFO ticket
registration and a real bounded subprocess control: six base assertion failures,
zero errors, followed by six passing head cases. Three further cases cover
native pre-execution rejection and real holder/queue reporting; all nine pass
locally. Their audited refresh was blocked after origin/main advanced because
the old branch did not contain newly added upstream tests. That is not a pass.

The two new mutation entries were authored before baseline; inherited entries
remain intact. Public runner pins are updated as exact source observations,
not bypasses; they require fresh native evidence along with the implementation.
The original lease and its generated evidence are retained. Bringing in main
also changes upstream control configuration, so the continuing verification
must use a fresh lease rather than editing or discarding old baseline locks.

Native baseline waits for the active machine-wide gate run; the lock is not
stale. The owner identifies its holder as the #231 worker in slot 23 and has
provided its start and process details out of band. The directory itself
publishes no holder metadata, FIFO queue or runtime cap. Queue position and
expected wait therefore remain unknown; directory modification time is not a
verified holder start. A background waiter polls every 60 seconds, acquires
only after normal release and then runs the native baseline. It never removes
another holder's lock. R6 will add role, slot, PID, start time, a FIFO queue and
pre-block reporting to the repository-owned lock protocol. No existing holder
metadata or generated fail-first evidence was changed.

Dependency installation completed at root and in Janus. Janus reports one low
severity audit finding; dependencies were not changed to repair it. The initial model/test checkpoint is published as draft PR #232. The first
native check was terminated by the new supervisor's initial 600s whole-run
bound. Inspection distinguished the shared gate's existing 600s speed budget
from the native verifier's existing per-command caps: the inherited serial
mutation verifier had no previous aggregate supervisor. The new native aggregate
bound is 1800s; the shared budget and all existing native command caps are
unchanged. This is a new finite supervisor, not an argument override. A complete
native pass is still required. Shared gate completed in 160s with one failure:
the public runner digest pin, subsequently updated. No green CI is claimed.

## Implemented guard path and limits

Use `make test-gate` and `make gate`: both now enter the observable FIFO lock
and supervised subprocess path. For the audited test-only refresh, use
`python3 scripts/gate.py --native-phase refresh --reason "explain the change"`.
The low-level `scripts/test_gate_runner.py` remains a verifier used inside the
supervisor and by isolated fixtures; invoking it directly does not acquire the
new machine lock. External callers must adopt the make/wrapper entry point.
No existing active holder is migrated or modified.

R1 checks recorded shared-step runtimes against both the total budget at
preflight and the remaining budget immediately before each step. Native command
observations are separated by phase and mutation target; a fast mutant cannot
replace a slow head measurement. Aggregate baseline, refresh and check histories
also have separate names. An absent history permits a first bounded measurement;
it is not evidence of 25% headroom. Malformed known observations fail before
execution. A reviewed cap/configuration change requires a fresh lease and full
native baseline with the original attempt preserved; refreshing test hashes
never changes frozen control configuration.

R2 consumes #230's required-tool roster rather than duplicating that inventory,
and probes real Java availability and runnable Janus tools before starting a gate. Linux Buildkite probes additionally name its
container/pipeline utilities. Native commands independently refuse absent
executables before execution. R4 compares prior locked control hashes even when
the selected base changes. R3 consumes the merged #230 implementation; R5 remains
dependent on #231, not reimplemented here.

R6 serializes only the existing machine-wide gate resource; checkout evidence
and snapshots remain per-slot. Queue tickets use a short, bounded registration
critical section and monotonic sequence numbers. The holder publishes role,
slot, PID, acquisition time, cap and queue directory. Waiters print holder data,
FIFO callers, position and a cap-based wait estimate before each 60s sleep.
Anonymous existing holders are reported as unknown, not guessed. Only the
caller's own ticket and acquired lock are removed. Waits stop after 1800s without
stealing a holder; timed-out commands receive process-group termination and a
bounded kill grace. Crash recovery and forced lock replacement are not proven.
The TLA+ model assumes a functioning timeout supervisor; it does not establish
full implementation correspondence or safety of removing host serialization.

## M1: owned descendants before admission release

The executable conformance invariant is **lock released => no owned process alive**.
`tests/test_gate_owned_cleanup.py` runs the real lock and supervisor in isolated
Git repositories. Both timeout and SIGTERM-interruption cases start a leader
that exits promptly on TERM and a descendant that ignores TERM. At release,
the tests require no live process in the owned group and no delayed descendant
work. The focused mutation restores leader-only cleanup and must fail both cases.

Cleanup now gives the owned group a two-second TERM grace independently of
leader exit, escalates any surviving group to KILL, reaps the leader and waits
for group disappearance before returning to the admission context. Signals
never target another group. OS process-group membership and eventual signal
delivery/reaping remain assumptions, not additional TLC claims. Processes that
leave the owned session/group are outside this bounded group contract.

The original conformance gap was reproduced by reviewer Sol on81deb71 despite
green Buildkite632; those successes do not establish cleanup correctness. The
new real-process tests fail by assertion on that implementation. A reasoned
strict-superset native refresh independently proved the added test file and
appended its single contract, preserving earlier locks/configuration and caps.
No old verification result is relabeled as proof of the correction.

## Historical verification blocker (superseded by later PR evidence)

Main was brought in with a non-rebasing merge to consume #230, preserving every
upstream mutation contract unchanged and appending only the two recurrence
contracts. A fresh verification checkout is required for the changed upstream
control configuration; the prior baseline and attempts remain untouched.
Treehouse refused allocation because all 16 worktrees are in use or dirty.
No other worker's checkout was recycled and no pool limits were changed.

Focused head checks pass: nine recurrence cases, 22 public-sync cases and ten
observer cases. The final upstream-roster/Java/Janus preflight also passes on
this host. These focused checks do not replace native baseline or mutation
verification. Buildkite is not green; its CLI also reports no stored credentials
for the pipeline organization, so detailed job logs were not retrieved.
R5 still depends on #231. Final-head review remains outstanding.
