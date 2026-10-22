---
name: principle-separate-before-serializing-shared-state-pi
description: When approved concurrent actors may write one file, branch, key or object, separate their write ownership before choosing a lock. Use explicitly when diagnosing shared-state races.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Separate before serializing shared state

Adapted from Lauren Tan's `principle-separate-before-serializing-shared-state` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. Instructions like “don't both write” are not synchronization. A Treehouse lease reserves a worktree, not process containment or exclusive ownership of an external state object; a reviewed principle grants no lock installation, worker fan-out or mutation of a trusted shared writer.

Map the actual concurrent actors and the mutable objects they read/write: files, branches, keys, API definitions, database records and task state. Identify each writer, the canonical owner and a plausible interleaving. First ask whether the actors **need the same object** or merely publish independent facts. If facts are independent, give each actor an owned file, key, branch or state directory and combine only at an approved read/reporting boundary. Two actors writing different fields of one `state.json` still share one mutation target; independent `indexer-state.json` and `metrics-state.json` do not. Verify ownership and merge semantics, not just distinct filenames.

Only if one shared write target is a proved domain invariant, choose a **structural** serialization mechanism appropriate to the actual store: exclusive owner/single-writer actor, ordered phases, lockfiles with robust stale-owner handling, or atomic compare-and-swap where supported. Before adding a lock, state why ownership separation fails, how the real process/store makes exclusion enforceable, what happens after a crash, and how competing writes are rejected. Do not duplicate or bypass a trusted board writer/claim service with a local lock or convention. Test an approved conflicting interleaving and recovery at the real boundary, including that the loser cannot silently overwrite the winner; if no safe concurrent test is granted, label the concurrency conclusion `unrun` instead of asserting isolation.

- **Positive BDD:** Given two approved actors writing related state, when Pi gives independent facts separate write targets and merges at a read boundary, or serializes a proved canonical target using its actual trusted owner, then controlled concurrent writes retain both intended facts without a lost update.
- **Refusal BDD:** Given unknown writer ownership, an unproven need to share, a lease mistaken for a lock or no grant for a concurrent test, when a shared mutable write is proposed, then hold that change `blocked`/`unrun`; do not rely on agent instructions, blindly add locks or claim race freedom.

Skill discovery is not a concurrent write test or proof of process isolation.
