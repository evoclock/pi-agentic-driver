---
name: principle-guard-the-context-window-pi
description: When an approved investigation risks oversized outputs, long files or repeated reads, cap each phase and preserve useful evidence without exhausting Pi context. Use explicitly for a large scoped investigation.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Guard the context window

Adapted from the **pinned live** Lauren Tan `principle-guard-the-context-window` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). The live body is shorter than the older installed source: it specifies sizing phases, scope and turn budgets, not a mandatory subagent fan-out or inlining rule. Read `../how/WORKFLOW_BOUNDARIES.md`. Context overflow can degrade reasoning, create compression artifacts and halt work; reducing output volume must not conceal a decisive failure.

When a task will inspect many files, long outputs or repeated evidence, split its **approved scope** into small phases. Before each phase name the question, a bounded file/range list, expected output size, turn/resource budget and what evidence would stop or change the search. Prefer an existing indexed code search for leads if loaded; read only the relevant exact source/ranges for the claim, with stable path/revision pointers. Keep a concise main-thread summary of decisions, contrary evidence and unresolved questions; retain complete raw evidence only in an approved private destination when the task requires it. A summary is not a substitute for checking a load-bearing exact artifact. If output is truncated, fetch a bounded continuation or label the gap; never assert the missing portion was reviewed.

Account for tool, provider and worker costs before requesting a large fan-out. Delegation is **optional**, not the pinned live skill's requirement: only an owner-approved role, data route, capacity and Pi worker tool can delegate an exact read-only slice. Without these, inspect sequentially within budget or stop and request a narrower range; do not silently swap models, search unrelated chats or spill private data to an external summarizer. At each checkpoint revise the next phase from observed evidence, not from volume alone. If essential files or a real check exceed the approved budget, mark the affected conclusion `blocked`/`unrun` and ask for a scoped decision instead of compressing away the gap.

- **Positive BDD:** Given an approved many-file investigation with sufficient budget, when Pi plans bounded ranges and summarizes only verified relevant evidence at each checkpoint, then a reviewer can follow exact paths and contrary findings without raw output flooding the session.
- **Refusal BDD:** Given missing file/data scope, truncation, worker grant or remaining budget, when a conclusion needs unseen content, then mark it `blocked`/`unrun`, preserve the uncertainty and avoid unapproved fan-out, provider fallback or fabricated completeness.

A discoverable Pi skill is not an executed investigation or a proof that its important files were read.
