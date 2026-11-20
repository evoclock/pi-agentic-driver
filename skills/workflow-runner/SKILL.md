---
name: workflow-runner
description: Use the draft PAD workflow CLI for one bounded non-authorizing event and report unsupported Pi tool and procedure-proof gaps.
---

# PAD workflow runner (draft, voluntary)

This skill describes the **draft CLI and registered Pi facade**, not a guarantee of skill adherence or proof of a fresh installed Pi process. Only run inside an explicitly owner-approved repository/effect scope. The runner's `act` is a non-authorizing intent: dispatch only via the existing guarded Pi worker tools, never raw Herdr shell commands. Do not substitute a worker's `verified:true` for PAD's Git/step checks. The CLI cannot independently attribute Herdr worker answers or authorize an outward effect.

1. Read `docs/design/workflow-runner/cli-contract.md` and the exact workflow/skill bytes. A passing generic lifecycle TLC check is not a check of your task graph. Require that task-specific safe and unsafe configs have the expected results before claiming checked execution.
2. In this draft, `pad-runner run --workflow FILE --run-id ID --event FILE --store DIR` processes one event. Its store is exactly one named child of the repository's `.local/workflow-runner/`; the proposed external `--state-dir` and unified command family are **not yet implemented**. Treat a `duplicate:true` act as the original answer, **not** permission to dispatch a second time. Reconcile unknown dispatches before taking another effect. The CLI and Pi tick admit only tick/receipt/wake/look: neither surface exposes ack or trusted absent readback, so an interrupted dispatch cannot obtain its second attempt through these interfaces. CLI cancel/hold are unavailable without a native owner confirmation; use the Pi owner-confirmed tools instead.
3. A receipt must name a new commit after the recorded step base on the expected head. Non-worker steps retain the declared fixed artifact SHA. Spec-backed worker steps freeze the artifact path and record the actual output digest; frozen G8 checks must pass on those exact bytes before advance. The skill must have a `## step: <id>` heading at the frozen Git revision. `procedureDeclared:true` is not `procedureVerified:true`: actual compliance requires a separate trusted step verifier; until present, status is only artifact-checked.
4. A dead-PID writer lock may be retired by the runner's serialized recovery; a live/unknown owner or malformed recovery claim must remain parked for supported reconciliation. A dead recovery claimant with a complete guard record can be retired. Never delete a lock as an agent workaround. Unknown effects must not be resent. A held/cancelled task must not be reset by selecting a new run id.

Pi tools `agentic_workflow_run/_status/_tick/_cancel/_handbrake` are registered on this branch. They operate only on the current trusted checkout and share the draft reducer; they do not dispatch a real worker. Pi cancel/hold require native owner confirmation; CLI cancel/hold and handbrake-off remain unavailable. Release, Transfer and ReconcileOld are not implemented, nor is worker/PR attribution. The absent-after-ack readback rule is conformance-only, not proven needed by an outcome TLC control. If a caller requires those effects, report `capability-unavailable`, not a fake completion. Only a reviewed release and fresh installed Pi process establish installed availability.

Worker workflows require a pinned `spec` manifest and a passing G7 host check before act or dispatch. Submit public `spec` through CLI run or Pi `agentic_workflow_gate`; never inject private `_spec` evidence. A chart pin is optional, but when declared its committed bytes must match the human-confirmed digest. The installed checker is resolved through the source registry and must already be available; no tools are installed during a gate. The derived stack, not caller-selected stack data, goes to dispatch. See `docs/design/workflow-runner/spec-gate.md`.

## G8 completion and gap returns

Submit public `checks` through CLI run or Pi `agentic_workflow_gate` after the receipt. Never inject `_checks`. Effective checks come from the frozen design plus repository defaults; a test per spec invariant and positive observed test counts are mandatory. Failed checks return a structured gap list without spending maxAttempts. Consume the shared producer's handover before redispatch. No-progress, ceiling, zero tests and unknown prior checks effects park rather than loop blindly.

Use `pad-user.v1` to select host, Apple container, Linux or auto. Host runs worker-written code without isolation. Linux uses the guarded native SSH-subsystem route to the backend, never the original proof tool or a raw shell. A scoped standing grant is required for unattended guest checks; attended execution retains the real switch and confirmation. Missing backend/image readiness remains `checks-runner-unavailable`; live-guest acceptance is pending. See `docs/design/workflow-runner/exit-gate.md` and `ssh-guest-check-contract.md`.

## Limits

A declared procedure and artifact-checked receipt do not establish that a worker executed the skill. The draft runner cannot verify worker dispatch, procedure compliance, or an external bot run; keep `procedureVerified:false` and report those gaps rather than claiming DONE from a CLI result.
