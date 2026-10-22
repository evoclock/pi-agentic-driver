---
name: principle-encode-lessons-in-structure-pi
description: When an approved team repeats an instruction or correction, make the rule enforceable in structure if possible; keep a prominent example if judgment is irreducible. Use explicitly for a proved repeated failure.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Encode lessons in structure

Adapted from Lauren Tan's `principle-encode-lessons-in-structure` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. Unlike `principle-build-the-lever-pi`, which builds a rerunnable work artifact, this method makes a **repeated rule** hard to violate in future work.

When the same instruction needs writing twice or a correction recurs, cite the observed occurrences and name the failure class. Look for the **smallest** authorized structural enforcement point in the actual repo: a domain shape, metadata flag, lint, type, runtime boundary check or test/script. Reuse existing checks before writing another. Make an approved historical bad case fail with an actionable message, then a correct case pass, and verify the actual entry where the rule matters. Do not add global hooks or hooks that intercept unrelated commands for a speculative recurrence. If a structural fix fully handles the issue, **use it alone**, not a redundant instruction alongside it; the text was the symptom. If judgment cannot be encoded without false positives or a missing product choice, make the instruction prominent, add one concrete failure example and say why no mechanical enforcement is safe. Work within the authorized paths; a principle does not approve hook installation, CI mutation, a broad history scan or a new board card.

- **Positive BDD:** Given two evidenced instances of a repeated error and an approved enforcement seam, when Pi adds the smallest reusable structural check and exercises old-bad and correct inputs at the real entry, then the bad path fails, the good path passes, and no duplicate rule text is needed.
- **Refusal BDD:** Given a single anecdote, an uncertain rule or no grant for hooks/CI/runtime effects, when structural enforcement is considered, then leave the app unchanged, name the missing proof/grant and offer only a bounded judgement instruction with a real example when warranted; mark an unrun enforcement check `unrun`.

An independently reviewed draft skill is not a deployed guardrail.
