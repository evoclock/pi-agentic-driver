# Decision: Linux execution (unattended)

The owner's autonomous-execution decision supersedes the attended-only admission assumption for G8's separate guest-check mode. The existing proof tool stays target-only and native-confirmed. The new checks entry point has two distinct admission paths:

- **Attended:** the actual registered isolation switch, native TUI and per-run confirmation remain mandatory.
- **Unattended:** a verified, repository-scoped, time-bounded, revocable **standing `guest-check` ledger grant** replaces interactive admission. No switch is set and no TUI/confirmation is fabricated. Missing, expired, exhausted, revoked, untrusted or wrongly scoped authorization yields `checks-runner-unavailable`, never pass.

Both paths require the same pinned containment killswitch, immutable receipt checkout, frozen argv, guest-bound results, cancellation and teardown checks. A guest-check result is not the existing proof's `VERIFIED` status.

## Mandatory killswitch and trip handling

Reuse PAD's existing guest-containment implementation and taxonomy, not a second detection engine. Verify the shipped taxonomy digest and the backend's request-bound armed-readiness evidence before execution. Missing arming or a mismatched taxonomy refuses launch. The authoritative sequence remains detect → classify → log → trip → kill → exit 126. A trip is a failed, non-retryable check with bound containment-log evidence. Never convert it to pass or silently launch a replacement guest.

The current PAD taxonomy pin is `0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd`. It belongs to this shipped taxonomy revision; historical local evidence may refer to another revision. Do not substitute historical host/image identifiers or digests for owner-local configuration.

## Ledger integration

The native admission layer uses the existing ledger verifier, authorizer and reservation writer. It requires a dedicated standing action scope `guest-check` for the canonical repository, an explicit finite expiry and a currently trusted relayer. Each run rechecks authorization, reserves a use before execution and rechecks revocation/trust/expiry before accepting a result. A reserved final allowed use may finish; it does not authorize another run. Raw chat prose, a tool receipt or an approval template is not a grant.

A trusted relayer must record/provide the genuine standing scope through the existing writer outside a guarded Pi shell. The agent neither writes nor reads the live approval ledger directly. No actual unattended activation is authorized by this model or its synthetic test grants. A read-only relay preflight on the supplied prose returned `needs-owner` for `guest-check`; no matching grant reference has been verified in this session. That does not assert that the live ledger is empty.

## Model

`Gap8LinuxUnattended.tla` refines the earlier B model with both admission paths and two runs, allowing revocation/expiry after the first run. The updated NativeBoundary is conditional on the real attended path or valid unattended standing authorization; it does not pretend an unattended run received a TUI confirmation.

Checked invariants: TypeOK, UnavailableNeverPass, RevokedPreauthBlocksNextRun, UnattendedNeedsValidPreauth, NoGuestWithoutArmedKillswitch, KillswitchTripNeverPass, NativeBoundary, CheckoutIntegrity, ArgvFromFrozenChecks, ResultOnlyFromGuest, CancellationNeverPass and NoSilentTripRetry.

Invocation for each final run:

```text
JAVA=<PREINSTALLED_JAVA> TLA2TOOLS=<PREINSTALLED_TLC_JAR> TLA2TOOLS_JAR=<PREINSTALLED_TLC_JAR>
PATH=<LOCAL_BIN>:<HOMEBREW_BIN>:<PREINSTALLED_JAVA_BIN>:<PATH>
node <STATECHART_SKILL>/scripts/run-tlc.mjs --spec .scratch/g8-unattended/Gap8LinuxUnattended.tla --config .scratch/g8-unattended/Gap8LinuxUnattended-<CONFIG>.cfg --out .scratch/g8-unattended/run-v2-<CONFIG> --timeout-seconds 60
```

Pi detection reported `available-not-run`. TLC 2.19 / OpenJDK 27, one worker. Counts are generated / distinct / queued. The complete sanitized outputs are `tlc-gap8-unattended-<CONFIG>.out`.

| Config | Adapter / TLC exit | Result | States |
| --- | --- | --- | --- |
| safe | 0 / 0 | No error has been found | 2044 / 994 / 0 |
| unattended | 0 / 0 | No error has been found | 1112 / 544 / 0 |
| attended | 0 / 0 | No error has been found | 932 / 450 / 0 |
| unsafe-preauth | 1 / 12 | UnattendedNeedsValidPreauth violated | 336 / 263 / 188 |
| unsafe-revocation | 1 / 12 | RevokedPreauthBlocksNextRun violated | 981 / 496 / 41 |
| unsafe-killswitch | 1 / 12 | NoGuestWithoutArmedKillswitch violated | 945 / 577 / 207 |
| unsafe-trip | 1 / 12 | KillswitchTripNeverPass violated | 1423 / 718 / 34 |
| unsafe-native | 1 / 12 | NativeBoundary violated | 74 / 71 / 66 |
| unsafe-checkout | 1 / 12 | CheckoutIntegrity violated | 1149 / 736 / 321 |
| unsafe-result | 1 / 12 | ResultOnlyFromGuest violated | 1273 / 685 / 101 |
| unsafe-cancel | 1 / 12 | CancellationNeverPass violated | 1425 / 719 / 34 |
| unsafe-argv | 1 / 12 | ArgvFromFrozenChecks violated | 1149 / 736 / 321 |
| unsafe-unavailable | 1 / 12 | UnavailableNeverPass violated | 130 / 130 / 128 |
| reach-autonomous | 1 / 12 | NeverAutonomousPass violated (expected witness) | 716 / 390 / 62 |
| reach-revoked | 1 / 12 | NeverRevokedPark violated (expected witness) | 901 / 456 / 29 |

The probes show a real modeled unattended pass with no interactive switch/TUI, and a second-run park after revocation. Safe success is therefore not merely an always-unavailable implementation. This finite model makes no temporal completion claim. It abstracts ledger I/O, transport, monitor implementation and teardown; its observations must be backed by runtime conformance.

The first model trial had an invalid mixed string/integer sentinel in TypeOK. The unset exit sentinel was corrected to a numeric value and every cfg rerun in fresh `run-v2-*` directories. Earlier trial output remains in scratch. No safe invariant was weakened or approved gate-model count tuned.

## Current implementation evidence and limits

The separate native entry point is registered from the original microVM module using its real registration options. Public parameters remain only the frozen run reference; arbitrary argv, payload and target overrides are rejected. The proof tool's target-only schema is unchanged. Admission/result validation now uses real ledger operations against synthetic profiles in tests, repeated arming checks, checkout/command/result binding, exclusive durable intents and retained non-retryable trip records.

Conformance: `tests/test_workflow_runner_microvm_checks.mjs` and `tests/test_workflow_runner_microvm_unattended.mjs` pass **16/16** locally. The latter covers missing/expired/wrong scope, unarmed/taxonomy mismatch, trip exit126/log/no retry, next-run revocation, actual headless admission with the interactive switch untouched, revocation before result acceptance and final-use exhaustion. Local preimplementation red evidence was recorded before the new entry point existed. These are controlled test-double transports, not a live VM run or accepted native baseline. Existing guest-containment regression passed **90/90**, zero skipped.

**Not delivered yet:** the default signed-run request loader, fixed guest transport/runtime and supervisor wiring, full G8 receipt integration and accepted native fail-first evidence. Missing production drivers fail closed; synthetic backend success must not be described as a working live guest adapter. New baseline acceptance still waits on the separately reviewed loader-classification repair. No live ledger was modified and no guest was launched by this work.

Before unattended activation the genuine standing scope must be recorded or identified and verified at the action boundary. After the classifier fix lands, perform the approved native refresh/behavioral baseline and finish the real transport, G8 tests, mutations, official gates, draft PR and final-head review prompt. The eventual PR must retain this distinction between model, conformance, actual guest execution and owner acceptance.
