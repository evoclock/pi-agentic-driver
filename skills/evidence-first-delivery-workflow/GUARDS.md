# Guard and gap matrix

These are observations of PAD code on `agents/main` at `f4b55a1`, not a claim that the proposed plan is installed. Each bypass names a way the saved plan alone fails to enforce its rule. An existing local unit test is not proof of cross-seam composition.

| Capability | Current PAD location and observed enforcement | Missing runtime proof / bypass of this skill |
| --- | --- | --- |
| Durable task/artifact state | `scripts/enforcement/durable_driver_pi.js` commits run records through a SQLite-backed durable harness; `lib/task-store-adapter.ts` observes session task provenance. | No adapter translates this plan schema to durable runs. A standalone JSON edit bypasses task history. |
| Atomic review/correction counters | `durable_driver_pi.js` has transactional `change`; the separate step plan only accepts internal/external IDs. | No review-budget counter bound to a unit/head/actor. Third-review and budget-reset runtime tests required. A relabeled plan bypasses static-only history unless checked against trusted prior state. |
| Reviewer involvement | `scripts/enforcement/herdr_communication_pi.js` attributes deliveries to observed roles; `scripts/enforcement/pr_review_gate.js` handles PR review policy. | No cross-run author/reviewer involvement registry bound to this graph. Self-review runtime rejection required; role names alone can conceal identical actors/models. |
| Sole-writer fencing | `scripts/enforcement/storage_owner_lock_pi.js` claims an exclusive storage lock; Treehouse gives separate worktrees. | Storage lock does not fence old branch writers after transfer. Old-writer-after-transfer runtime rejection required. |
| Trusted skill-step receipts | `herdr_communication_pi.js` correlates answered deliveries; `scripts/enforcement/test_gate_runner.py` records test evidence. | Delivery is not recipe compliance. No artifact-bound receipt schema or independent verification for every required Poteto step. A fabricated `requires` string bypasses a graph. |
| Idempotent effect intent/outbox | `durable_driver_pi.js` records outward intent; `scripts/enforcement/outward_effect_pi.js` checks an existing journey and observes remote effects before acting. | No integration from the new plan to that outbox. Duplicate completion and crash-after-effect tests for this graph required. Direct shell/forge actions bypass the driver-owned route. |
| Event continuation | `durable_driver_pi.js` calls `harness.resume()`; `scripts/enforcement/herdr_async_dispatch_pi.js` exposes bounded exchanges. | No installed watcher/event continuation for this plan. A saved edge is not a wake or scheduler; manual pauses can remain unexplained. |
| Cancel/process reconciliation | `durable_driver_pi.js` tracks flights and cancellation; `herdr_communication_pi.js` exposes delivered/answered observations. | No plan-level late-result fence or process reconciliation. Late-result-after-cancel runtime test required; a worker can still write outside the plan. |
| Owner integration | `scripts/enforcement/treehouse_recycle_pi.js` checks an exact merged PR head; `scripts/enforcement/pr_review_gate.js` handles reviewed PR state. | No plan-level trusted owner-merge event. A JSON `owner-wait -> cleanup` edge does not prove a merge. |
| Cleanup eligibility | `treehouse_recycle_pi.js` verifies clean, pushed, settled worktree and matching merged PR before Treehouse return. | The plan cannot invoke that boundary or account for unresolved artifacts. Unmerged/dirty lease must remain preserved. |

## Adapter capability matrix

"Existing" describes a platform-local primitive, never an integrated guard for this plan. External bot hosts are a category with no verified installation; the private source draft is not an observed implementation. The external-host report and a reported issue about missing interception are **REPORTED**, not independently verified. The private adapter note is excluded from public export. All four columns are **plan-only for this workflow**.

| Required capability | Portable core | Pi / PAD observed | Other external bot hosts | Reported external-host source mapping |
| --- | --- | --- | --- | --- |
| Persisted atomic state | Required, not supplied | Durable-driver SQLite transaction exists; no plan adapter | Unsupported / unknown | Unsupported / unverified |
| Budgets / counters | Persist per unit across retry/resume/relabel | Transaction primitive exists; no plan budget guard | Unsupported / unknown | Unsupported / unverified |
| Involvement | Persist actual actor identity | Herdr delivery attribution exists; no plan involvement registry | Unsupported / unknown | Source crew names only; no verified registry |
| Fencing / epochs | Reject stale sole writers | Storage lock exists; no branch-writer epoch fence | Unsupported / unknown | Unsupported / unverified |
| Trusted receipts | Check exact artifact commit and step | Herdr answer attribution and test evidence exist, not plan receipts | Unsupported / unknown | Run-reading named in source; trust unverified |
| Outbox / idempotency | Intent key and atomic commit before effect | Driver outward intent exists; no plan outbox wiring | Unsupported / unknown | Unsupported / unverified |
| Crash recovery after effect | Reconcile remote effect before retry | Outward-effect route observes remote; no plan crash test | Unsupported / unknown | Unsupported / unverified |
| Event continuation | Wake from observed committed transition | Harness resume primitive exists; no plan event listener | Unsupported / unknown | Workflow editing named; wake semantics unverified |
| Cancel / late result | Fence late receipts after cancel | Flight cancellation exists; no plan-level late-result fence | Unsupported / unknown | Unsupported / unverified |
| Manual-skip handling | Skip cannot forge evidence or reset budget | No plan skip guard | Unsupported / unknown | Unsupported / unverified |
| Tool route | Trusted local runner via supported installed tools only | Supported Pi tools for bounded observations, no safe installed plan runner | Unsupported / unknown | REPORTED stdio MCP runner connection possible, not installed or invoked; no verified enforcement |

Smallest viable integration, **not implemented here**: bind one approved unit to a durable transactional state machine with actor/budget/epoch records; verify commit-bound receipts; queue a unique intent before a supported tool effect; reconcile that intent after crash; consume verified events to auto-continue valid/rejected steps and fence cancelled or skipped work. If any supported runner/receipt route is missing, remain plan-only, with no manual shell substitute. Runtime negative tests must cover self-review, third review, relabel/resume reset, stale head, missing receipt, stale writer, duplicate intent, crash after effect, late result after cancel and manual skip. A positive auto-continuation test through rejection, bounded correction, review, QA and delivery is **REQUIRED BUT UNPROVEN** until separately authorized runtime execution.

## Framework bypass matrix

"Can see/stop" means today's **plan-specific** guard, not a general host or provider policy. No credential or permission changes and no live workflow changes are proposed.

| Route | Pi / PAD today | Other external hosts today | Reported external-host behavior | Missing hook and required negative runtime test |
| --- | --- | --- | --- | --- |
| Shell | Plan cannot see/stop direct shell effects; other scoped bash controls may apply | Unknown | Unknown | Bind supported effects to outbox; test shell-bypass cannot count as plan evidence |
| GitHub UI / API | Plan cannot see/stop out-of-band PR or merge | Unknown | Unknown | Verify forge state and owner merge provenance; test forged UI/API claim rejected |
| Manual workflow Run | No plan runner; cannot see/stop manual starts | Unknown | REPORTED start-at-node with earlier answers; no deterministic guard node / universal pre-execution hook | Mandatory workflow/manual interception and result-admission guard; test skipping prerequisites cannot count earlier answers |
| Direct git push | Plan cannot see/stop direct push | Unknown | Unknown | Compare exact commit/owner scope before accepting receipt; test untracked push rejected |
| Manually launched agents | Plan cannot see/stop unrestricted agents | Unknown | REPORTED unrestricted agents could bypass voluntary runner | Mandatory tool/result admission, trusted actor identity, process/write fencing; test rogue agent cannot commit or report past writer revocation |
| Credential use | Plan cannot see/stop credential use outside supported route | Unknown | Unknown | Route only supported installed tools and verify effect receipts; test external credential effect cannot satisfy plan |

**PROPOSED product work, not present:** mandatory interception of workflow/manual entry, tool calls and result admission; trusted actor identity and protected state/evidence; cancellation and writer revocation reaching real processes. A service must guard dispatch, each effect and result admission, and may not offer merge. The owner integration receipt must be authenticated and bound to the exact head. The runner remains **VOLUNTARY** until bypass tests pass; no external-bot workflow ran and no runtime tests were proved. Use deliberate task-scoped supported authorizations, never silent approval bypass.

Runtime negative tests **required but not demonstrated for this new workflow**: self-review and third review across retry, restart and concurrency; stale head, missing evidence and model-supplied "verified" claims; duplicate completion changing state only once; crash after dispatch reconciling without resend; late completion after cancel; old writer after transfer with process/write fencing; manual/shell/GitHub bypass attempts; model "yes", replayed or wrong-head owner approval; and self-relaxed acceptance definition. Positive auto-continuation through bounded correction, review, QA and delivery is **REQUIRED BUT UNPROVEN**. `tests/test_evidence_first_delivery_plan.mjs` exercises only saved JSON mutation, not these runtime seams. Installed controls and any existing PAD tests are scoped to their own routes; none makes this design an autonomous executor. No new worker, live task or workflow was started to demonstrate autonomy.
