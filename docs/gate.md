# Shared gate

Run `make gate` after every change. `make all` is an alias for the same target.
The gate reads `.driver/gate-rules.json`; Buildkite runs that same target on
the CI host and keeps the existing required steps.

## Checks

The fast local loop reuses the current CI commands:

- Durable tests: `npm run test:ci`.
- The Janus type check, current Node policy unit tests, Janus tests, and Python
  unit tests from the existing Types and unit tests step.
- `scripts/treehouse_codepath_scan.py` and `.buildkite/public-scan.sh`.
- The local codebase inventory refresh/check, existing `.githooks/pre-commit`
  integrity and bypass checks, and hidden-install scan.

`make gate` does not install packages. Install dependencies through Socket
Firewall when needed, as Buildkite does:

```sh
sfw npm ci --ignore-scripts --no-audit --no-fund
sfw npm ci --ignore-scripts --no-audit --no-fund --prefix janus
```

If the inventory check fails, run `python3 scripts/codebase_inventory.py`,
review `pipeline_output/codebase_inventory.jsonl`, then rerun the gate. This
keeps the check usable before changes are staged. The generated inventory is
ignored and must not be staged. Buildkite also replays the checked-in pre-commit
hook against the committed tree; that hook refreshes the local artifact and
still rejects unstaged source. A restored tracked inventory uses strict comparison.

The hook check reports when `core.hooksPath` is unset, and fails if it points
somewhere other than `.githooks`. It checks changes to hook files against
`origin/main`, and rejects `git commit --no-verify` in automation and skill
paths. Fetch `origin/main` if it is not available locally.

The gate measures its own elapsed time and fails after 600 seconds. The rules
file holds the check list, this budget, the `origin/main` comparison ref, and
hash-scoped allowances. An allowance covers one check and one exact file hash;
changing that file invalidates the allowance until its new contents are
reviewed. The allowances cover the Socket Firewall-wrapped packed-consumer install in
Buildkite and two containment fixtures that embed denied package-manager text
as policy data and classifier test patterns. Skill/bootstrap installs remain
blocked.

## Test-gate warnings

`python3 scripts/test_gate_runner.py --phase check` runs changed head tests even for test-only edits. If no production code changed, the gate does not require a base assertion failure or a new mutation contract. It prints a distinct test-only warning. Both test-only and config-only warnings attempt a Buildkite annotation only when the root resolves to `BUILDKITE_BUILD_CHECKOUT_PATH`; fixture roots and unset checkout paths never annotate. Annotation failure is nonfatal. Existing contracts still execute. `Why:` notes, assertions, counts, caps, input immutability and head success remain required. Fixture-only edits still need a changed specification. Production changes still require fail-first and focused mutation coverage. See `skills/test-gate/SKILL.md` for the full workflow.

## Fixture coverage and deferrals

`tests/test_gate.py` feeds planted violations from `tests/fixtures/gate/` to the
same scanners used by the gate. It proves a skill bootstrap install and a hook
bypass fail, then pass when the violating file is removed. Add a fail/pass
fixture for each new scanner as it is implemented.

Secrets scanning, dependency-diff enforcement, and the full antipattern scan
are explicit TODO skips for §10.13; these stubs exit successfully and are not
coverage. The full Node suite (`npm test`) runs in the shared gate. PR
wording, PR review, and release README status remain in their existing
Buildkite steps because they need PR metadata, `GH_TOKEN`, or release-branch
context. They are not silently replaced by this local gate.
