# Decision: Linux execution

## Current decision: owner-selected B (implementation pending)

The owner superseded provisional A: deliver a reviewed Linux guest-check adapter **inside G8**. Attended use retains the real registered switch/TUI/confirmation; unattended use requires a scoped, time-bounded, revocable standing ledger grant instead of interactive admission. Both paths preserve the owner-configured payload and mandatory pinned containment killswitch. Missing capability or authorization yields `checks-runner-unavailable`, never pass. See [Decision: Linux execution (unattended)](linux-unattended-decision.md) for the later refinement and observed results. Full B transport is not yet delivered; an isolation proof is not executed exit checks.

[Adapter contract and evidence](linux-adapter-contract.md) records the refined model, negative controls and the exact native API extension requiring review. `Gap8LinuxAdapter.tla` refines the earlier decision: B safe is exit0, 44 generated / 22 distinct; five disabled guards each fail their intended invariant. This is conditional design evidence, not runtime proof or permission to widen the native tool.

## Superseded provisional A decision (historical evidence)

The earlier provisional choice was **A: park as `checks-runner-unavailable`**, with the adapter deferred to a separate follow-up. That limitation is no longer the delivery goal. The earlier model/config/output files below remain unchanged as historical evidence; the owner-selected B refinement is linked above.

## Options and boundary

- A: preserve the existing native microVM boundary and explicitly report unavailable. No guest command executes and no pass is possible.
- B: build an adapter inside G8. The model assumes separate owner review and native confirmation before execution. That is a hypothetical safe path, not authorization to build or invoke it in this change.
- Hold: retain the task without execution.

The existing `linux_microvm_cutover_pi.js` is a native-confirmed transient proof fixture with owner-configured payload, not an arbitrary check executor. No fake TUI, isolation switch, confirmation, replacement job payload or raw remote-shell path may substitute for a reviewed adapter. Actual checks must bind to the receipt checkout. Until that adapter exists, a healthy Linux host alone cannot make Linux checks available. Auto may select host when no isolated executor is available, recording that choice; an explicit Linux request never silently falls back.

## Model and results

[Gap8LinuxDecision.tla](Gap8LinuxDecision.tla) compares A, B and Hold. Invariants: TypeOK, UnavailableNeverPass, NativeBoundary, PassRequiresExecution, HoldNeverExecutes. `Settles` requires eventual park, hold or actual result under weak fairness. OwnerReview and Confirm are owner-only abstract assumptions in B; the model grants no permission.

Pi installed-only statechart adapter detection returned `available-not-run`. Each run used:

```text
PATH=<PREINSTALLED_JAVA_BIN>:<PATH> TLA2TOOLS_JAR=<PREINSTALLED_TLC_JAR>
node <STATECHART_SKILL>/scripts/run-tlc.mjs --spec .scratch/g8-linux-decision/Gap8LinuxDecision.tla --config .scratch/g8-linux-decision/Gap8LinuxDecision-<OPTION>.cfg --out .scratch/g8-linux-decision/run-<OPTION> --timeout-seconds 60
```

TLC 2.19, one worker; outputs sanitized as new evidence files. State counts below are generated / distinct / queued.

| Config | Adapter / TLC exit | Result | States |
| --- | --- | --- | --- |
| A | 0 / 0 | No error has been found; Settles holds | 3 / 2 / 0 |
| B | 0 / 0 | No error has been found; Settles holds | 11 / 7 / 0 |
| hold | 0 / 0 | No error has been found; Settles holds | 3 / 2 / 0 |
| unsafe-unavailable | 1 / 12 | Invariant UnavailableNeverPass is violated | 2 / 2 / 0 |
| unsafe-native | 1 / 12 | Invariant NativeBoundary is violated | 3 / 3 / 1 |

Outputs: `tlc-gap8-linux-{A,B,hold,unsafe-unavailable,unsafe-native}.out`. No safe invariant was weakened. A does not violate an invariant satisfied by B. Both are safe under their assumptions, but A requires no new execution boundary and is the chosen bounded route.

Coverage is deliberately small: A reaches requested/parked; Hold reaches requested/held; B reaches requested, adapter-reviewed, confirmed, unavailable park and both pass/fail results. Those seven distinct B states include both result values and parks before/after confirmation. The negative controls demonstrate the unavailable-pass and execution-before-review/confirmation paths are reachable when guards are removed. This is decision-level coverage, not proof of real guest execution, checkout transport, command confinement or cancellation.

## Enforcement and return path

`tests/test_workflow_runner_exit_linux.mjs` constructs a clean receipt checkout, requests Linux despite an injected healthy target, and requires an explicit unavailable observation, no pass, no results and zero executor calls. It checks the native boundary/config files and receipt checkout remain unchanged. Native fail-first baseline observed one assertion failure on base before implementation and locked this test. The focused head test passed (1/1). Two isolated scratch controls failed as expected: changing the unavailable verdict to pass, and invoking the native executor hook. These are local controls (2/2 killed), not the final fourteen G8 mutation contracts or an official check pass. The runner/CLI/Pi integration and remaining G8 checks are not yet implemented; no G8 PR may claim completion from this unit.

Resume the original G8 plan with this limitation: finish the exit gate, test all supported execution paths and safety properties, run the normal official gate and scans, and include this decision in the draft PR body. Do not describe Linux execution as implemented. Later adapter work must define checkout staging, argv/result binding, containment, cancellation and native confirmations before enabling it.
