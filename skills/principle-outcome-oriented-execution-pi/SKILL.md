---
name: principle-outcome-oriented-execution-pi
description: For an approved phased rewrite or migration, aim for a verifiable final architecture rather than accumulating temporary compatibility layers. Use explicitly when planning accepted transition checkpoints.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Outcome-oriented execution

Adapted from Lauren Tan's unchanged `principle-outcome-oriented-execution` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This is a planning and sequencing principle, not permission to break a deployed service, public API, shared branch or another user's workflow. An incomplete migration must not be presented as verified product functionality.

For an **approved planned rewrite or migration**, name the desired final architecture and its real, observable completion predicate. Break the work into declared phases with owner-approved paths, safe exit and checks. State precisely **where temporary breakage is acceptable**, who owns that surface, how it will be observed, and when it must be resolved. Prefer a reversible, isolated intermediate state that reaches the end state over a throwaway compatibility layer that may outlive the transition. End-state integrity takes precedence over keeping every internal interim step green **only within the explicitly accepted boundary**. An undeclared runtime, customer or security failure is not a planned transition.

Keep high-signal checks on actively touched code during each phase, recording which checks intentionally remain red and why, rather than deleting the tests or changing the oracle. At each boundary inspect the actual changed artifact and fix unexpected breakage before the next unit. At plan completion require the **full relevant static and real runtime/user-path checks** before declaring the migration done. If no approved runtime entry or safe target exists, report completion `blocked`/`unrun` even when unit checks pass; do not paper over this with an adapter or self-report. A safety guard, external compatibility contract or owner-held merge/push gate is not expendable merely because the target design is simpler.

- **Positive BDD:** Given an approved phased migration with a declared isolated breakage window and actual final-state checks, when Pi sequences changes toward the target and checks each affected boundary, then the final static and runtime observations satisfy the initial predicate without leftover temporary compatibility code.
- **Refusal BDD:** Given undeclared breakage, a shared/public path, missing owner direction, safe exit or runtime check, when a phase would disrupt that surface or claim completion, then retain the existing contract, mark the affected phase `blocked`/`unrun` and do not merge, disable tests or claim the intended outcome.

Explicit Pi discovery is not a completed migration, live runtime proof or the Pi session skill registration.
