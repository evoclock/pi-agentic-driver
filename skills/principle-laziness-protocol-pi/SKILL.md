---
name: principle-laziness-protocol-pi
description: For an approved refactor or proposed new layer, consolidate repeated decisions and choose the smallest behavior-preserving change. Use explicitly before expanding a diff.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Laziness protocol

Adapted from the **pinned live** Lauren Tan `principle-laziness-protocol` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. The live body has only two rules: consolidate decisions and minimize the diff. The older installed source has extra flat-hierarchy and signal-threading advice; do not turn those older thresholds into mandatory Pi rules. Shorter code is a goal only after behavior, compatibility and safety remain intact; line count is a diagnostic, not a veto.

For an approved change, find each place that makes **the same choice**. If these are truly one policy decision, choose the actual owner and compute it once there; pass the result as a simple flag to consumers that need it, instead of duplicating the choice. First check prior art, callers, inputs and effects to avoid creating a new global singleton or leaking policy across a trust boundary. If the decisions have different owners or timing, keep them separate and explain why.

Compare the smallest edit that solves the observed problem with a proposed abstraction, layer or boilerplate. Favor a narrowly scoped reuse or proved deletion over added coordination, but delete only if the task grants it and the real callers/negative paths have been checked. Verify the accepted behavior and the case that must still be rejected at the actual authorized entry. A smaller diff that hides an error, drops an approved feature or weakens a guard fails this principle. Do not remove comments, tests, checks, or evidence just to reduce a count; record why the retained code exists. No automatic commit, PR or merge follows.

- **Positive BDD:** Given an approved refactor with repeated equivalent decisions and an observable behavior test, when Pi centralizes the choice at its proved owner and makes the smallest permitted edit, then the real accepted and rejected paths keep their behavior with less duplicated decision logic.
- **Refusal BDD:** Given distinct policy owners, unknown callers, no approved deletion/test surface or a safety guard without replacement proof, when a short diff would erase needed behavior, then leave it intact, mark the risky step `blocked`/`unrun` and explain the missing evidence instead of applying a line-count rule.

Pi discovery is not a verified refactor or permission to delete code.
