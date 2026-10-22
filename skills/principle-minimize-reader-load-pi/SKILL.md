---
name: principle-minimize-reader-load-pi
description: For an approved hard-to-trace code change, reduce the layers and mutable state a reader must track without erasing useful boundaries. Use explicitly during a scoped maintainability review.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Minimize reader load

Adapted from Lauren Tan's `principle-minimize-reader-load` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. Reader load has **two independent axes**: layers between a question and its answer, and hidden/mutable state a reader must hold. A flat module with many globals can be as hard as many pass-through adapters. LOC, cyclomatic complexity and an architecture label are proxies, not automatic rejection thresholds. This is the human counterpart of `principle-guard-the-context-window-pi` **only when that actual Pi leaf is loaded**.

Pick an approved concrete reader question: “Where does this value come from?” and “What can change it?” Trace from the actual entry through each layer and owner. Use the source's **under-30-second new-reader test** as a diagnostic, not as an invented hard gate: show the question, observed path and what made it hard. Inspect all relevant callers and external boundaries before proposing to collapse a one-caller wrapper, an adapter with no second implementation, or an unnecessary speculative/pass-through layer. Keep a layer that genuinely changes abstraction, compresses a broad interface into a meaningful decision, or owns a security/error boundary. A layer with identical methods and arguments but no added invariant is a candidate to inline only when the task grants the edit and caller/behavior checks prove equivalence.

Trace mutable state separately: favor returns over mutation and local values over fields, fields over module state and module state over globals when that ordering actually serves ownership. Derive a value instead of synchronizing copies if the real update path permits it. State an invariant once at the validated boundary rather than duplicating its explanation in each consumer; do not remove a guard while outside callers can still bypass validation. Before adding a layer or state, explain how it saves at least as much reader work elsewhere; if not, keep the simpler path. Verify the original behavior and failure/invalid-input path at the authorized real entry after an edit. If no edit or runtime grant exists, give the traced map and an unrun simplification proposal, not a claim that maintainability improved.

- **Positive BDD:** Given an approved change with a traced reader question, caller map and behavior seam, when Pi removes proved pass-through indirection or reduces mutable scope, then a reader can follow the actual owner/change path more directly and real valid/invalid behavior remains unchanged.
- **Refusal BDD:** Given unknown callers, an unverified validation/security boundary, a layer that hides necessary policy or no edit/check grant, when an inlining or state reduction is proposed, then retain the boundary and mark the candidate `blocked`/`unrun`; do not trade a safety invariant for fewer lines.

Skill discovery or source inspection alone is not a real reader study, applied simplification or the Pi session-loaded route.
