---
name: sharpen-pi
description: Before an approved task starts, test its expert approach, real user outcome and specification level, then retain one independent result check. Use explicitly when asked to sharpen a task.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Sharpen the work for Pi

Adapted from Lauren Tan's new `sharpen` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This is a short pre-work judgment pass, **not** a new task contract, rewritten user prompt, permission to relax owner-held safety limits or license to launch workers/effects.

Before taking an approved task, ask three questions privately: How would a top practitioner approach this exact problem, including raw sources, actual methods and a check outside the proposed implementation? What outcome is the **user** really trying to obtain? Is the brief over- or underspecified for that outcome? Consult the named source or existing code only inside the granted data scope. Challenge busywork and speculative constraints that do not serve the goal, and add only clarifications that change a real decision. For a constraint owned by the repository owner, a safety rule or a product choice, **propose** a change; do not loosen it by yourself or substitute a preferred task.

Retain at least one **independent, authorized outside check** of the end result, not the candidate's self-report or circular test. Name its expected observation, target and safe exit; if that check is not available, report it `blocked`/`unrun` rather than treating a plan as proof. Leave irreducible product decisions to the user, continue only reversible ordinary work that the existing grant already covers, and stop where a new owner choice is required. Fold the improved expert method and proportionate check into **the work itself** rather than narrating a framing exercise or handing back a rewritten prompt. If the user only requested a planning critique or no executable task/effect grant exists, return the smallest actionable clarification and do not implement anything.

- **Positive BDD:** Given an approved task with accessible raw sources and a permitted independent result check, when Pi tests expert method, underlying user purpose and spec granularity before execution, then the same scoped task proceeds with one decision-changing improvement and a named external success observation, not a longer prompt.
- **Refusal BDD:** Given an owner-held requirement, unclear goal, absent data/check/effect permission or only a request for critique, when sharpening would broaden or change the task, then keep the existing scope, name the pending owner choice and mark the unrun check `blocked`/`unrun`; do not rewrite the contract or execute unapproved work.

Discovery of this skill is not proof that an expert method, outside result or Pi task was exercised.
