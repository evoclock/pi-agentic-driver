---
name: principle-make-operations-idempotent-pi
description: Design an approved state-mutating command or lifecycle step to converge across duplicate runs and crashes by reconciling actual state. Use explicitly before a retriable effect.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Make operations idempotent

Adapted from Lauren Tan's `principle-make-operations-idempotent` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. A convergent design is **not** permission to retry, replay a remote effect, clean another run's files or assume an owner-approved effect grant. This principle applies to commands, lifecycle steps and processing loops that may stop or repeat.

For each proposed state mutation, name the target end state and the actual state it can observe after a partial run. Ask “what if it runs twice?” and “what if the prior run stopped after **each** observable write, claim or send?” Derive each next step from **current state versus desired state**, not from a previous run's intent. Apply only the proved difference, then re-read the real boundary to check convergence. Identify the operation's stable identity and owner; do not turn a transient marker or worker receipt into proof an outside effect did or did not occur.

For every artifact left behind (lock, temporary file, partial record or claimed job), specify evidence of liveness/ownership and a staleness decision valid at **all possible crash points**. Prefer an atomic publish of a prepared file or content comparison when that matches the actual filesystem contract, rather than assuming creation order is authoritative. A marker that cannot be judged after restart requires reconciliation or an explicit hold, not automatic cleanup. An ambiguous network send, shared process or committed external action is **uncertain**, not safe to send again merely because a local record is missing. Reconcile it using an approved read-only target query and explicit idempotency contract, or stop for the owner.

Under an approved isolated test seam, check a normal run, immediate duplicate, and controlled stop/restart at the reachable transition boundaries; require the same final observable state, no extra externally visible effect and no run-owned residue without a supported recovery path. Never inject crashes, repeat real sends or reset shared resources without a separate data/effect/safe-exit grant. If a step's result depends on ambiguous partial state, add a scoped reconciliation step or report the gap as `blocked`/`unrun`, not an invented exactly-once guarantee.

- **Positive BDD:** Given an approved stateful operation, stable identity, observable end state and authorized isolated interruption seam, when Pi compares current with desired state across a normal run, duplicate and partial-run recovery, then all converge to the same observed result with no duplicate external effect or orphaned run-owned state.
- **Refusal BDD:** Given an ambiguous prior send, unjudgeable stale marker, shared owner or absent crash-test grant, when repetition or cleanup is proposed, then hold the effect `blocked`/`unrun`, name the reconciliation evidence needed and do not replay, delete or claim convergence from a receipt.

This draft skill is not proof of crash recovery, a real duplicate-safe effect or Pi loading.
