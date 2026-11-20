# TLC evidence: bounded runner lifecycle (FIX5)

Model SHA-256 `367c486ff4159f5c27d24b41d62d9e3c0f3b0de958e6b2ba538a563a8f58ffad`; safe config SHA-256 `431a589dbbcbf6dc3e714017c94237daa8214977aee48f38233f5c140a3e446f`; live config SHA-256 `f0a83b972c87aca270dff1590e1e95cdeb81e88798eeea84b28b1bcd3ed6e9c7`; probe module SHA-256 `ef3bbaf1205569c8f9e1545ce8013d1f95d630eb5377e7a888b7ac2a8b0102f8`. Checker: installed tla2tools 1.7.4 jar SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`, Homebrew OpenJDK. Fresh one-worker TLC runs used copies and metadata directories under ignored `.local/workflow-runner-fix5/`; final raw output was copied here. Safe/live and positive probes exited 0; controls exited 12 for their named invariant. State counts below are generated / distinct / queued. No system tool was installed.

| Config | Recorded outcome | States |
| --- | --- | --- |
| [safe](WorkflowRunner.cfg) | [No error](tlc-fix5-WorkflowRunner.out) | 177,846 / 34,954 / 0 |
| [fair-host](live.cfg) | [DONE or exhausted](tlc-fix5-live.out) | 782 / 271 / 0 |
| [unsafe-journal](unsafe-journal.cfg) | [DispatchHasIntent](tlc-fix5-unsafe-journal.out) | 4 / 4 / 1 |
| [unsafe-dispatch](unsafe-dispatch.cfg) | [NoAdvanceWithoutDispatch](tlc-fix5-unsafe-dispatch.out) | 474 / 223 / 145 |
| [unsafe-epoch-stamp](unsafe-epoch-stamp.cfg) | [ResultEpochIsDispatchEpoch](tlc-fix5-unsafe-epoch-stamp.out) | 100 / 66 / 49 |
| [unsafe-writer-stamp](unsafe-writer-stamp.cfg) | [ResultWriterIsDispatchWriter](tlc-fix5-unsafe-writer-stamp.out) | 109 / 71 / 53 |
| [unsafe-readback](unsafe-readback.cfg) | [NoBlindResend](tlc-fix5-unsafe-readback.out) | 1,150 / 484 / 288 |
| [unsafe-trust](unsafe-trust.cfg) | [NoTrustedAdvance](tlc-fix5-unsafe-trust.out) | 66 / 53 / 40 |
| [unsafe-dispatch-id](unsafe-dispatch-id.cfg) | [NoOwnDispatchAdvance](tlc-fix5-unsafe-dispatch-id.out) | 4,410 / 1,516 / 679 |
| [unsafe-ack-resume](unsafe-ack-resume.cfg) | [NoUnackedResume](tlc-fix5-unsafe-ack-resume.out) | 36 / 34 / 24 |
| [unsafe-ack-reconcile](unsafe-ack-reconcile.cfg) | [NoAcknowledgedReadback](tlc-fix5-unsafe-ack-reconcile.out) | 28 / 26 / 17 |
| [unsafe-cancel-phase](unsafe-cancel-phase.cfg) | [NoCancelTerminal](tlc-fix5-unsafe-cancel-phase.out) | 3 / 3 / 1 |
| [unsafe-cancel-epoch](unsafe-cancel-epoch.cfg) | [NoCancelEpochGap](tlc-fix5-unsafe-cancel-epoch.out) | 3 / 3 / 1 |
| [unsafe-writer-transfer](unsafe-writer-transfer.cfg) | [NoOldWriterAdvance](tlc-fix5-unsafe-writer-transfer.out) | 284 / 158 / 112 |

The first eleven unsafe configs each remove one guard and fail their named invariant. **Do not infer all eleven are necessary for a safety outcome.** The ack-resume and ack-reconcile invariants restate their recovery-rule guards: removing either or both guards while omitting those restating invariants does not break a checked outcome or fair-host liveness. They are defence-in-depth **conformance checks**, not proven-needed resend fences. Similarly, `NoCancelEpochGap` restates the cancel increment; disabling only that bump leaves reachable state counts and outcomes identical. The **terminal cancel phase** is the actual modeled stop fence; the cancel epoch is defence in depth. The trusted-result, dispatch-ID, readback and cancel-phase controls protect modeled consequences. Unknown readback is an explicit no-op and never authorizes a resend.

The writer match at Advance and Transfer's epoch bump cover for each other: removing either alone leaves old-writer outcome checks intact, but [removing both](unsafe-writer-transfer.cfg) violates `NoOldWriterAdvance`. This combined control deliberately changes **two** constants; it is not one of the eleven single-guard checks. The old Fence, Writer, Wake, Hold and combined Cancel controls were retired as redundant. `lastJournal` and `unknownSeen` remain removed, and unverified reports cannot clear an existing trusted good result or verified-wake flag.

## Ported second-review probes

[`OpusRe2.tla`](OpusRe2.tla) extends the **current** model. The four safety probes and L3–L6 pass under their declared assumptions:

| Port | Recorded outcome | States |
| --- | --- | --- |
| [NoAdvanceWithoutDispatch](probe-re2-no-dispatch.cfg) | [No error](tlc-fix5-probe-re2-no-dispatch.out) | 177,846 / 34,954 / 0 |
| [PortResultEpochIsDispatchEpoch](probe-re2-epoch.cfg) | [No error](tlc-fix5-probe-re2-epoch.out) | 177,846 / 34,954 / 0 |
| [PortResultWriterIsDispatchWriter](probe-re2-writer.cfg) | [No error](tlc-fix5-probe-re2-writer.out) | 177,846 / 34,954 / 0 |
| [AdvanceOnlyTrusted](probe-re2-trust.cfg) | [No error](tlc-fix5-probe-re2-trust.out) | 177,846 / 34,954 / 0 |
| [L3 + stale observations](probe-re2-L3.cfg) | [No error](tlc-fix5-probe-re2-L3.out) | 1,422 / 419 / 0 |
| [L4 + fair owner release](probe-re2-L4.cfg) | [No error](tlc-fix5-probe-re2-L4.out) | 4,182 / 1,412 / 0 |
| [L5 + transfer/readback](probe-re2-L5.cfg) | [No error](tlc-fix5-probe-re2-L5.out) | 3,361 / 1,038 / 0 |
| [L6 + unverified reports](probe-re2-L6.cfg) | [No error](tlc-fix5-probe-re2-L6.out) | 1,372 / 403 / 0 |

The `mut-ack-resume`, `mut-ack-reconcile` and `mut-cancel-noepoch` probe families correspond to the **conformance-only** controls above. `mut-dispid-eq` corresponds to unsafe-dispatch-id. `mut-cancel-noepoch-nonabsorb` corresponds to [probe-re2-cancel-nonabsorb](probe-re2-cancel-nonabsorb.cfg), which [violates NoCancelTerminal](tlc-fix5-probe-re2-cancel-nonabsorb.out), 3 / 3 / 1. `mut-stopped-guard-only` refers to the retired redundant stopped guard. **`mut-wakeguard-unknown` refers to the retired unknown-readback guard (`~unknownSeen`), not a wake guard**: unknown readback is now a no-op. The original `fixtry/` safety and liveness configs map to these committed checks; its `u-EpochStampGuard` and `u-WriterStampGuard` map to failing controls, while `u-FenceGuard`, `u-WriterGuard` and `u-WakeGuard` refer to redundant retired controls. L4/L5 fairness is an explicit scenario assumption, not unconditional liveness under human holds or uncertain effects.

`tests/test_workflow_runner_model.mjs` **audits committed logs and pinned model bytes only**. It does **not** run TLC or detect a removed guard if the documented digest is also changed. The fresh runs above, their single-guard controls and the paired control are the current evidence. Older `tlc.out`, `tlc-checked-*`, `tlc-fix2-*`, `tlc-fix3-*` and `tlc-fix4-*` outputs are superseded. Finite transitions do not establish host readback, worker identity, actual procedure compliance, fsync or runtime conformance. [`action-map.json`](action-map.json) names expected runtime checks only; the composition diagram has no pinned generator/input provenance.
