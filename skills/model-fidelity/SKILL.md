---
name: model-fidelity
description: Compare a built change to its frozen original plan and model assumptions. Use for protocol, lifecycle, crash recovery, locks or light statechart work; keep gaps visible without holding delivery.
---

# Model fidelity

Use this driver-owned skill when a model claims a real action is safe. The CLI currently supports only `prepare`, `diagram` and `read`. `check`, `assess`, `evaluate` and MCP are future operations. Do not issue those calls or claim their evidence exists. The upstream statechart skill remains separate; load it for a real TLC check if installed.

## Workflow

1. Save the original plan, including the current-generation rule and permitted post-death completion, in a repository-relative JSON file. Freeze it with `prepare` before changing its meaning. In protocol mode, name each actor, session, fault, effect point, resource generation and relevant reassignment. Use light mode for ordinary screen flows; label correspondence `implementation-correspondence-not-assessed`. If light mode is chosen for a protocol, report `protocol-detail-omitted` in the caller's findings.
2. Draw the initial lifecycle and results views with `prepare`. Inspect its findings and its manifest. A missing design, unproven all-at-once step, absent map or failed render is a visible gap, not permission to describe a verified implementation. Do not treat a green picture as a checker result. Read [worked cases](./examples.md) for concrete request and response branches.
3. Build through the caller's existing authorized workflow, without waiting for a model approval. Capture changed source and revised model in a new attempt. Cite the first `planId`; never overwrite the original plan or an earlier bundle. Use a new `attemptId` and `requestId` for changed bytes.
4. `diagram` the captured bundle and `read` approved artifacts. Keep all view records, including `unavailable` and `not-applicable` with reasons. In protocol mode, action-map and fault-window currently return `unavailable` with findings; do not describe these as rendered. Record check, review, runtime and rollback steps separately in the caller's workflow; this CLI cannot perform them yet. Independent review is useful but not an approval stage.
5. Compare the built behavior with the frozen plan and the actual effect-time mechanism. An old cleared action may finish after sender death on the same generation. Before an effect on a reusable resource, the implementation must ensure the generation still owns it, without an unprotected gap between check and effect. A conditional write in the authoritative store can support a safe shortcut when reassignment uses that same mechanism. A remembered token, lock snapshot or transaction around an uncoordinated external address cannot. Name the operation, assumptions and untested schedules. No mechanism name alone proves the claim.
6. Deliver the built result and findings together. Missing checks, missing reviews, unsupported abstraction, renderer failure and tool errors remain visible and do not hold unrelated delivery. For a confirmed raw-data overwrite or key-asset deletion, stop only that offending action and report the red line. Never delete a relied-on asset without prior deprecation and later review. If correction is needed, use the caller's authorized process and preserve before/after evidence. This skill does not grant authority to roll back, merge or publish.

## CLI contract

From the approved repository root, call `node scripts/model_fidelity.mjs prepare|diagram|read --json REQUEST_FILE` with closed stdin. `REQUEST_FILE` is repository-relative. The result is one JSON object on stdout. Exit 0 includes partial evidence and findings with `continuation: "continue"`; exit 2 is invalid input, and exit 3 is an operational or conflict error. On exit 2/3, record the typed error and continue other scoped work. If interrupted without JSON, record the attempt as uncertain; never infer success or blindly replay it. The private local store is `.scratch/model-fidelity/`, without durable retention. The host owns build, runtime observation, review and red-line enforcement; CLI output never grants authority.

## Limits

This is guidance, not proof of compliance. `prepare` inspects declared records but does not run a checker, assess semantic adequacy or verify code. Full protocol diagrams remain unavailable until their operations are implemented. A renderer failure is reported, not hidden. The workflow cannot run a build, authorize review, execute rollback or publish work.
