---
name: test-gate
description: Use the host-run fail-first, read-only test diff, mutation, and evidence workflow before trusting changed tests.
---

# test-gate

Use the host runner, not a test author's report, to prove that changed tests detect a behavior change.

## Workflow

1. Add behavior tests before implementing the behavior. Give each test a short `Why:` note. Python tests use a docstring beginning with `Why:`; JavaScript and TypeScript tests use a `// Why:` comment for each `test(...)` or `it(...)` case.
2. Run `make test-gate TEST_GATE_PHASE=baseline`. The runner finds changed test files, checks for test cases and assertions, overlays those tests on a `git archive` of the configured base commit, and runs the matching command from `.driver/gate-rules.json`. A successful baseline result means the host observed at least one assertion failure, no runner errors, and a nonzero test count. The runner then locks the test and fixture hashes.
3. Implement the behavior without editing the locked test files. Run `make test-gate` again. The runner checks the test and fixture set and hashes before and after each command, runs the tests on the current worktree, and runs the single exact mutation in `.driver/test-gate.json`. The mutation target must be part of the change, and the configured suite must fail on that mutant.
4. Run `make gate` for the repository's existing shared checks. Buildkite runs both targets and uploads `.driver/test-gate-evidence/checks.jsonl`.

The runner selects tests from changed test paths and maps them to the existing gate commands. Each command has a host-enforced time limit and a maximum observed test count. The current defaults are 120 seconds and 10,000 tests; the runner refuses configured limits above 300 seconds or 10,000 tests. A cap hit is `blocked`. A new test type without a mapped command, a test reporter without a supported count, or a missing count rationale is also `blocked`; add the smallest explicit mapping and denominator explanation rather than trusting an agent-supplied number. Host-observed totals must be greater than zero. A clean tree is a no-change pass and makes no claim about a test count or pass rate.

## Results and evidence

- Exit `0`: checks passed, or there is no changed code/test behavior to check.
- Exit `1`: a test passed on base, an implementation test failed, or a configured mutant survived.
- Exit `3`: `blocked` with a structured reason, for example missing base, unsupported test command, zero observed tests, or test-file drift after the lock. This is a legitimate clean off-ramp; do not relabel it as a pass or a test failure.
- Exit `2`: host runner error.

Each command and final result appends host-observed JSONL to `.driver/test-gate-evidence/checks.jsonl`: argv, working directory, actual exit code, commit SHA, base SHA, elapsed time, result, and observed totals where available. The fail-first lock lives beside that artifact. Do not commit or hand-edit generated evidence.

The gate rules remain the source for test commands. This slice supports Python unittest, Node's test reporter, and the repository's Janus/weekly-recap test commands. The Python and `node:test` source checks reject missing assertions and missing `Why:` notes. A general-purpose mutation engine and deeper semantic/vacuity analysis for every test framework are deferred; use one reviewed exact weak mutation for each changed code/test unit and document any unsupported case as blocked.
