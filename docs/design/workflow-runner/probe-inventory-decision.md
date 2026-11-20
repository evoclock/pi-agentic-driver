# Checked probe inventory

This tooling-only split precedes the exit-gate core and live-adapter work. It changes no runtime protocol or historical coverage exception.

## Decision

Reachability witnesses are a separate checked category, not passing safety configurations. Registry kind `reachability` requires a model's `*-probe*.cfg`, a `Never*` sentinel, and TLC exit 12 naming that invariant. Every discovered probe sentinel must be registered. Probes remain excluded from positive discovery and cannot satisfy safety coverage. Safety obligations still require their own `-unsafe*.cfg` controls.

`ProbeInventoryDecision.tla` (renamed from the working name `Gap8ProbeInventory` to avoid implying a runtime model) compares probe-aware checking, treating probes as positives, and dropping probes. Its three invariants are `NoUncheckedSentinel`, `NoWeakenedSafetyControl`, and `InventoryGreenOnlyIfAllChecked`. The five registered negative configurations cover both rejected choices and removal of each guard. No runtime probe files are renamed in this split.

The scheduler integration brought in a passing liveness config under a reserved probe filename. It is renamed byte-for-byte from `ParallelScheduler-probe-liveness.cfg` to `ParallelScheduler-liveness.cfg`, with the preflight liveness test updated to the new path. It remains a required passing TLC check. Positive discovery now inventories `NoStarvation`, covered by registering the existing sole-property `ParallelScheduler-unsafe-starve.cfg`; no model transition or checked obligation changes. Main-style probe configs without a `Never*` sentinel still fail validation. Probe discovery also recognizes later markers in model-owned names such as `Example-branch-probe-target.cfg`, using the same discovered set for entry validation.

## Temporal attribution

Real TLC emits an unnamed temporal violation. Attribution requires exit 13, the temporal-violation marker and an error trace, exactly one configured PROPERTY equal to the registered expected name, and no checked INVARIANT. Comments do not count. Repeated declarations, even of the same property, are rejected. Named-only diagnostic text without this evidence is insufficient.

This mechanical configuration/output predicate is covered by focused conformance tests rather than extending the decision model's abstract sentinel policy with a text parser. The recorded Settles trace fixture preserves the real counterexample excerpt; the test embeds its opening verbatim so the historical baseline does not fail because a new fixture is missing.

## Native mutation transition

The superseded `review-property-control-identity` contract required TLC to name the temporal property. The approved replacement `property-control-exit13-single-property` disables the sole-property identity guard and must fail the focused suite. `reachability-control-required` disables registration enforcement. Contract count: 112 before, 113 after (one replacement plus one addition). All unrelated contract text and settings are unchanged.

The replacement was installed before the host baseline, under the inventory-contract-replace decision. The audited workflow was `make test-gate TEST_GATE_PHASE=baseline`, followed by `python3 scripts/test_gate_runner.py --phase refresh --reason <reason>`. Refresh reasons cite that decision and the single-property decision and record the self-contained trace correction and repeated-property regression. Generated locks and evidence are never hand-edited or committed.
