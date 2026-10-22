---
name: principle-boundary-discipline-pi
description: Place validation and error handling at real CLI, config, network or external API boundaries, while keeping trusted domain logic simple. Use explicitly when shaping an approved adapter or validation change.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Boundary discipline

Adapted from Lauren Tan's `principle-boundary-discipline` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This is a code-organization method, **not** a claim that types or a lease enforce runtime containment.

First draw the **actual** boundary: CLI arguments, config reads, external API responses, network messages, file formats or another outside input. At entry, validate and narrow into a domain value or reject with an actionable error. Expose domain concepts rather than passing raw transport/storage/framework types into the public domain API. Keep general mechanism internal, special-purpose policy at the edge, and the framework shell thin. Within code that receives genuinely validated domain values, remove redundant re-validation and keep business transforms and scoring pure where possible. Ask at each guard, “Is this crossing a real boundary **now**?” and at each framework-heavy function, “Can a pure function do the domain work?” Validate config when parsed, not deep inside its consumers.

**Trust is conditional:** prove all relevant external entry points actually parse the value before removing a guard. Types, compiler checks and function-local assumptions do not establish authority, safe filesystem paths or protection from malicious outside data. Do not strip a load-bearing safety check or soften a denial in the name of reducing noise. Handle invalid input at the real entry and test both an accepted domain value and a rejected outside value before calling the reshape safe. Unknown call paths or insufficient edit grant leave the existing check intact with an evidence gap.

- **Positive BDD:** Given an approved adapter and identified untrusted entry, when Pi traces calls and tests valid/invalid input at that entry, then parse-time errors and a pure domain path replace proved redundant inside guards without weakening the outside denial.
- **Refusal BDD:** Given an unverified caller, external input still reaching the inner function or a safety guard without equivalent boundary proof, when a deletion is proposed, then retain it and mark the proposed simplification `blocked`/`unrun`; do not assume a type is containment.

This skill file does not drive an app or prove a boundary by itself.
