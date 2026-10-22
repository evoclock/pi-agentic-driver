---
name: principle-subtract-before-you-add-pi
description: Before an approved addition, refactor or rewrite, look for proven dead code and redundant structure to remove so the new work starts from a simpler base. Use explicitly when sequencing a change.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Subtract before you add

Adapted from Lauren Tan's `principle-subtract-before-you-add` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. Subtraction is a **sequence and design choice**, not permission to delete safety guards, legal notices, evidence, public APIs, tests or another owner's work. A smaller surface should still satisfy the full accepted specification.

Before adding a module, layer, validation rule or template, inspect actual usage and prior art in the approved paths. Identify dead code, duplicated non-load-bearing validation, excess prompt instructions and references with no novel content; cite the callers and why each proposed removal is safe. **Remove only proved and separately authorized** obsolete pieces first, verify accepted and consequential negative behavior at the real boundary, then construct the smallest design serving observed usage. Do not keep a content-free reference stub solely for an old path, but preserve compatibility when a real consumer still needs it. Cut unnecessary shape before polishing it; do not defer correctness, usability or safety checks as “polish”.

Avoid validators, parsers and guards for speculative edge cases **beyond the accepted spec**; retain required external-input validation and load-bearing containment/authority checks even if they look repetitive. A type, inner-code assumption or search miss does not prove a guard redundant. If a prompt has redundant prose, simplify only within its owner-approved instruction boundary and preserve the actual rule. If no safe removal is proved, reuse existing structure and implement only the accepted addition rather than manufacturing a deletion target. Keep the resulting design slightly simpler and more capable when evidence supports it; report complexity as a diagnostic, not an invented line-count budget.

- **Positive BDD:** Given an approved addition with evidenced unused/redundant structure and permission to edit it, when Pi removes that structure first and verifies real accepted/refusal behavior, then the new scoped change can use a smaller base without losing a supported path.
- **Refusal BDD:** Given an unknown consumer, unproved safety validator, protected instruction, no removal grant or missing real check, when deletion is proposed, then keep it, mark subtraction `blocked`/`unrun` and do not claim a smaller diff proves correctness.

This method's discovery does not perform a deletion, run behavior checks or load a the Pi session skill.
