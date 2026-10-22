---
name: principle-attack-the-premise-pi
description: After two fixes fail the same gate under one shared assumption, state and falsify that assumption before another fix. Use explicitly for repeated failures in an approved task.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Attack the premise

Adapted from Lauren Tan's `principle-attack-the-premise` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. A principle changes one decision; it does not authorize a test, app launch or refactor.

When **two or more fixes sharing one premise fail the same observable gate**, write the shared premise as one falsifiable sentence. Record what each fix assumed and the **distribution** of failures, not only their severity. Before a third fix, choose a bounded observation whose result differs if the premise is false. Make it rerunnable if a small approved check exists; read a loaded `principle-build-the-lever-pi` leaf before citing it. If the observation contradicts the premise, trace what failures share that the premise missed. If it confirms it, follow the next causal “why” until a specific first wrong decision is identified; do not attempt another same-premise fix merely because this premise survived. A later fix must address the observed mechanism within the existing grant. Read `principle-fix-root-causes-pi` if loaded before crediting it. Prefer removing a proved losing condition to paying for a cleanup on every run; `principle-laziness-protocol-pi` applies only when loaded and its rule was read. Distinguish this factual challenge from `principle-redesign-from-first-principles-pi`, which integrates a new requirement. If no authorized observation can distinguish the premise, report a testable hypothesis and `unrun` check; **do not implement a third same-premise fix**.

- **Positive BDD:** Given two source/evidence-backed failed fixes under one stated premise and an approved check, when Pi runs the check, then it records a differentiating observation, updates the hypothesis and changes or declines the next fix accordingly.
- **Refusal BDD:** Given no shared premise, no observed same-gate failures or no grant to run the differentiating check, when another same-premise fix is proposed, then cite the two actual failed attempts if they exist, name the absent evidence, mark the test `unrun` and do not invent a failure, proof, worker or permission.

Temporary Pi skill discovery is not the premise test.
