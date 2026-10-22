---
name: principle-exhaust-the-design-space-pi
description: For a novel UI interaction, architectural fork or feel-dependent product choice with no precedent, compare two or three approved prototypes side by side before committing to a design. Use explicitly for an empirical design fork.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Exhaust the design space

Adapted from Lauren Tan's `principle-exhaust-the-design-space` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. A design claim, a three-option prose list or an AI vote is not a prototype. Look for a codebase precedent first and avoid ceremony when an established solution applies.

When an interaction, architecture or product experience has a genuine unsettled fork, name the observable decision, constraints and approved scratch location. Build **two or three different small, isolated prototypes** that can answer the fork cheaply; they are throwaway evidence, not production code. Compare side by side on the **same authorized surface** with actual observations: working interaction, screenshots for visual choices, behavior or timing for architectural ones. State tradeoffs and recommend the best fit against the user's experience, then ask for an owner decision only where the preference is irreducible. Do not install dependencies, fetch CDN scripts, launch an app, spawn candidates or share a mutable instance merely because this principle names prototypes. If no real prototype route is granted, present the proposed experiment and mark the comparison `unrun`; do not claim a winner from prose alone. Subsequent production implementation belongs to a separately accepted Feature/`architect-pi` route, not this throwaway choice.

- **Positive BDD:** Given a novel approved design fork and safe target, when Pi builds two or three isolated variants and observes them side by side on the same surface, then it recommends a choice with cited comparative artifacts before production code is committed.
- **Refusal BDD:** Given a known precedent, no safe app/target, shared instance conflict or no scratch/effect grant, when a prototype would cross that boundary, then reuse precedent or mark comparison `blocked`/`unrun`, with no fabricated screenshots, hidden install or automatic feature merge.

Temporary Pi discovery does not prove a prototype comparison.
