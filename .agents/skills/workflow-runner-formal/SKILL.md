---
name: workflow-runner-formal
description: Model-check PAD workflow runner identity, owner halt, writer generations and bounded delta/snapshot compaction whenever the core, Pi facade, CLI or their tests change.
---

# PAD runner formal verification (project-local)

Use for any change to scripts/workflow_runner_core.mjs, scripts/pad-runner.mjs, extensions/workflow-runner.js, or tests/test_workflow_runner*.mjs. Read the installed statechart-pi skill and its references/pi-tlc.md before changing this model. The TLA+ model is docs/design/workflow-runner/Fix4Runner.tla with config Fix4Runner.cfg. Compare each atomic action to its corresponding core function before trusting TLC; a model pass is not runtime verification.

## Run from the approved slot

Copy Fix4Runner.tla and Fix4Runner.cfg into a new repository-local .scratch/workflow-runner/formal-run directory. From that directory run exactly:

/opt/homebrew/opt/openjdk/bin/java -XX:+UseParallelGC -cp <OWNER_HOME>/.local/share/tlc/tla2tools.jar tlc2.TLC -workers auto Fix4Runner.tla

Do not install Java or TLC, use global PATH changes, or overwrite prior evidence. Record generated and distinct states and an explicit result for every invariant: TypeOK, CancelledNeverActs, NoActAfterHalt, OneWriterNoFork, NoJournalFork, CompactionExact, StoreBound. If Java, parsing or runtime checking fails, stop and report the actual output. A deliberate unsafe guard variant is expected to produce an invariant-violating trace; it is not a safe-model pass.

## Break it before trusting it

In separate new .scratch copies, switch exactly one of IdentityGuard, HaltGuard, WriterGuard, FactGuard, BoundGuard to FALSE, keep all invariants except omit CancelledNeverActs for the HaltGuard control to expose NoActAfterHalt, and run the same Java command. Observe its named violation and shortest behavior. For WriterGuard separately check NoJournalFork on a config with only that invariant: an old restore window permits distinct writers to publish and journal the same intent. Restore the safe copy; it must again check with no errors. Do not weaken any safe invariant to make the model pass. The model-derived paths are recorded in docs/design/workflow-runner/Fix4Runner-traces.json and replayed by tests/test_workflow_runner.mjs. Run node scripts/workflow_runner_mutation_controls.mjs: six guarded source mutations must each cause a behavioral test failure in an os.tmpdir() copy that is torn down. Use the companion verify-workflow-runner skill for real CLI/Pi fixtures; never equate an abstract model trace to proof about filesystem atomics.

The bounded model has four contenders and four spellings of one canonical artifact/procedure; up to four status polls; two pending deltas; two retained lock generations; authenticated snapshot and exact cancel, halt and current-lock safety facts. It excludes cross-checkout coordination, malicious same-uid rewrites, actual byte-level serialization, worker procedure compliance, and real worker effects. StoreBound is a bound under these assumptions, not a proof that arbitrary histories fit in constant bytes. The runtime retains up to 1024 historical events and must refuse further new effects at that limit. A Decisions API callback may suggest an earlier compaction time but cannot decide what facts to retain or override the hard bound; no external model is invoked by the default runner.

## G4 external authority coverage

Also check `docs/design/workflow-runner/Gap4Authority.tla` with `Gap4Authority.cfg` and all nine `Gap4Authority-unsafe-*.cfg` controls in fresh repo-local scratch copies before changing the shared authority, gate, remote client or their core wiring. The abstract authority covers both the remote Durable Object and service-account daemon; backend A implementation is separate. The writable local cache is not a trusted anchor. Check TypeOK, CancelDurable, NoEffectAfterAuthoritativeCancel, NoAdvanceOnUnknownEffect, ReplayIdempotent, EpochSeqMonotonic, LeaseFenced and PendingCancelSurvivesRestart together. Never remove a safe invariant to get a pass.

Observed G4 safe result after adding client restart: 298,777,109 generated states and 14,271,032 distinct states. All nine one-guard controls fail with named counterexamples; see `gap4-model-evidence.md` and `Gap4Authority-traces.json` for counts, trace lengths, bounds and exclusions. The existing Fix4Runner safe rerun generated 49,255 states and found 6,163 distinct states. These model results do not verify either deployed backend. The runtime G4 filesystem test deletes a real checkpoint and restores a valid pre-cancel journal prefix. Client tests cover pending cancel, lost reply, CAS conflict, stale authority, missing authority, lazy expiry, unknown effects, tenant mismatch and idempotency mismatch. The shared fake/remote restart contract requires an fsync'd stateDir outbox before submission, recovers the original requestId after a new client instance starts, and blocks admission while pending. Missing or failed persistence refuses acceptance. This covers crash/restart, not hostile deletion of an uncommitted pending store; backend A must run the shared contract too. The standalone mutation controls copy the explicit fake authority fixtures and current module dependencies; the old pre-authority halt mutant was replaced by a fresh-admission mutant because authoritative cancellation now independently fences that path. Record fresh runtime/gate results separately for each checked head.

## Coverage and synchronization

Model Claim/PrePublish/Act/Journal/Retire correspond to run, acquireWriterLock, persist and compactCompleted in scripts/workflow_runner_core.mjs. Cancel/OwnerHalt correspond to the reducer and emergencyHalt; Snapshot/Compact correspond to replayJournal, persist/checkpoint.json and lock-summary.json. The CLI and Pi facade call that reducer but do not themselves dispatch workers. Tests: tests/test_workflow_runner.mjs, tests/test_workflow_runner_crash.mjs, tests/test_workflow_runner_tools.mjs and the model-conformance tests. Last confirmed covered-code commit: e2f8d10a97baab7c7feb63c9880792c146f3173a. The safe model checked 6,163 distinct states, the targeted runtime suite passed 63 tests and all six isolated source mutations failed behavioral checks on that commit. A later production edit invalidates this sync record until the model and checks are rerun.
