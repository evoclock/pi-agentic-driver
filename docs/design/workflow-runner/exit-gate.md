# G8 exit gate contract

Status: draft implementation after G7. Local fixture/model conformance is recorded separately from audited gates. Live SSH backend and pinned guest-image acceptance remain pending and unavailable readiness fails closed.
Cam: please review this contract and the replacement sequence below before code lands.

## Single source of done

A worker step advances only after all effective checks pass on its exact receipt commit, with an empty gap set and fresh evidence bound to task, step, epoch, writer, dispatch, commit and checks digest. The existing procedure gate still follows G8. A verified receipt alone is not completion.

G8 reads the design manifest, `.driver/exit-checks.json` and referenced `.driver/gate-rules.json` with `git show <revision>:<path>`. Neither working-tree changes nor receipt-commit edits can weaken the declarations. Effective checks are the union of repository defaults and design `checks.add`; designs cannot remove defaults. Duplicate IDs park `checks-invalid`.

The repository declaration uses `pad-exit-checks.v1` ([schema](schemas/pad-exit-checks.v1.schema.json)). `fromGateRules` contains objects declaring each reviewed command entry's `id` and `kind`, plus `counter` for test kinds and optional `covers` and `timeoutSeconds` (1–600). Bare IDs are invalid: kinds and counters are not inferred from names or argv. Commands and cwd remain exactly those of the pinned gate rule; the import's timeout overrides the rule's timeout, otherwise the rule or 120-second executor default applies. PAD's Python import uses 450 seconds, below the 600-second check cap. Observed suite runs took 186, 187.296, 198 and 205 seconds; the slowest leaves 54.444% headroom at 450 seconds, versus 31.667% at the former 300-second timeout. This is a bounded configuration allowance for run-to-run spread and growth, not a promise about unobserved runtimes. The unit test pins the configured allowance and cap; it does not present a fixed historical sample as a live headroom check. `node-tap` accepts both TAP `# tests N` and Node's default spec `ℹ tests N` summaries. `defaults` adds argv checks. Kinds are `lint`, `types`, `test`, and `invariant-test`. Every spec invariant must have at least one covering invariant-test. Empty declarations park `checks-undeclared`; missing coverage parks `invariant-untested`. Test kinds require a declared counter (`node-tap`, `python-unittest`, `pytest`, or `cargo`). Zero observed tests park `checks-zero-tests`, rather than creating a retryable gap.

## Execution boundary

Checks execute worker-written code. **Host execution is not isolation:** even a minimal environment does not prevent access to the host user's files or other host resources. Choose an isolated runner when that risk is unacceptable.

The local `pad-user.v1` config selects `host`, `macos`, `linux`, or `auto`. It is never committed; examples use `<USER_CONFIG>` and `<REVIEWED_CONTAINER_IMAGE>` placeholders.

- `host`: only when explicitly requested, run in the local checkout when HEAD equals the receipt commit and the tree is clean. Recheck HEAD and cleanliness afterwards; any change parks `checks-tree-changed`.
- `macos`: requires Apple silicon, macOS 26+, Apple's `container` CLI, a running apiserver and a reviewed image already present locally. Missing prerequisites park `checks-runner-unavailable`. No image pull during checks. Docker, Colima and host execution are not substitutes. The owner starts the service outside this gate; no hidden installation or service-start fallback is used.
- `linux`: the owner-selected G8 design includes a reviewed guest-check execution adapter preserving the native microVM boundary. Missing adapter/runtime or a valid standing guest-check grant parks `checks-runner-unavailable`; unavailable never means pass or silent host fallback. The existing proof tool alone is not a receipt-check executor. The separate native API resolves an authenticated run/current claim, but core's production backend is unavailable. The [live SSH subsystem and pinned image](ssh-guest-check-contract.md) are deferred to G8b after core merges. Both unattended and attended guest checks require a repository-scoped, expiring, revocable standing `guest-check` grant, reserved before any readiness probe. Missing or invalid grants never prompt. Attended runs also retain the actual isolation switch; neither that switch nor TUI presence replaces a grant. Revocation and abort fence every subsequent effect and acceptance. The original proof tool and owner payload are unchanged.
- `auto` (the default): use healthy macOS containers on supported macOS, or native Linux guest checks on Linux. Missing prerequisites park `checks-runner-unavailable`; auto never falls back to host. Record the selected isolated runner and `pickedBy: "auto"` in evidence and the journal. Host execution requires an explicit `checks.runner: "host"` request. Explicit `"linux"` keeps its native route and grant requirements. The macOS selector parks on unsupported platforms rather than selecting host; workflow-level Linux routing uses the native guest-check boundary.

`config/pad-user.v1.example.json` uses this fail-closed `auto` default and a placeholder for a reviewed, already-local macOS image. Without those prerequisites it parks; it is not a portable host-execution example.

Apple execution uses `container run --rm --network none`, a readonly bind mount of the checkout at `/work`, `/work` as the working directory, a recorded container ID and the reviewed image from local config. Pass only explicit environment arguments, never an inherited environment or credential-bearing env file. Optional configured CPU/memory limits map to `-c`/`-m`.

Reference: [Apple container](https://github.com/apple/container), especially its command and volume documentation. `container cluster` and `docs/cluster.md` describe Kubernetes, not this execution path.

All commands are nonempty argv arrays executed with `shell: false`. Optional cwd is normalized, repository-relative and traversal-free. Each timeout is 1–600 seconds (default 120); total budget is 1800 seconds. Environment is limited to PATH, HOME, LANG, TMPDIR and `CI=1`, with no forwarded keys or tokens. Container HOME and TMPDIR are `/tmp`, PATH is `/usr/bin:/bin`, and LANG is `C.UTF-8`.

Pass requires exit status 0, no signal, no timeout, and at least one observed test for test kinds. Limit captured output to 4 MiB; scratch evidence stores its sha256 and at most the first 4 KiB. Journal entries contain digests, counts and gaps, not full logs. Incomplete observations park `checks-incomplete`.

## Gap list and progress

Each failed pass records `pad-exit-gaps.v1`: passIndex, failed checks with kind, covered invariant IDs/statements, status, exit status and test count; sorted unique gapSet, previousGapSet, staleStreak and passes. Output hashes do not define progress.

A changed set (including growth or oscillation) resets staleStreak to 1. The same set for noProgressLimit consecutive passes parks `checks-no-progress`. Reaching safetyCeiling parks `checks-ceiling` even while gaps change. Defaults are 3 and 50. Engine backstops are 20 and 1000; workflow values override local defaults within those bounds. Dispatch failure maxAttempts remains separate (default 2, backstop 100). Failed G8 passes neither increment nor consult maxAttempts.

A returning failure stores the gaps, writes a handover through the existing `scripts/session_handover.py write`, clears pending/intent/wake, and returns the step to ready with `checks-failed-returned`. The next prompt carries the G7-derived stack plus those gaps. Handover consume is required before redispatch; otherwise wait `handover-unconsumed`. An interrupted exclusive intent blocks rather than replays. No second handover producer is introduced.

`checks` is public asynchronous host work outside the writer lock. `_checks` is runner-issued only, rejected from CLI/Pi, and consumes each evidence ID once. An all-pass observation is usable only for the current binding and empty gap set; stale or foreign evidence cannot advance.

## Model and implementation correspondence

[Gap8ExitGate.tla](Gap8ExitGate.tla) models the done, freshness, declaration, coverage, gap, zero-test and termination boundaries. [Evidence](gap8-model-evidence.md) records the eight controls. NoProgressLimit=3 and SafetyCeiling=4 bound enumeration; the product ceiling remains 50.

| Model | Planned implementation seam |
| --- | --- |
| Receipt | verified receipt after handover consumption |
| RunCheck | observeExitChecks and private _checks observation |
| Advance | checksPassed, empty gaps, then existing procedure gate |
| Return | failed observation, handover, ready without attempt increment |
| Park | declaration, coverage, zero-test, no-progress or ceiling park |
| CompleteWithGaps | negative control: forbidden completion with gaps |

ExitGuard requires successful checks; BindGuard requires the current binding. EmptyGuard, CoverageGuard and ZeroGuard enforce nonretryable declarations. GapGuard forbids completion with gaps. ProgressGuard and CeilingGuard bound redispatch. Weak fairness is a model assumption for termination, not a claim that real host commands always finish; execution timeouts remain necessary.

## Replacement sequence and deferred work

As specified by the approved G7/G8 handoff section 3, G8 becomes the runner's single source of done without changing Ralph or `/loop-until-done` in this gate change. A separate migration PR makes those entry points thin workflow-runner delegates. Only after callers migrate, caller searches are clean and the owner agrees may a later deletion PR remove the old engines. Keep the shared session-handover producer.

The implementation includes exit resolution/execution, authenticated current claims, reducer/CLI/Pi routing, repository defaults and fourteen guard-removal contracts. [The output-contract decision](output-contract-decision.md) records the Flockmate choice under the standing unattended-work instruction. Live guest acceptance, audited gate results and review remain separate obligations, never inferred from fake transport tests. Ralph and `/loop-until-done` entry-point migration is not part of this change.
