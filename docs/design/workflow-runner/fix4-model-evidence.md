# FIX4 model and runtime evidence (draft PR #198)

Source: Fix4Runner.tla, Fix4Runner.cfg, Fix4Runner-traces.json and .agents/skills/workflow-runner-formal/SKILL.md. All files and commands are local; no real worker ran. Covered-code commit: e2f8d10a97baab7c7feb63c9880792c146f3173a after the normal origin/main merge. The TLC run, 63 targeted tests and six mutant checks were rerun against that commit; a later production change invalidates these observations.

## RR5 bounded refinement (pending exact-head CI)

The companion Fix4RunnerRR5.tla isolates two runtime interleavings absent from Fix4Runner.tla: reuse of a retired generation name after a stalled observation, and an owner stop attempted after the history cap. The original model is unchanged and still passes (49,255 generated, 6,163 distinct, depth 18). Direct TLC 2.19 invocation with installed Java from repo-local scratch, with JAVA_HOME set for that invocation only, checked the RR5 safe config: 131 generated, **48 distinct**, depth **8**, no error. TypeOK, OneWriterNoFork and OwnerStopAvailable hold in this finite abstraction.

| RR5 guard disabled | TLC counterexample | Distinct at violation | Runtime regression |
|---|---|---:|---|
| FreshGenerationGuard=FALSE | OneWriterNoFork: Observe, AdvanceAndCompact, Link, Validate, FreshAct, StaleAct | 70 | A stalled old claimant must withdraw its own newly linked lock after observing a higher generation; test fails on the unfixed source. |
| OwnerCapGuard=FALSE | OwnerStopAvailable: Poll, Poll, OwnerStop | 48 | A cancel or hold at 1,024 events must settle, not throw; test fails on the unfixed source. |

The two abstract polls represent reaching the 1,024-event runtime threshold; AdvanceAndCompact collapses twelve completed look ticks into one step. Neither model proves unbounded time/bytes, fair scheduling, genuine worker behavior, same-uid protection or all filesystem interleavings. The RR5 witnesses appear separately in Fix4Runner-traces.json so existing FIX4 runtime replays retain their original shape. The post-link generation check and owner-cap exemption are exercised by two additional isolated source mutants; the optional Decisions API throw and damaged-checkpoint owner halt also have behavioral regressions.

## Checked model

TLC 2.19 with installed Java, direct command from repository-local .scratch/workflow-runner/fix4-model: /opt/homebrew/opt/openjdk/bin/java -XX:+UseParallelGC -cp <OWNER_HOME>/.local/share/tlc/tla2tools.jar tlc2.TLC -workers auto Fix4Runner.tla. Safe config: 49,255 generated, 6,163 distinct states, 0 left on queue, depth 18; completed with no error. TypeOK, CancelledNeverActs, NoActAfterHalt, OneWriterNoFork, NoJournalFork, CompactionExact and StoreBound all passed for this finite model. Four potential writers, four spellings of one checked artifact/procedure, four polls, two pending deltas and two retained lock generations are modeled. No fairness or unbounded-size proof is claimed.

| Disabled guard (one at a time) | Shortest violation | Distinct states at violation | Real-code replay |
|---|---|---:|---|
| IdentityGuard | CancelledNeverActs; Cancel, Claim under alias v2, PrePublish, Act | 363 | New task ID with changed digest refused before folder creation; CLI and Pi alias tests too. |
| HaltGuard | NoActAfterHalt; Claim, Cancel, PrePublish, Act | 372 | Owner cancel at pre-publication and after journal fsync suppresses outward act. |
| WriterGuard | OneWriterNoFork; one live owner, second claimant, two acts | 1,652 | Second claimant fails against live lock; four-contender test checks no fork. |
| WriterGuard (fork-only config) | NoJournalFork; Claim(1), Claim(2), PrePublish(1), Act(1), PrePublish(2), Snapshot, Journal(1), Act(2), Journal(2) | 11,704 | Published generations cannot vacate a live predecessor. |
| FactGuard | CompactionExact; Cancel, Look, Snapshot, Compact | 54 | Checkpoint and retired-lock summary preserve exact sealed facts; damaged versions refuse progress. |
| BoundGuard | StoreBound; Cancel, Look, Snapshot, Look, Look | 83 | 256-poll test bounds names and bytes even when a fake Decisions API asks not to compact. |

The writer trace is an abstract restore-window split in a four-contender model. RR4 independently reports a 2-act journal fork on historical 35a5afd8 under a four-process schedule (4/4 attempts); the new local scratch historical-source probe did not reproduce it in its two attempted schedules (1 act each). Do not promote those probes to a reproduced runtime regression. The model witness and the current four-contender runtime test demonstrate the dangerous order and its current refusal, not that every filesystem interleaving is proved safe.

## Conformance and mutation

The targeted library, crash, CLI and Pi tests passed 63/63 after the origin/main merge. Fix4Runner-traces.json records the actual TLC witness action sequences; a targeted test replays their relevant actions through the reducer and checks refusal or bounded store state. In addition, the six isolated production mutations in scripts/workflow_runner_mutation_controls.mjs were each killed by a behavioral assertion: per-step identity, pre-publication halt, forged completion inode, signed lock facts, authenticated checkpoint and hard compaction bound. Each mutant uses a fresh os.tmpdir() copy and teardown. A failing test on a mutant is sensitivity evidence, not a proof of universal correctness.

## Scope left visible

The model treats a complete atomic generation publication, exact snapshot fact restoration and a deterministic hard compaction threshold as actions. It does not model a same-uid attacker who can edit the readable key, HMAC-fake a checkpoint, hardlink a live done marker, delete the per-checkout identity index, or coordinate multiple checkouts. The runtime's history cap is 1,024 new events; past that, new work fails closed and owner halt remains available. The finite model's StoreBound does not prove infinite-duration byte bounds. Pi and CLI still do not dispatch real workers or prove a worker followed the declared skill; procedureVerified remains false. Release, Transfer and ReconcileOld are not implemented. The optional Decisions API callback only schedules maintenance; it cannot remove facts, override the hard bound, or grant authority. No external Jev call or credential was used.
