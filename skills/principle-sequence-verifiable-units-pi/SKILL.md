---
name: principle-sequence-verifiable-units-pi
description: For approved multi-step sweeps, migrations or edit runs, order small units so each has an observable check before the next and the review history is replayable. Use explicitly before batching changes.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Sequence work into verifiable units

Adapted from Lauren Tan's `principle-sequence-verifiable-units` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This principle orders accepted work and its review story; it does not authorize a rebase, extra worktree, commit, push, stacked PR or owner-held merge. Use a clean, approved baseline from the actual target revision; a task's existing dirty files cannot be reset away to manufacture one.

Split an approved sweep or migration into small independently testable units. Each has a **known-good baseline → one scoped change → predeclared check → recorded result**. Check the exact affected artifact and consequential negative behavior at the real seam when authorized; even a lever that made every edit mechanically cheap still needs its per-unit check. A failure is `NOT VERIFIED`, not green; stop dependent units, inspect the observation method and correct the failing unit within grant before proceeding. If a check needs a missing app/effect grant, record `blocked`/`unrun` and do not use a static proxy to certify that unit. Independent unrelated units can proceed only within their existing grant and separate ownership.

When Git delivery is separately authorized, arrange small single-purpose changes in the order that **proves** the result to a reviewer: failing behavior check before the fix; observed baseline before treatment; justified subtraction before reshape; shared scaffold before dependent feature. Ensure each step has its own truthful check and leaves a reviewable state, then report exact base, units and unresolved paths. Do not force a failing test into public `main`, assert an intermediate production-safe state without proof, automatically rebase a dirty branch, or open a PR simply because a story could be stacked. The source's “rebase onto clean trunk first” becomes **start from a checked clean current baseline** under the approved Git route; an existing branch is reconciled separately without losing work. A real final user outcome still requires `principle-prove-it-works-pi` only if loaded; a cheap lever follows its own approved route, not an assumed command.

- **Positive BDD:** Given an approved multi-step task and a clean known baseline with real checks, when Pi brackets each unit with a declared observation and advances only after that unit's check passes, then the resulting reviewed sequence localizes failures and demonstrates each verified transition without proxy-only completion claims.
- **Refusal BDD:** Given a failed/unrun check, unowned dirty baseline, missing verification grant or unapproved Git delivery, when the next dependent unit, reset or PR would need it, then hold that action `blocked`/`unrun`, preserve evidence and do not rebase, fabricate green or publish.

A reviewed draft skill is not an executed sequence, authorized PR stack or live Pi journey.
