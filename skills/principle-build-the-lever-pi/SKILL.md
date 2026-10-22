---
name: principle-build-the-lever-pi
description: For approved non-trivial edits, analysis or verification, including one-off work, build the smallest safe rerunnable tool and prove it against a hand-done unit. Use explicitly when a lever makes work checkable.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Build the lever

Adapted from Lauren Tan's `principle-build-the-lever` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This is a default **decision** for non-trivial work, not an install, filesystem or worker grant.

Do the first approved unit by hand to discover the actual recipe. Before authoring a new script, function or command, search `pipeline_output/codebase_inventory.jsonl` when this repo has it and inspect prior art; if absent, use authorized code search. State why an existing tool cannot do the work. Choose the smallest rerunnable artifact: a codemod for scoped edits, generator for repeated files, query for analysis, a deterministic check for proof, or a delegate skill with recipe, success/negative check and do-not-touch fence. Keep the contract outside delegates' write scope, give each worker exact allowed files and forbidden effects, and name the loaded role/capacity if workers are needed. A deterministic lever beats hand-applied fan-out: do not delegate units a safe script can cover in one pass.

Run the lever on the first **approved** unit and compare its output byte-for-byte or against named expected observable values from the hand-done result, including a rerun for duplicate/partial effects and one refusal case. Then expand only to the granted paths; a script must not hide an install or cleanup. Give the reviewer the artifact and real output. If the task is only a couple of obvious edits, explicitly decline the lever with the reason; if an existing tool already suffices, reuse it rather than author a duplicate. If the principle is claimed as **applied**, name the actual new or reused executable/check/delegate instruction artifact and its rerun; a plan alone is not a file or a run. Durable private evidence can be committed only under the owner-approved Git scope. This differs from `principle-encode-lessons-in-structure-pi`, which makes recurring errors structurally impossible, and `principle-prove-it-works-pi`, which verifies the finished user result; read those actual loaded leaves before citing them.

- **Positive BDD:** Given non-trivial authorized work, even a one-off, when Pi compares a hand unit with a safe rerunnable scoped lever and repeats it, then the output agrees, the artifact is reviewable and the work can be checked again without a manual replay.
- **Refusal BDD:** Given no authorized write/runtime, an already adequate tool or a couple of obvious edits visible at a glance, when new automation is considered, then reuse or decline it with the reason and `blocked`/`unrun` where applicable, without hidden package install, unapproved fan-out or fabricated rerun evidence.

A discovered Pi skill is not an executable lever test.
