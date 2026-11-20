# Guarded local worker dispatch (draft)

This slice is stacked on the host-procedure-check change. It adds a real adapter
path, not evidence of a live worker demonstration or a central service rollout.
Retarget the stacked pull request to main after the lower change merges.

## Contract and entry points

A step may additionally freeze a worker route:

```json
"worker": {"schema":"pad-worker.v1","role":"synthetic-worker",
  "model":"synthetic-model","repository":"synthetic-repo"}
```

An optional workspace selects an existing guarded workspace. Only local Pi
workers are supported. The destination is the workflow's exact repository path;
the existing spawn boundary must independently accept its canonical repository,
model, owner eligibility and Treehouse lease. The workflow declaration does not
grant spawn authority. Unsupported kinds, routes or native confirmation needs
remain unavailable or parked; there is no fallback terminal path.

First activate with the existing run/tick entry. Then submit a `dispatch` event
through the same CLI `run` command or `agentic_workflow_dispatch`. The latter is
a separate sequential, model-only tool. Pi tick now also exposes the host
`procedure` event. Delivery observation uses `type: "delivery"` through the
dispatch entry, not a retry loop. CLI effects require the workflow's current
checkout as the process working directory. Owner cancel/hold rules are unchanged.

`pad-worker-kind-adapter.v1` exposes local host/kind identity plus `spawn`,
`submit` and `delivery` methods. Pi calls existing guarded tools through
`ctx.executeTool`, preserving validation and hooks; missing nested execution is
`capability-unavailable`. The CLI calls the same exported guarded PAD lifecycle
and communication implementations. It does not invoke raw terminal commands.
No native UI, model selection, account binding or authority receipt is faked.

## Durable effects and observations

The reducer records the step's route, adapter revision, local host/kind, branch,
base, writer, epoch, task and dispatch id before external effects. A dispatch
requires a defined frozen host-check contract, not a successful check on an
artifact which does not yet exist. It also requires unchanged dispatch input.
The claim persists its input/requirement tuple before spawn. A second persisted
claim precedes prompt submission. There is no lock held across asynchronous
worker execution, no background poller and no retry of a claimed effect.

A duplicate event reads the old result but never calls the driver again. Another
event cannot claim the same effect. Throws, partial starts, wrong-target receipts,
missing confirmations and lost replies park with the original claim retained.
A crash after claim but before the actual call also parks conservatively: this
slice does not reconcile a confirmed-absent worker for retry. Generic absent
readback cannot clear a claimed worker intent. No automatic close or resend.

Spawn readback must match the declared role and exact destination; pane identity
is retained. Submission retains the delivery id. Independently queried, correlated
answered delivery readback can set `deliveryAcknowledged`, never
`procedureVerified`. Reports do not directly advance the workflow. Git receipt
checks and host procedure checks from the lower change remain separate gates.

## Model and conformance

`Fix4RunnerDispatch.tla` is a finite local effect-boundary refinement, not proof
of the full runtime or transport. It ran before implementation. The safe model
checks TypeOK, DispatchHasRequirement and NoBlindResend: 35 generated / 16 distinct
states. Each new unsafe configuration disables exactly one guard, retaining all
invariants. RequirementGuard off violates DispatchHasRequirement (38 generated /
18 distinct). OnceGuard off permits Claim -> Spawn -> Crash -> Claim -> Spawn,
violating NoBlindResend (67 generated / 32 distinct). New sanitized outputs are
`tlc-dispatch-v2-*.out`; earlier raw exploratory outputs remain in scratch.

Fake-driver tests cover persisted claims before calls, duplicate/new-event
replays, missing requirements, crashes, partial/foreign receipts, stopped epochs,
foreign observations, changed input, separate delivery acknowledgement and the
actual Pi tool callback's nested guarded route. A CLI fixture enters the dispatch
surface only after a durable stop, so no test or mutant can spawn a live worker.
Each changed test has a Why note. Exact source mutations cover requirement,
one-use, duplicate, input and observation binding, and wrong-role receipt guards.

The older standalone mutation helper now copies its full module dependency set
and requires an unmutated passing behavioral test before running each mutation.
Without this, missing imports could falsely look like killed mutants. Earlier
helper kill counts after module extraction must not be treated as valid evidence.
Its halt pattern now names the current publication boundary. No saved baseline or
fail-first lock was edited to obtain these checks.

## Compatibility and open limits

The adapter keeps task/input/requirement/writer/epoch/dispatch and local host/kind
fields suitable for a single central PAD authority. It does not build the proposed
MCP option B service, remote host leases, client enrollment, owner signing, writer
transfer or remote effect fencing. Internal reducer events are not public MCP
operations; future adapters must enforce independent owner confirmation.

The model assumes honest local adapters and atomic checks. It does not prove
observer honesty, process execution, filesystem atomics, role stability through
handoff or safety against same-user state rewrites. A stop after the last local
check can still race an external effect. The guarded communication path resolves
the current role; this wrapper does not add an atomic pane-identity reservation
between spawn and handoff. These are limits, not new permission or a universal
enforcement claim. Additional downstream fencing is required before remote or
cross-host effects.

Default communication delivery snapshots are process-local. A fresh CLI process
may therefore observe an unknown delivery, which stays parked and is never
resent. Receipt ingestion remains explicit; this is not an unattended DONE loop.
Codex/other kinds, Release/Transfer/ReconcileOld, full procedure adherence,
installed fresh-process verification and a live worker demo remain unclaimed.
