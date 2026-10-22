---
name: principle-redesign-from-first-principles-pi
description: When an approved new requirement changes an existing design invariant, reason from that requirement as if it had been foundational and propagate its consequences. Use explicitly before an architectural bolt-on.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Redesign from first principles

Adapted from Lauren Tan's `principle-redesign-from-first-principles` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. A redesign thought experiment does **not** grant a broad rewrite, public-document edit, worker fan-out or a new owner decision. Distinguish this from challenging a failed assumption: here an **accepted new requirement** changes the intended design.

Read the affected design, entry points, callers and contracts **within the granted repository/data range**. State the original invariant, the new accepted requirement and their conflict. Ask: “If this new requirement had been foundational, what design would we choose?” Compare the resulting domain shape, ownership and boundary to a local bolt-on and to the current design; name what the existing design already does well. Trace the chosen change through all relevant **approved** references: types, code, tests, documentation, examples and rationale/decision sections. Do not update public docs with private rationale or silently widen the approved file scope. If an affected reference is inaccessible, name it and hold the affected completion claim rather than assert full propagation.

Think through the whole resulting shape and its compatibility/one-way-door costs **before editing**, then implement only owner-approved small, independently checkable increments toward it. Keep behavior-level checks for both the accepted requirement and existing supported paths; a speculative rewrite that merely relocates code is not a first-principles outcome. Where the task settles only a design proposal, stop at that proposal with evidence and owner-held choices. If no grant covers a needed migration, do not bolt on an unsafe interim adapter or claim the final design already exists; mark that phase `blocked`/`unrun`.

- **Positive BDD:** Given an owner-accepted new requirement that changes a proved invariant and accessible affected references, when Pi compares a from-scratch design with a bolt-on and propagates the chosen scoped design in verifiable increments, then approved tests and real entry observations support both the new behavior and retained compatibility without divergent assumptions.
- **Refusal BDD:** Given no accepted design direction, incomplete affected-file access, missing edit/runtime scope or an unapproved public documentation path, when a broad redesign or completion claim is proposed, then provide only an evidence-backed design option, mark affected work `blocked`/`unrun` and leave owner-held choices intact.

A reviewed principle draft does not mean a production redesign, deployment or live Pi test happened.
