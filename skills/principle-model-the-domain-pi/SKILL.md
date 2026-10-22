---
name: principle-model-the-domain-pi
description: When approved stateful logic adds branching or repeats shape assumptions, choose a data structure that expresses valid domain states and ownership. Use explicitly before another lifecycle branch.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Model the domain

Adapted from Lauren Tan's `principle-model-the-domain` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. A domain structure should remove invalid representable states, duplicated rules or scattered lifecycle branches, not merely add an abstraction. Types do not validate untrusted runtime input or grant a migration outside approved scope.

Before adding another `if` branch, synced boolean or phase-specific copy of a rule, identify the **real domain invariant**, legal transitions, writers and reads at the approved entry. Trace the existing shape across authorized callers. Choose the smallest structure that fits actual access: a state machine for phases, a typed/discriminated model for variants, a map/lookup for repeated decisions, a reducer or command/event model for mutations, a small module owning one body of domain knowledge, or a queue/cache/index/graph/tree/normalized collection only where observed access justifies it. These are candidates, not a checklist or automatic registry. If none fits, first list what must never occur and how the data is read, then design to encode that. Organize by **domain ownership**, not merely by execution order (load → validate → transform → save), which can repeat the same rules in each phase.

Compare the proposed structure against the existing boring code: does it actually remove branches, duplicated rules, invalid states or lifecycle risk without hiding a needed security boundary? An already clear, local and stable shape should stay. Validate outside data at its actual entry; prove callers and valid/invalid transitions before removing runtime guards. Check an authorized behavior seam with one accepted transition and one illegal state/transition, including persistence/restart if that is part of the granted domain. Do not equate a type declaration, mock or state-diagram sketch with runtime proof. If the edit/migration grant or real check is missing, offer an evidenced design only and mark implementation/test `blocked`/`unrun`.

- **Positive BDD:** Given an approved stateful change with repeated shape assumptions and a reachable real input path, when Pi models the domain's legal transitions in the smallest justified structure, then approved accepted and rejected transitions preserve observable behavior while invalid combinations and scattered duplicate decisions are reduced.
- **Refusal BDD:** Given a stable clear shape, an unverified external caller, an untrusted entry lacking runtime validation or no migration/check grant, when a new registry/type or guard deletion is proposed, then retain the existing behavior, label the unsafe step `blocked`/`unrun` and do not claim that types alone enforce the boundary.

This skill's existence is not a real state-machine test, a migration or the Pi session registration.
