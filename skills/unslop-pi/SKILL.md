---
name: unslop-pi
description: Edit approved prose to remove AI-sounding patterns and filler without changing facts, voice, evidence or intended audience. Use explicitly for a writing cleanup.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Unslop for Pi

Adapted from Lauren Tan's `unslop` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. Preserve the source's **stable rule numbers and intentional gaps** so sibling skills can cite them. This is a language edit, not permission to alter product behavior, evidence, legal/licence text, quoted user words, code identifiers, owner-approved public copy or publication destination. Preserve meaning, necessary uncertainty, human warmth and the intended voice. A heuristic finding is not an automatic deletion.

Scan the scoped text, then replace only real offenders with concrete wording:

- **3, 5 content:** remove unsupported decorative “highlighting/ensuring/showcasing” clauses; name the actual source for “experts believe” or cut the claim.
- **7–12 language:** replace vague AI vocabulary (“delve”, “pivotal”, abstract “landscape”, “tapestry”) and fancy “is” (“serves as”, “stands as”) with plain facts. Say “Y” directly instead of “not just X, but Y”. Do not force threes, cycle synonyms for one thing, or use a fake “from X to Y” range.
- **13–19 style:** remove em dashes as punctuation rather than swapping in a hyphen or en dash; use a period or a comma. Limit colons to a real list/example. Do not bold every proper noun, write inline-header bullets that repeat their label, title-case headings, decorative emoji or curly quotes in the edited prose. A meaningful bold label followed by new information can stay.
- **20, 22 communication:** drop canned chatbot openings/closers and praise that adds no answer. Give the actual answer without sycophancy.
- **23–25 filler:** shorten “in order to” to “to”, “due to the fact that” to “because”; remove throat-clearing, stacked hedges and generic conclusions. Keep a real evidentiary caveat.
- **26 jargon:** replace metaphor nouns with the actual mechanism, for example “substrate” → “base”, “wedge in” → “add”, “evacuate” → “move”, “endgame” → “last phase”, or a metaphorical “ratchet” → the actual check or tightening limit. Keep established code symbols and terms that mean a specific thing in their real domain; do not invent a new synonym.
- **27–33 plain speech:** state a concrete action, observation or number rather than a feeling that fits any project. Split sentences the reader must reread. Prefer the named actor to passive voice when known, remove empty adverbs, use everyday words and literal phrasing, but avoid over-compressed arrows, missing articles and verbless fragments. A short sentence is not automatically clear.

Read the original and edited sentence together. Check facts, scope, citations, approval language and denial conditions **byte-for-byte where their wording is binding**; do not weaken “blocked” into “maybe”, or erase a meaningful “unrun”. If the rule makes a sentence sound mechanical or changes a quote, leave the clear original and explain the exception. When a new abstract metaphor repeatedly causes confusion, **propose** its concrete replacement and a small diff to the owner; do not edit a shared `unslop` catalog automatically. For public PR copy the owner's message gate governs exact publication; a text cleanup does not approve it. If source facts or destination are unavailable, return only a bounded wording suggestion and label factual verification `unrun`.

- **Positive BDD:** Given approved draft prose with checked facts and audience, when Pi applies the numbered patterns and checks the replacement against the original, then the result reads naturally with the same meaning, evidence, warmth and necessary uncertainty.
- **Refusal BDD:** Given binding quoted text, a legal notice, unverified claims or no edit/publication grant, when a pattern would change authority or factual meaning, then keep that text, mark the check `blocked`/`unrun` and do not silently rewrite or publish it.

Pi discovering this skill is not a reviewed document, approved public message or the Pi session writing session.
