---
name: principle-migrate-callers-then-delete-legacy-apis-pi
description: For an approved internal API replacement without external compatibility obligations, migrate every proved caller and remove the old entry in the same scoped wave. Use explicitly before retaining a legacy adapter.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Migrate callers, then delete legacy APIs

Adapted from Lauren Tan's **pinned live** `principle-migrate-callers-then-delete-legacy-apis` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. The current source is shorter than the older installed version: its description favors a same-wave internal migration over compatibility layers, while its body specifies new-contract tests and three applicability conditions. Do not treat the older source's “delete immediately” wording as a blanket authority to remove a public API.

Apply only after the owner accepts the new internal contract, no external users require the old path, and the project can absorb a coordinated break as part of an approved simplification/refactor. Identify the old API's **actual** callers and compatibility boundary with code search, public/exported surface review and authorized consumers. The absence of local references alone does not prove external users absent. If a consumer or owner is unknown, hold deletion and name the missing check; a code comment or deprecation label is not proof.

Within the accepted wave and file scope, update each proved caller to the new API. Update behavioral tests to assert the new contract, preserve regression/negative cases, and remove only tests that protect **solely** the obsolete implementation details. Run the relevant authorized tests and check real entry points before removing the old internal path; observe whether all approved callers resolve and no needed behavior vanished. If callers cannot be migrated together, report the partial migration and an owner-held bridge decision rather than inventing a permanent compatibility adapter. Delete the old path only with its own explicit edit grant and proved compatibility boundary; an unrun caller path or failing check blocks that step. No automatic public breaking change, PR or merge.

- **Positive BDD:** Given an owner-approved internal replacement with an inventoried closed caller set and no external compatibility dependency, when Pi migrates all scoped callers and tests the new contract at their real entries, then the authorized old entry is removed in the same verified wave without a dual-path implementation or lost negative behavior.
- **Refusal BDD:** Given unknown/public consumers, an incomplete caller inventory, no deletion grant or failing/unrun compatibility checks, when old-path removal is proposed, then retain the path and label deletion `blocked`/`unrun`; do not delete behavior tests or treat a search miss as proof no one calls it.

This text is not evidence that a migration, test run or Pi resource loading occurred.
