---
name: evidence-first-delivery-workflow
description: Draft a connected, inactive delivery plan from an approved task contract and observed state. Use before orchestrating a new unit or resuming an interrupted delivery. Validate review budget, evidence edges and terminal recovery without starting execution.
---

# Draft before dispatch

This skill produces a **design**, not a runnable workflow or authority to dispatch. Its automatic valid/rejection transitions are requirements for a future authorized runner, not active behavior. The [adapter capability](./GUARDS.md#adapter-capability-matrix) and [framework bypass](./GUARDS.md#framework-bypass-matrix) matrices explicitly identify unsupported hooks. Positive auto-continuation runtime proof is required but unproven. Read [the portable core](./CORE.md), [the Pi adapter](./PI.md), [the guard and gap matrix](./GUARDS.md) and [the model evidence](./MODEL.md). External-adapter observations remain **reported, not independently verified**; the private adapter note is not part of the public skill.

Provenance: adapted from a private external-bot skill draft, source SHA-256 `c0ec7b03fc13ee56a76d6036a6208174c7d8fb961b790693fdb1539f031acd5e`. The source's seven sections correspond to the seven sections in `CORE.md`; `PI.md` records every platform substitution. The private draft is provenance, not a runtime dependency.

1. Reconcile the canonical contract, latest owner acceptance, exact Git head, existing lease, review involvement and unmerged state. Classify a proposed unit as new or continuation before budgeting it.
2. Pin BDD success and failure, definition of done, scope, method and delivery predicate. Read the installed Poteto Feature method. Do not invent a product decision to make a graph pass.
3. Check the lifecycle statechart under the installed-only `statechart-pi` route. Preserve both safe result and deliberately unsafe counterexample. An abstract model cannot prove a live guard.
4. Resolve real actors and model identities from the project role map and supported observations. Missing independent-review configuration remains a block, not a default model.
5. Save a versioned, **inactive** plan like [new unit](./examples/new-unit.plan.json) or [exhausted resume](./examples/exhausted-resume.plan.json). Connect readiness, implementation, review, QA, bounded correction, terminal recovery, verified delivery, owner wait, post-integration reconciliation and preserved stop. No triggers, schedules or active flag.
6. Run `node skills/evidence-first-delivery-workflow/validate_plan.mjs PLAN.json` and inspect the [runtime gaps](./GUARDS.md). This helper rejects malformed plan data, not malicious runtime transitions.
7. Verify the saved plan and no execution using supported receipts, then return plan ID/path, contract/method/model hashes, role map, model results, unresolved gaps and activation prerequisites. Do not claim autonomy until a permitted task completes required correction, review, QA and verified delivery without repeated owner nudges. Owner merge wait is expected; unexplained inactivity is not.

Do not install this skill globally or run a production workflow from these examples. This package neither registers a scheduler nor changes existing controls. **Not installed; user tests before merge.**
