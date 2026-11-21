---
name: evidence-first-delivery-workflow
description: Draft a connected, inactive delivery plan from an approved task contract and observed state. Use before orchestrating a new unit or resuming an interrupted delivery. Validate review budget, evidence edges and terminal recovery without starting execution.
---

# Evidence-first delivery workflow

Use this skill to plan a delivery before any work is dispatched. It turns an approved task contract and the observed state of the repository into one saved, inactive plan, then checks that plan. Use it when you start a new unit of work or resume one that was interrupted.

Read [CORE.md](./CORE.md) for the portable method, [PI.md](./PI.md) for how each step maps to Pi, and [MODEL.md](./MODEL.md) for the statechart check.

## Steps

1. **Reconcile.** Read the task contract, the owner's latest acceptance, the exact Git head, the existing lease, who has reviewed so far, and any unmerged state. Decide whether the unit is new or a continuation before you budget it.
2. **Pin the contract.** Write the success and failure cases (Given/When/Then), the definition of done, scope, method and delivery condition. Do not invent a product decision to make the plan pass.
3. **Check the lifecycle model.** If the `statechart-pi` runner is installed and the reviewed model with both safe and deliberately unsafe configurations is available in a private source checkout, check both and keep the results. Those model files do not ship with this skill. Otherwise mark both checks unrun and continue planning. A model check does not prove a live guard.
4. **Name the actors.** Take real roles and models from the project role map and observed state. If no independent reviewer is configured, stop. Do not fall back to a default model.
5. **Save the plan.** Save a versioned, inactive plan like [new-unit](./examples/new-unit.plan.json) or [exhausted-resume](./examples/exhausted-resume.plan.json). Connect readiness, implementation, review, QA, bounded correction, recovery, verified delivery, owner wait, reconciliation and stop. Add no triggers, schedules or active flag.
6. **Validate.** From this skill's directory, run `node ./validate_plan.mjs PLAN.json`.
7. **Return.** Report the plan ID and path, the role map, the model results, open gaps, and what must exist before the plan could run.

## Limits

This skill produces a plan. It does not run, schedule or dispatch work, and grants no authority. The validator checks static plan consistency, not runtime safety. All other steps are guidance. [GUARDS.md](./GUARDS.md) describes the needed runtime checks and stated limits.
