---
name: architect-pi
description: Sketch caller-first types, signatures and module boundaries for an approved non-trivial Pi engineering change before implementation; compare distinct designs and revisit the sketch when implementation reveals a wrong shape. Use explicitly for an architecture task.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Architect for Pi

Adapted from Lauren Tan's pstack `architect` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). This Pi port preserves Ground → Sketch → Agree → Implement → Scrap and the source's caller-first sketch, competing whole-shape candidates, red-flag screening and rationale. It cannot import Cursor's `Task`, `arena` runner configuration, default models, `/tmp` runner paths or automatic commits. Read `../how/WORKFLOW_BOUNDARIES.md` before an effectful or delegated step.

## Boundaries and roles

Start with the approved task contract, repository, evidence destination, scope, model/data budget and stop. Use session `tasks` for the five phases when loaded, not a new project board. Resolve `development` and `independent-review` through `/skill:setup-pstack-pi` before any role-dependent handoff. The configured reviewer is reserved for independent review of the exact artifact; it is **not** an extra author or a substitute second design model. If the approved task does not provide two distinct authorized candidate routes (including any required additional roles), do not run a fake parallel/multi-model arena or claim its synthesis occurred. A single-author pair of sketches may be a labelled provisional exploration, not the full multi-perspective result. No default model, provider fallback, worker spawn, worktree creation, commit, PR or merge follows from reading this skill. Only the repository owner merges.

## A. Ground

Use the loaded Pi `how` method to trace real entry points, state ownership, integration boundaries and actual runtime claims. If the proposed design changes existing ownership, use an available, approved `why` route for rationale; if that route is not loaded, inspect the scoped source/ADRs yourself and label the missing method. A genuinely greenfield unit can skip this phase with its reason. Save citations, not copied private transcripts. A file name alone is not a mental model.

## B. Sketch and synthesize

1. Frame an artifact and 3–6 concrete comparison criteria from the accepted behavior. Give each authorized candidate the same task, grounding and rubric, with independent writable locations only when approved. Require **at least two structurally different whole-shape designs** before choosing, not two cosmetic variants. If `arena` is available and separately authorized, use its Pi port; otherwise compare read-only proposals without calling it an arena. Missing candidate capacity is a reported block for the multi-model check, not permission to appoint the independent reviewer as an author.
2. For each candidate, write the caller's intended usage and two or three realistic call sites **before** the types. Derive core data structures, function signatures, module map and invariants from that usage. Mark bodies as not implemented and difficult logic as pseudocode. Do not write a deployable half-implemented API just to illustrate the sketch. Trace dominant access patterns and define one writer per state; validate external input at the boundary. A new index/cache or extra layer needs a reason in the actual access pattern.
3. Screen each candidate for a shallow interface that exposes internal steps; information leakage across modules; layers split by execution time rather than ownership; pass-through methods; shared state with multiple writers; two ways to do one task; importable internals; and hand-synced lists. Prefer a small public interface that hides substantial behavior and keeps call chains short. Cite specific future caller breakage rather than a style score.
4. Select one base against the rubric, record what useful part was grafted from each other candidate, and say why other shapes lost. A separate approved cross-judge may contribute evidence; reviewer output never chooses or authorizes by itself. Preserve disagreement. The rationale records: problem and grounded constraints; caller usage; shape and interface depth; synthesis decision; accepted tradeoffs; concrete alternatives; open owner questions/risks; and the next implementation step. Store it only in the approved private destination.

## C. Agree

Normally continue within the approved contract. If the invoker asked for a checkpoint, present the sketch and pause before implementation. New ownership, model/data access, app effects, irreversible work or changed scope always return to the owner even without a checkpoint. A sketch is not a signed product specification and commits are not implied.

## D. Implement against the sketch

Fill in the approved design in verifiable units. Compare actual call sites and test results with the usage and types. A surprising new parameter or writer is evidence to inspect the design or requirement, not something to hide with an escape-hatch type. Check the real entry point and capture failures. Independent exact-artifact Standards and Spec review through the configured different-model `independent-review` role and applicable QA remain separate.

## E. Scrap if the shape fails

One edge case is not proof of a wrong architecture. Repeated workarounds across unrelated code, casts around invalid states, a newly shared lock, callers learning private rules, or repeated same-shape deviations are reasons to stop. Re-ground what was actually built; re-sketch with the new constraint as foundational; subtract an unnecessary layer first; then compare new whole-shape candidates. Do not delete evidence, revert other people's work or replace an approved spec automatically.

## BDD and handback

- **Given** an approved non-trivial design task, loaded Pi resources and separately authorized distinct candidate routes, **when** the architect method runs, **then** the cited grounding, two caller-first whole-shape sketches, red-flag screen, rubric-based synthesis, rationale and checked implementation deviations are observable; an explicit checkpoint pauses when requested.
- **Given** a missing route, role, budget, safe destination or implementation grant, **when** the next phase would cross that boundary, **then** report `blocked` or `unrun` for that phase. Do not claim a multi-model arena, authored candidate, implementation, independent review or live success from a one-model draft.

Hand back the exact sketch/rationale paths and identity, evidence for comparisons, what ran versus remained proposed, outcome at the real entry point and the next owner-held decision. No package loading or real design journey is claimed by this file's existence.
