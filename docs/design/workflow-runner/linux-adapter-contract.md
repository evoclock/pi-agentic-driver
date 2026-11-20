# Linux guest-check adapter: owner-selected B

**Current delivery boundary:** G8 core retains the authenticated interface and native validation with injected conformance fixtures. Its production target/probe are unavailable and its production execution path refuses. The live launcher and pinned Testudo image recipe are deferred to G8b after core merges. The design and model evidence below describe the eventual adapter contract, not a delivered live backend. See [the split](ssh-guest-check-contract.md).

Status: implementation scope settled; native admission implemented, real transport pending. The separate closed native checks entry point is in G8 scope. The later owner decision adds unattended standing-ledger authorization without a per-run TUI, while attended use keeps the existing switch/TUI/confirmation. The pinned killswitch remains mandatory in both paths. No further scope decision is needed for implementation; owner review is still required before merge. Missing capability or authorization parks, never passes. See [the unattended refinement](linux-unattended-decision.md).

New self-contained conformance tests in `tests/test_workflow_runner_microvm_checks.mjs` cover the five model invariants, unavailable behavior, positive guest results, the unchanged proof schema and closed checks parameters. The first local preimplementation run observed 9 tests: 8 assertion failures for the absent entry point and 1 passing proof-schema control. This is local test-first evidence only, not accepted native baseline evidence; baseline acceptance still waits on the separate loader-classification repair.

## Required native API change

The current `agentic_linux_microvm_cutover` boundary accepts only optional `target`. Its executor explicitly rejects every other parameter (`linux_microvm_cutover_pi.js:668–678`), and its schema has `additionalProperties: false` (`:689–696`). It runs a fixed transient proof, not an arbitrary receipt checkout. The only job payload source is owner configuration (`:482–488`); native switch, real TUI and per-run confirmation remain required for its attended path (`:491–497`, `:563–565`, `:604–607`). The separate unattended checks path uses a verified standing guest-check grant rather than manufacturing these interactive facts. The current fixture builds a BusyBox initramfs, reports disk/host-share absent and returns containment/proof evidence, not check results.

**The change requiring native-boundary review is a distinct guest-check request/receipt mode**, registered inside the existing native module so it retains that registration's actual isolation-switch closure and TUI confirmation. Prefer a separately named checks entry point over changing the meaning of the proof result. It must accept only a closed task/run request reference, revalidate the frozen checks and receipt checkout itself, and return a separately typed guest-check receipt. It must not accept arbitrary model-supplied shell/payload text or reinterpret `VERIFIED` proof as check success.

The native module and fixed fixture need reviewed transport for an immutable checkout/check envelope and a result channel; a reviewed guest runtime with the declared tools is required. A BusyBox proof cannot execute Node/Python/type/compiler checks by implication. No payload replacement, fake switch, fake TUI/confirmation, raw remote-shell launch or unscoped unattended launch is acceptable. Unattended authorization must come from the existing verified standing-ledger mechanism. No such native code change has been made here.

## Proposed closed execution contract

1. **Admission:** G8 resolves checks only from the frozen workflow revision, constructs the exact command-ID/argv/cwd/time-limit allowlist and current task/step/epoch/writer/dispatch/commit/checksDigest binding. The native entry point independently validates this request. No caller may add a command outside the frozen set.
2. **Checkout transfer:** archive only the receipt commit's tracked tree with a manifest and digest. Reject traversal, escaping symlinks, device entries and hidden host/config/credential inclusion. Bind transfer digest to the receipt tree/commit and revalidate after transfer. Do not mount the owning user's home or the host repository. Stage a readonly guest checkout with scratch only in the designated job area.
3. **Payload/runtime:** the owner-configured containment payload remains unchanged and must identify the reviewed supervisor capable of consuming the data envelope. A missing/incompatible payload or guest runtime yields `checks-runner-unavailable`. There are no runtime package installs or network downloads. Runtime identity must be pinned and reviewed, not inferred from the proof fixture.
4. **Native authorization:** attended use takes the actual registered session switch/TUI confirmation, naming target, runtime identity, receipt commit, archive/checks digests, exact check IDs, bounds and effects. Unattended use instead verifies and reserves a standing guest-check ledger grant, with expiry/revocation checked for each run and before result acceptance. Neither path may manufacture the other’s facts. Reobserve bindings and pinned armed killswitch readiness before dispatch. Missing/invalid authorization, stale facts or unavailable capability parks without execution.
5. **Guest execution:** the existing guarded target route invokes a fixed reviewed fixture/supervisor, not model-authored remote shell text. The supervisor verifies the data manifest, runs only the allowlisted argv with no shell, minimal environment and no credentials, and never modifies the readonly acceptance tree.
6. **Results:** use a distinct bounded result envelope carrying the complete request binding, unique guest-run nonce, archive digest, check ID, actual exit/signal/timeout status, observed test count and output digest. Accept only the matching guest-run result after validated containment/teardown evidence. Reject host proof, replay, stale nonce, mixed check IDs, missing results and incomplete logs. Proof success alone cannot pass any check.
7. **Cancellation/timeout:** propagate the signal/deadline through the native entry point and supervisor; kill the guest job and complete verified VM teardown. A cancellation observed before result acceptance dominates late success. Missing cancellation/teardown acknowledgement is incomplete/parked, never pass. Keep each check deadline and the total G8 budget.
8. **Rejoin G8:** only complete, matching, uncancelled guest results enter the private bound `_checks` observation. Lint/type/test/invariant counters, gaps and progress apply exactly as for other runners. A verified containment trip produces failed exit126 and bound log evidence, parks non-retryably and never silently redispatches. Unsupported execution remains explicit unavailable, never silent host fallback.

This contract is not the native implementation. The scoped separate checks mode is now authorized for implementation by the coordinator relay; its exact request/receipt schema and guarded fixture/runtime code must preserve the constraints above and receive owner review before merge.

## Refined model

`Gap8LinuxAdapter.tla` refines the earlier A/B decision. B is the intended delivered design; A and unavailable configurations preserve fail-closed behavior, and Hold remains explicit. `AdapterAvailable=TRUE` is an assumption that the reviewed native checks API/runtime exists. It does not assert the current proof tool has that capability.

Invariants: TypeOK, UnavailableNeverPass, NativeBoundary, CheckoutIntegrity, ArgvFromFrozenChecks, ResultOnlyFromGuest, CancellationNeverPass. Native facts are observations, never manufactured by the adapter. The model covers pre-run and in-flight cancellation/timeout, refused/missing native context, staged checkout and argv, guest-run identity and result origin. It excludes byte-level archive safety, concrete process cancellation, reporter parsing, transport authentication and runtime supply-chain validation; tests must establish these mappings.

Pi installed-only statechart detection returned `available-not-run`. Each final run used TLC 2.19, one worker, with the invocation:

```text
PATH=<PREINSTALLED_JAVA_BIN>:<PATH> TLA2TOOLS_JAR=<PREINSTALLED_TLC_JAR>
node <STATECHART_SKILL>/scripts/run-tlc.mjs --spec .scratch/g8-linux-adapter/Gap8LinuxAdapter.tla --config .scratch/g8-linux-adapter/Gap8LinuxAdapter-<CONFIG>.cfg --out .scratch/g8-linux-adapter/run-v2-<CONFIG> --timeout-seconds 60
```

Counts are generated / distinct / queued. Complete final sanitized output is `tlc-gap8-adapter-<CONFIG>.out`.

| Config | Adapter / TLC exit | Result | States |
| --- | --- | --- | --- |
| B | 0 / 0 | No error has been found | 44 / 22 / 0 |
| A | 0 / 0 | No error has been found | 24 / 12 / 0 |
| hold | 0 / 0 | No error has been found | 24 / 12 / 0 |
| unavailable | 0 / 0 | No error has been found | 24 / 12 / 0 |
| unsafe-native | 1 / 12 | NativeBoundary violated | 5 / 5 / 3 |
| unsafe-checkout | 1 / 12 | CheckoutIntegrity violated | 35 / 21 / 5 |
| unsafe-result | 1 / 12 | ResultOnlyFromGuest violated | 40 / 24 / 6 |
| unsafe-cancel | 1 / 12 | CancellationNeverPass violated | 47 / 24 / 1 |
| unsafe-argv | 1 / 12 | ArgvFromFrozenChecks violated | 35 / 21 / 5 |
| reach-pass | 1 / 12 | NeverGuestPass violated (expected coverage) | 37 / 21 / 3 |
| reach-unavailable | 1 / 12 | NeverUnavailable violated (expected coverage) | 6 / 6 / 4 |

The probes confirm both a guest pass and unavailable branch are reachable; B is not vacuously an always-park implementation. No temporal completion claim is made. Five disabled guards each expose their intended safety violation.

During model authoring the first unsafe-native trial unexpectedly passed because an unparenthesized snapshot assignment also guarded on the native booleans. Parenthesizing the conjunction corrected that modeling error; every cfg was rerun in new `run-v2-*` output directories. Original trial evidence remains in scratch; no earlier committed output was overwritten or count-tuned.

## Test-first continuation

New tests must exercise actual registered native entry points with controlled test doubles only, never fake live permission. Cover missing/disabled switch, absent TUI, refused consent, unchanged owner payload, bad archive or command digest, wrong guest nonce, host-proof substitution, cancellation before/after guest result, timeout/teardown failure, and a real guest-result protocol path. No real worker, credentials, target setup or live VM is authorized by those tests.

The genuine full-suite behavioral baseline remains held on the separate loader-classification fix. No new baseline or runtime adapter pass is claimed here. Preserve frozen tests and prior locks; use new test files and the sanctioned native mechanism when that fix lands. The eventual G8 PR must state owner-selected B and distinguish this model evidence from implemented/native-verified behavior.
