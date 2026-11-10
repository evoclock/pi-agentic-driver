# Pi adapter and source differences

Read `CORE.md` first. This adapter does not register an executor or install a skill. The two saved examples are fictional inactive units anchored to the real `agents/main` head `f4b55a11ecdf3671814ce441a8426a8bb7458b0b`; no worker carried them out.

| Source section | Pi substitution | Limitation |
| --- | --- | --- |
| 1. Reconcile | Read approved task board/session tasks, Treehouse lease, scoped Git history and `gh pr view` for an existing PR. | Reports are untrusted; a task list does not authorize dispatch. |
| 2. Method | Read installed `poteto-mode-pi/SKILL.md`, its boundaries, mapping and Feature playbook; pin BDD and explicit owner contract. | Feature delegation is blocked if independent review is not configured; no self-review fallback. |
| 3. Model | Use the installed `statechart-pi` `scripts/run-tlc.mjs --check` route, then bounded runs from ignored repo `.scratch/`; see `MODEL.md`. | This adapter supplies TLC but not the upstream rendering pipeline. Model pass is not runtime proof. |
| 4. Actors | Read `.pi/pstack-model-roles.v1.json`; use `agentic_herdr_communication` `list`/`get` for configured roles. | The role map has a configured development identity, redacted in these examples, and `independent-review: null`. No reviewed assignment or verified family separation. Historical named crew roles in the source are illustrative only. |
| 5. Inactive graph | Save `evidence-first-delivery-plan.v1` JSON under `examples/` or an approved project path; do not call an external-bot workflow editor. | No PAD DAG scheduler, disabled flag or manual-run lock is supplied by this skill. Never dispatch the examples. |
| 6. Guards | Run local `validate_plan.mjs` for static consistency; consult `GUARDS.md` for current PAD locations. | No atomic counters, authenticated receipts or effect intents are installed by this skill. |
| 7. Return | Compare read-only `agentic_herdr_communication` `list`/`get` and delivery IDs only if previously delivered; check scoped task-store state and Git. | A read-only snapshot can show no observed transitions; it cannot prove no activity elsewhere. Do not use unverified external-host workflow-run readers. |

Plan snapshots pin SHA-256 of the brief `ca5bcd09e76ed4c61d0861bb0eef3bc44ac52636a60394250d31c99649421f80`, installed Poteto entrypoint `79a122bd37926b46eee5ed9f3c16289d21e95fee43002280ba4e72dd7c590647` and project role map `9c2abfd67d4edf9af6a74ceef2de28a46bd5c156527ff0bc5e4b57653d52b9df`. They are illustrative design bindings, not signed approvals. Example model labels are placeholders, not identities from the pinned role map. Compare to live records before any later use. `recovery.actor: null` deliberately records that no configured Cam/recovery identity or model is verified; it is an activation blocker. `independent-review: null` is another blocker.

For pi-agentic-driver, the same shared invariants and automatic-transition design apply, but there is no installed plan executor. Consult the [capability](./GUARDS.md#adapter-capability-matrix) and [bypass](./GUARDS.md#framework-bypass-matrix) matrices: a shell, direct push, forge UI/API or manual run is not a trusted plan receipt. Do not replace a missing supported local runner with a shell script. A positive automatic-continuation runtime test is still required and unproven.

**Activation prerequisites:** exact owner scope, configured and independently verified reviewer and recovery actor/model/family, actual recipe-step evidence route, runtime guards and negative tests in `GUARDS.md`, supported event wake, trusted owner-integration proof, and a separate explicit execution grant. The owner merges. The lease is retained until human-confirmed integration and reconciliation.
