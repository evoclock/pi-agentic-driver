# Host-observed procedure checks (draft)

This slice adds a host observation protocol, not proof that a worker followed a
skill. It does not dispatch workers or build the planned central MCP service.
The host observer's honesty, executable provenance and same-user isolation are
not proved by the model. Existing same-user store limitations still apply.

## Frozen requirement

A step may declare:

```json
"procedure": {"schema":"pad-procedure.v1","checks":["git-diff-check.v1"]}
```

The requirement is part of the workflow contract digest frozen at activation.
The first and only supported command id invokes the host's Git executable with
fixed argv: `diff --no-ext-diff --no-textconv --check BASE COMMIT`. It checks the
exact candidate commit against the dispatch base, not mutable uncommitted bytes.
There is no shell, worker-provided command, executable name or argument template.
Execution has a 10-second timeout and 64-KiB output capture bound. Only exit
status and a SHA-256 output digest are retained, never command output text.
Failure, timeout, signal, malformed results and unsupported command ids do not
verify. The check detects whitespace errors; it is not a general quality gate.

A `procedure` event invokes the host adapter. Event JSON cannot supply its
observation. The adapter is trusted host code, like existing acknowledgement and
readback adapters; an arbitrary caller replacing that code is outside the threat
model. Synthetic test adapters exercise refusals without a live worker.

Each accepted observation binds task id (derived from the actual store), step,
epoch, writer, dispatch id, candidate commit, input digest and requirement digest.
The input digest covers frozen workflow digest, dispatch base, branch, step and
candidate commit. Evidence identities are one-use across new events in the run;
a repeated event id returns the journaled result without invoking or consuming
again. The existing 1,024-event cap bounds retained identities. Missing, foreign,
stale or reused observations fail closed. Owner halt fences proof publication.

`procedureVerified` refers only to these declared host checks on that observed
input. `deliveryAcknowledged` is separate and never establishes procedure
verification. Git receipt verification remains independent: when a step declares
a requirement, advancement needs both a valid Git receipt and a host observation
for that exact receipt commit. A check on an earlier candidate cannot advance a
later commit. Workflows without this optional requirement retain artifact-only
behavior, with procedure verification false. CLI supports the new event; the Pi
facade has not yet been extended in this slice.

## Model-first evidence

`Fix4RunnerProcedure.tla` is a bounded refinement of the dispatch/result boundary,
not a replacement proof for filesystem locking or the full runner. Its finite
observations vary task and epoch; other tuple dimensions remain fixed. It models
two evidence identities and reuse under another event. Duplicate-event readback
is quiescent and consumes no additional identity. No liveness is asserted.

The safe configuration checks `TypeOK` and `NoUnboundProcedure`: no verified step
without a current matching host observation. It completed with **52 generated,
19 distinct states**, depth 6. The unsafe configuration changes only
`BindingGuard` to false, preserving both invariants. It violates
`NoUnboundProcedure` after Observe → Verify using epoch 2 evidence for epoch 1:
**24 generated, 17 distinct states**. Outputs are `tlc-procedure-safe.out` and
`tlc-procedure-unsafe.out`; paths are redacted. These checks ran before runtime
implementation. The unchanged Fix4Runner baseline also passed with 6,163 distinct
states. The model does not prove the observer's honesty or actual Git execution.

Tests exercise every runtime binding dimension, missing/failed/incomplete checks,
reused evidence, duplicate-event invocation count, real host command success and
failure, candidate changes, CLI execution and owner cancellation during the
observation. Four new isolated source controls kill removal of binding, one-use,
success-status and advancement guards. Gate acceptance and CI must still be
recorded on a delivered head; targeted tests and TLC alone are not acceptance.

## Remaining work

This is not a live-worker demo. Pi procedure-event exposure, guarded dispatch,
full adapter integration, Release/Transfer/ReconcileOld and installed fresh-process
verification are not claimed here. Unknown worker effects must remain parked,
not resent. The planned central PAD MCP service can own the same host observation
and versioned task/epoch bindings; no service, remote lease or caller/owner
confirmation mechanism is introduced here. See `runner-status.md` for inherited
limitations; its earlier always-false description predates this draft slice.
