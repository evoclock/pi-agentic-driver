---
name: principle-foundational-thinking-pi
description: Before approved stateful code, choose domain data shapes, access patterns, shared-state ownership and useful scaffolding so later features stay simple. Use explicitly for a foundational implementation choice.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Foundational thinking

Adapted from Lauren Tan's unchanged `principle-foundational-thinking` body at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. Structural decisions protect future options; local code decisions protect simplicity. This principle does not authorize a redesign, deletion, CI change, worker, commit or broad refactor.

**Shape before logic.** For an approved change, identify the core domain types and data structures first. Trace actual access and update patterns, then choose the shape that serves dominant paths; do not build a generic framework around a hypothetical use. Let types and data models converge, but do not DRY every repeated line: three clear similar statements can beat a premature abstraction. Prefer explicit code, with behavior and edge-case checks instead of line-count targets. If source evidence does not identify the dominant path, record the uncertainty and hold an irreversible shape choice.

**Ownership before sharing.** Name every actor that can mutate each shared state and ask what happens if another actor modifies it concurrently. If the answer is not “nothing”, isolate state/ownership before choosing serialization, a lock or a retry; a Treehouse lease, type or test is not containment. Verify the real concurrent boundary only with an approved test surface; otherwise mark that check `unrun` and do not assert race freedom.

**Sequence for option value.** Examine proved dead code before adding scaffolding, but delete only inside a separately approved scope with caller and compatibility evidence. Put a small shared type, test seam or CI/lint foundation first only when it demonstrably helps the later authorized phases and prior art cannot serve; do not change global CI from this principle alone. Preserve red-capable tests before fixes. Make each approved increment a coherent abstraction or a deepening of one that exists, rather than scattering special cases among callers. Keep any separately authorized commits single-purpose; a draft method never commits by itself. Contrast this with the experience-first principle: foundation selects **when** to build, user experience selects **what** the accepted task serves; read a loaded leaf before citing it as applied.

- **Positive BDD:** Given an approved stateful feature with traced access patterns and concurrent actors, when Pi chooses a core data shape and state owner before feature logic, then a small verifiable unit handles actual dominant and edge paths without distributed special cases or unproved sharing.
- **Refusal BDD:** Given unknown callers, unmeasured usage, no concurrency check, no deletion/CI grant or an adequate existing foundation, when a new abstraction or scaffold is proposed, then preserve current behavior, mark missing checks `blocked`/`unrun` and do not delete code, alter CI or claim safe concurrency.

Skill discovery does not prove a new data shape, test a race or register a Pi resource.
