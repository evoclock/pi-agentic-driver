# Decision: behavioral-red evidence before baseline locks

Selected route: **B-first**, then A through the native audited refresh. Hold new G8 baseline acceptance until the separately reviewed gate-classifier fix lands. A+B is not selected as a safe acceptance route while the current classifier can still create a lock from a loader crash.

This does not authorize gate edits in G8. A separate worker brief has been prepared for the gate-quality change. No frozen G8 tests or generated locks were edited by this decision step. The current integration remains unfinished and is not ready for a PR.

## Invariant and options

Invariant: **a lock is only ever taken on a genuine behavioral red**. A green head cannot repair invalid base evidence.

- A: make the suite self-contained and run the current native audited refresh.
- B-first: land the separately reviewed native classifier repair before any new baseline attempt, then refresh the test through the sanctioned mechanism.
- A+B: make the suite self-contained while briefing the classifier repair in parallel; a baseline can run before the repair lands.
- Hold: retain inputs and do not create or accept a new lock.

Making a fixture self-contained removes the known missing-helper dependency; it does **not** make all uncaught parser, dependency or initialization failures impossible. The model therefore admits both behavioral-red and loader-crash outcomes after preparation. It does not claim that the repaired test will necessarily crash. It checks the requested unconditional lock-safety rule across both outcomes.

The model abstracts an audited refresh as a fresh baseline attempt. The earlier crash-derived artifact is disputed evidence, not an accepted behavioral-red starting state. That old artifact is preserved untouched; nothing here silently certifies or erases it.

## Checked model

[Gap8BaselineDecision.tla](Gap8BaselineDecision.tla) records `unbaselined`, `loader-crash`, `behavioral-red`, `locked` and `green`, plus `held`. A lock retains its source, so a later green result cannot hide a crash-derived lock. `LandReviewedB` is an owner-only transition after separate review, not an authorization produced by TLC.

The Pi installed-only statechart adapter reported `available-not-run` before execution. Exact invocation shape:

```text
PATH=<PREINSTALLED_JAVA_BIN>:<PATH> TLA2TOOLS_JAR=<PREINSTALLED_TLC_JAR>
node <STATECHART_SKILL>/scripts/run-tlc.mjs --spec .scratch/g8-baseline-decision/Gap8BaselineDecision.tla --config .scratch/g8-baseline-decision/Gap8BaselineDecision-<CONFIG>.cfg --out .scratch/g8-baseline-decision/run-<CONFIG> --timeout-seconds 60
```

TLC 2.19, one worker. Counts: generated / distinct / queued.

| Configuration | Adapter / TLC exit | Result | States |
| --- | --- | --- | --- |
| unsafe-A | 1 / 12 | LockOnlyBehavioralRed violated | 7 / 5 / 1 |
| B-first | 0 / 0 | No error has been found | 16 / 8 / 0 |
| unsafe-AplusB | 1 / 12 | LockOnlyBehavioralRed violated | 20 / 11 / 3 |
| hold | 0 / 0 | No error has been found | 4 / 2 / 0 |
| unsafe-classifier | 1 / 12 | LockOnlyBehavioralRed violated | 9 / 6 / 1 |
| reach-green | 1 / 12 | NeverGreen violated (expected reachability witness) | 14 / 8 / 0 |
| reach-reject | 1 / 12 | NeverRejectedCrash violated (expected reachability witness) | 9 / 6 / 1 |

Complete sanitized outputs are the new `tlc-gap8-baseline-<CONFIG>.out` files. The reachability probes deliberately assert the negation of the desired reachable state; they are not product safety failures. They show B-first can reach both locked/green behavioral evidence and a rejected crash, rather than passing by holding forever. No temporal progress claim is made by this model.

## Counterexamples and choice

A's bad path: prepare self-contained test → run base with an uncaught loader crash → current classifier takes a lock.

A+B's bad path: prepare self-contained test and brief B → run base with a loader crash before B lands → current classifier takes a lock. A parallel brief is not an enforcing classifier fix.

B-first blocks the baseline until the repair is integrated. Behavioral red can be locked and reach green; loader crash is rejected/held without a lock. Turning off the repaired classifier guard reproduces the same violation, demonstrating that this guard is load-bearing.

This finite model assumes the separately repaired classifier distinguishes genuine red from uncaught loader crashes. Its runtime conformance tests must establish that assumption; the model is not proof of an unimplemented classifier patch. It excludes filesystem races, byte-level evidence persistence and every possible language-specific reporter. Existing native atomicity/integrity checks still apply.

## Evidence correction and return path

The old G8 baseline log contains `ERR_MODULE_NOT_FOUND` followed by a file-level `ERR_TEST_FAILURE`, not execution of the main suite's assertions. The native tool nevertheless reported one failure, zero errors and wrote a lock. The G8 worker retracts its earlier full behavioral-red claim. The separate original Linux assertion-red baseline remains valid.

Preserved artifact SHA256 values:

- Old crash log: `fa2420867cd1391ab536b77d460e17f009dbd7d453b5296b3d2fce2e05082e29`.
- Disputed native lock: `89904266d9c9ee6bc240b9d3fae30835bd2015a9851754c5756fd24ea9c3f82c`.
- Frozen main exit test: `f2034eb0b97c1bdc93448e017fdbb94bd0a63c8bc2f7cb116ea86055af370ee6`.
- Frozen fixture helper: `a569387680211711aed2f6acc4fd120f00582408c868bb1c945b1c974418c7d0`.

No new genuine full-suite behavioral-red baseline is claimed at this decision checkpoint. After the classifier fix lands on main, merge main without rebasing, preserve the old crash evidence, use the sanctioned native refresh to make the affected test self-contained, and record the fresh hashes, executed assertion counts and contrast before trusting the baseline. Do not hand-edit locks, populate a host-owned snapshot manually or change the base to include production implementation.

Then resume cap100 diagnostics/tests, real CLI/Pi/gap-return verification, required mutations, formal reruns, official gates and scans. The eventual G8 PR body must include this decision and the fresh runtime evidence, plus the separate Linux-execution decision. No G8 draft PR or final-head review prompt exists yet.
