# Parallel scheduler

Repository-host API: `ParallelScheduler` in `lib/parallel-scheduler.mjs` and
`createTreehouseScheduler` in `lib/parallel-scheduler-treehouse.mjs`. No worker is
started merely by importing either module. No raw Herdr launch path is added.
These repository modules are not added to the npm package's explicit file list;
this change does not alter the installed extension or enable unattended rollout.

## Manifest and host boundary

Each task declares `id`, nonempty repository-relative `touches` paths/globs,
`dependsOn` task IDs and `resources` names. Both arrays must be explicit, including
when empty. The constructor lints identity, dependencies and cycles before any
lease acquisition, then canonicalizes resource names to lowercase. `VM` and `vm`
are the same exclusive resource. A directory write set is `src/**`, not `src`.

The host supplies its repository root, configured **pool-wide** cap (including
foreign occupants), base, branch prefix, lease holder, report callback and existing
guarded dispatch callback. The callback receives the task and verified lease path;
it must enforce the existing assignment/worker-authority boundary and spawn in that
exact leased checkout through the guarded lifecycle. A manifest is not permission.
Do not pass a raw shell worker launcher.

```js
const scheduler = createTreehouseScheduler(tasks, {
  root, cap, base: 'main', branchPrefix: 'stream-', holder,
  dispatch: guardedDispatch, report: showSchedulerStatus,
});
await scheduler.tick();              // dispatch every independent ready stream
// On host PR/capacity observations:
await scheduler.merge(taskId);       // verify exact PR head, return exact lease
await scheduler.tick();              // fill newly available capacity
// Explicit owner decision after an exact closed-unmerged observation:
await scheduler.abandon(taskId);     // return lease; never satisfy dependencies
```

The host invokes `tick` again on capacity/PR observations; a full pool is a
`waiting-for-slot` event, not an error or a busy loop. No cloning or slot-cap
configuration changes are performed. Acquisitions use Treehouse's native durable
lease and sibling Git/common-directory readback. Branch names derive from the
host prefix plus validated task IDs. External pool occupancy counts against cap.
Treehouse's own allocator remains authoritative for concurrent acquisitions.

Return independently verifies the exact repository owner, head branch, configured
base branch and current 40-character head in the observed PR. Merge recycling
requires a valid merge timestamp. Owner-invoked abandonment instead requires an
exact closed, unmerged PR with a valid close timestamp. Both recheck identity and
head, require a quiet clean worktree, conditionally return only that lease ID/holder
and observe release. Wrong-base, open, dirty, active, moved or foreign work remains
held; a missing PR never authorizes abandonment. The host
must arrange worker exit before recycling; this module never sends keys or closes
a worker tab. A dispatch exception is uncertain delivery: retain the reservation,
stop and inspect; never resend automatically. A tick always drains every started
delivery in `finally`, including after an acquisition, validation or report error.
One `AggregateError` retains loop and delivery failures. Any known unrecorded lease
is named in that error and reported for inspection, even if reporting also fails.

## Reversible decision and state transitions

Selected: stable manifest order, conservative glob-prefix intersection and one
serialized scheduler owner. Exact glob-language intersection would improve
utilization but adds machinery; treating different wildcard spellings as disjoint
is unsafe. Hold is the alternative if verified host ports are unavailable. The
selected approach can serialize independent wildcard sets unnecessarily.

Transitions: `queued -> running -> merged|abandoned`. Either terminal state is
published only after verified PR outcome and successful return. Abandonment is an
explicit owner action; it frees conflicts/capacity but permanently blocks dependents
rather than treating an unmerged change as available. Failed returns preserve the
running reservation. Concurrent ticks on the same
instance serialize. One owning controller per pool is a deployment precondition;
this module is in-memory, does not provide cross-process locking or crash recovery,
and must not be re-created to replay uncertain dispatches. I1 `HostWiring` is a
named seam for a separate follow-up PR: no installed host drives this API yet.
I3 `DurableState` is a named recovery/ownership seam outside this change. Neither
installed activation nor unattended rollout is claimed.

## TLA+ and negative controls

`ParallelScheduler.tla` abstracts touch and exclusive-resource conflicts as a
symmetric `Conflicts` relation. The bounded instance has three tasks, one dependency,
one conflicting pair and two slots. A running task can `Merge` or `Close`; a closed
task can subsequently `Abandon`. Fairness covers dispatch, resolution to either PR
outcome and owner-invoked abandonment. The model no longer assumes every task
merges. Successful return and eventual owner participation remain environmental
assumptions, not host guarantees. Tasks are finite and spawn no new work. A
dependent of an abandoned task is intentionally not runnable. This is a bounded
proof, not a proof for arbitrary manifests or failed host effects.

Safety invocation from repository root:

```
tlc -workers 1 -metadir .scratch/parallel-scheduler/v2-safe \
  -config docs/design/verify/ParallelScheduler.cfg \
  docs/design/verify/ParallelScheduler.tla
```

`make preflight` now always runs `tests/parallel_scheduler_liveness.mjs` through
`tests/helpers/tlc.mjs` with `TLC_REQUIRED=1`. It requires the fair-liveness config
to exit 0 and the sole-property starvation negative to exit 13 with a temporal
counterexample. Missing tools fail; nothing silently skips. The dedicated required-
TLC suite is separate from ordinary fake-only Node tests and the network-isolated
acceptance environment. A focused ordinary test and mutant enforce its preflight
connection. Run preflight with working Java and an installed jar supplied through
`JAVA` and `TLA2TOOLS` or `TLA2TOOLS_JAR`.

The repository registry requires a named temporal diagnostic, but TLC emits only
`Temporal properties were violated`. Its matcher remains unchanged. Both configs
check only `NoStarvation` as their temporal property; the safe one also checks all
five invariants. All **five invariants** remain registered and run in preflight,
including an additional abandonment-return negative for `NoLeakedLease`.

Observed safe and liveness results after adding Close/Abandon: exit 0,
289 generated / 193 distinct states, depth 9; temporal checks finish without error. All-merged
terminal states intentionally stutter; deadlock checking is disabled in safe
configs, not safety/liveness checks.

| Unsafe config suffix | Exit | Intended result |
| --- | --- | --- |
| overlap | 12 | NoOverlapRunning violated |
| deps | 12 | DepsMergedBeforeStart violated |
| unique | 12 | LeaseUnique violated |
| leak | 12 | NoLeakedLease violated |
| abandon-leak | 12 | NoLeakedLease violated after Close/Abandon without return |
| cap | 12 | SlotCap violated |
| starve | 13 | temporal counterexample to sole property NoStarvation |

Complete local logs live under `.scratch/parallel-scheduler/`; generated states
are not committed. The requested statechart skill is unavailable; the model was
authored manually using the decision-gate fallback. No model result authorizes a
host action.

## Tests and G8 seam

Seventeen ordinary fake-only tests drive real modules through bounded start/merge
and Close/Abandon transitions. They cover both merge completion orderings under
eager stable dispatch and explicit abandonment with a blocked dependent. All five
model invariants are checked at relevant observation points. This is a refinement
of nondeterministic model starts, not generated replay of every TLC state.

Host tests cover configured-base binding, exact closed-unmerged identity, quiet
returns, full-pool races versus uncertain acquisition, and foreign occupants.
Error tests combine delivery failures with later acquire, duplicate-lease and
report failures, assert delivery settlement, retain reservations and locate the
unrecorded lease. No real worker or task lease is dispatched.

`checkDeclaredTouches` is the named G8 seam. Pass every changed path, including both
sides of renames. `requireG8TouchGate` throws if the integration is not supplied;
the test asserts that missing wiring fails and undeclared paths fail. Real G8
wiring stays with its owning change until that lands; no G8 enforcement is claimed
before it calls this seam. Git-relative paths and wildcard spelling are validated;
resolved filesystem/symlink containment remains the guarded host's responsibility.

Eight additive scheduler mutants cover conflict exclusion, merged-head return,
base binding, abandoned lease return, closed-PR verification, delivery draining,
resource casing and required liveness wiring. Existing mutation entries and caps
remain unchanged. Review regressions were observed red against the implementation
before fixes. Their tests and additive contracts were committed before a fresh
native baseline against merged main; it recorded assertion failures with no loader
errors. Earlier locks remain untouched. The initial old lock copy remains under
`.scratch/parallel-scheduler/prior-lock/`.

## Review recurrence coverage (F1–F23)

The per-finding F1–F23 map and its explicit deferrals remain in the
[existing finding map](../verify-recurrences.md#finding-map); this change does not
claim to close its deferred credential, parser or claim-conformance work. F3/F18
add five named scheduler safety controls; F7 adds this scheduler design; F21 adds
observed local evidence in the PR; F22/F23 retain native test-token preservation
and current-main ancestry checks. Other findings retain their mapped checks or
explicit deferrals unchanged. Scheduler-specific tests add manifest validation,
conflict/cap trace assertions, verified lease/merge readback and fail-closed G8
seams. Cross-process/crash recovery, installed extension packaging and actual G8
wiring are deferred integration work, not implied by the bounded proof or fakes.
