---
name: how-pi
description: Explain how an approved subsystem works and where behavior belongs using traced entry points, ownership and runtime boundaries. Use explicitly for code walkthroughs, placement questions and onboarding explanations; use why for design motivation.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# How for Pi

Adapted from Lauren Tan's pstack `how` and its explorer/explainer reference templates **as of** `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). The earlier `how` adaptation was retired; use this packaged `how-pi` entry point without relying on skill-name precedence. It adapts the pinned-live source's explorer/explainer output fields without copying Cursor prompt templates, hardcoded models or automatic spawn. Read `../how/WORKFLOW_BOUNDARIES.md` first. The sibling MIT licence and boundaries must be present in the effective Pi bundle, otherwise report the resource missing. For any delegate, resolve `development` via `/skill:setup-pstack-pi` from the owner-approved project role map and use only the already approved Pi coordinator/worker dispatch route; a role map alone does not enable that route. Keep `independent-review` for separate exact-artifact review, not an explainer author.

## 1. Assess complexity

State the user's bounded question. If ambiguous, state the interpretation and explore inside granted scope; the user can redirect. A narrow function/module question is **simple**; a multi-process or cross-cutting subsystem is **complex**. When in doubt, choose the simple path. Find entry points, definitions, callers and imports with Pi `asgrep` tooling only if actually loaded, then read exact source and contracts. If code search is unavailable, report the gap and use only other authorized navigation without implying a complete trace. Filenames, inventories and worker reports are leads, not runtime proof.

The upstream simple path asks one read-only explainer to investigate and explain. If the approved Pi task provides a `development` worker role, data route and budget, assign a single fresh read-only explainer with the question, exact scope, required boundaries and the output shape below. Do **not** make the independent reviewer the author. If that route is absent, investigate directly and label the delegated source-path check `unrun`; still answer the user's read-only question from verified citations rather than pretending a spawn happened.

## 2. Explore only when complex

Decompose the question into **two to four non-overlapping angles**, such as entry/dispatch, state/persistence, effects/boundaries and failure/reconciliation. Each approved read-only explorer gets the same question, one exact angle, immutable source revision, allowed repository paths and no write authority. Request: key components with file path and one-line role; ordered trigger-to-result flow with data passed; all files read; boundary inputs/outputs; surprising behavior; and open questions. Parallel workers require actual approved role/capacity/data grants; when absent, inspect angles sequentially and state the missing delegation evidence. Do not search private chats or fan out simply because this skill suggests it.

## 3. Synthesize

After exploration, pass every bounded finding to one separately approved read-only explainer, if available. Ask it to reconcile overlap and apparent contradictions **against source**, not consensus. The author verifies load-bearing citations and gaps; an explainer summary is not authority. When no approved explainer route exists, synthesize directly and mark the source's explainer step `unrun`, without relabeling your answer as independent. Different-model Standards/Spec review of this port remains separate from task-specific explorer/explainer roles.

## 4. Present

Give a senior engineer a useful mental model, not annotated source: a short **Overview**; needed **Key Concepts**; concrete trigger, transformation, decision and effect flow in **How It Works**; a small **Where Things Live** map; and real **Gotchas**. Omit sections that add no value. Include a small Mermaid or text flow only when it clarifies multi-component behavior, not by default. Cite paths/functions/lines and revision, distinguish code observed from a loaded/deployed route, name unresolved links and the smallest authorized next check. `why` owns historical motivation; do not invent it from code shape. Do not start an atlas project, edit files, install resources or publish by implication.

- **Positive BDD:** Given an approved bounded ownership question and readable source, when Pi invokes `how-pi`, then a cited trigger-to-result explanation identifies state/effect owners, process boundaries and unanswered runtime questions; on an approved complex route two to four distinct explorer angles feed a reconciled explainer.
- **Refusal BDD:** Given missing worker role, tool, repository access or runtime evidence, when a delegated or live claim would depend on it, then the affected step is `blocked`/`unrun` and the answer labels its source-only limit without silent model fallback, private-data read or invented application proof.

Reading this file does not load it into the Pi session. Temporary Pi command discovery does not grant a worker route or prove an actual subsystem walkthrough.
