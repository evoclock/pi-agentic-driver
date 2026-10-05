# Offline Durable assignment fixture

This is an experimental comparison, not a registered Pi extension or release dependency. Current driver admission, scheduling, transport and authority are unchanged. It uses Pi Durable documents/custom tasks instead of a new persistence engine. The fake transport has no live worker/provider integration.

## Reproduce in an approved Treehouse workspace

Node >=22.19.0; tested on v26.5.0. Run installation directly through Socket Firewall:

```sh
cd scratch/durable-assignment-fixture
sfw npm ci --ignore-scripts
cd ../..
node --test tests/test_durable_assignment.mjs
```

No script contains an install command. `package-lock.json` records all dependency versions/integrities; pi-durable is exactly 1.0.4. Main package integrity: `sha512-i22unyhavxrTF/KS/JcBOKprQRgepufOIztnqBKZXJCWbEHsXDzcINtjmmBSbFB/3S+4FWIl3eJ5FMbRe33Ybg==`. Runtime imports use the installed ESM exports through `runtime.mjs`, not upstream TypeScript or CommonJS subpath resolution. Transitive pi-ai/chord versions are lockfile-bound.

## What runs

- `scripts/enforcement/durable_assignment_pi.js`: isolated fixture host, private-directory/process lock, assignment binding, one custom Durable task and its document.
- `tests/test_durable_assignment.mjs`: existing Node test framework; retained per-test evidence directories, SQLite checkpoints and fake send journal.
- `crash-runner.mjs`: exits deliberately without Harness close at admission, intent, send or acknowledgement boundaries. It runs no live worker or model.

Admission commits a task and receipt before scheduling. The host must explicitly `resume()`. Fixed fields bind request ID, assignment, scope, envelope reference, role, brief and artifact. A changed binding on the same request ID refuses. These references are fixture strings, NOT validated driver claims or artifact verification.

Phases: admitted -> committed dispatch intent -> one fake send -> committed acknowledgement -> observe original delivery. Reentering intent after process exit holds `delivery-unknown` and never resends. Correlated report commits only if delivery ID, assignment ID, artifact and role all match with bounded nonempty text. Role idle and wrong/stale reports do not settle the assignment. Results never grant owner completion. A Durable task terminal `completed` outcome means its fixture state machine finished; inspect the result's disposition (`held`, `cancelled`, `reported`), not that task outcome as worker success.

Hold/cancel target the receipt identity and do not send an external stop or invoke the task abort path. Controls are observed at phase boundaries, not immediately. A cancellation present at the final state recheck prevents that invocation's send, but cancellation racing between the recheck and send start is handled as in-flight cancellation: effect not retracted, acknowledgement retained when received, no report attributed. This is best-effort, not an atomic cross-system cancellation guarantee.

## Acceptance and limits

Eleven tests cover stable/reopened identity and conflicting reuse; one owner and missing configuration/storage; idle/stale/foreign/out-of-order/oversized report rejection and committed report reopen; targeted cancel/hold and newer work; cancellation before and during send; send/observation failure; four real process-exit windows. Retained artifacts are under `evidence/run-*`; no tests use or remove `/tmp`.

The atomic `owner.lock` directory refuses competing opens and stale owners. After a child exits, the parent fixture proves that exit, deliberately renames only its own exact test lock to retained `exited-owner.lock`, then reopens. The adapter NEVER removes a stale lock automatically. This tests conservative refusal and explicit fixture recovery, NOT production stale-owner reconciliation. A same-user actor can tamper with locks/files; this is not an OS sandbox.

SQLite WAL `synchronous=NORMAL` is process-crash durability, not power-loss proof. No SIGKILL, power failure, production admission, real transport reconciliation, cryptographic report/artifact verification, missing stored task-version migration, hostile filesystem race, live model, AG-UI/OpenDots service, VM boundary or runtime containment is proved here. Missing task registration is refused through the fixture's explicit setup preflight. Polling is intentionally simple (25 ms); it creates checkpoint churn and is not the proposed production watcher.

No CodingTools, execution environment or model provider is installed in the Harness. Dependencies themselves include provider SDKs because Pi AI is transitive; presence is not permission to call them. New service/network/credential boundaries still require scope and approval.

## Decision

Use Durable custom tasks/documents as the preferred persistence/reporter primitive for the next separately approved adapter slice. Do not extend the process-local submission Map into a bespoke persistence engine. Do not migrate to the experimental coding-agent TUI or install a second canonical scheduler. Independent source review of commit 411fc909ced3750e29f285efada04620a88de5ae accepted with no blockers; review considerations are recorded in EVIDENCE.md. Keep this fixture separate pending owner integration decision. Before any registration, move the runtime out of the experimental scratch dependency location into approved supported packaging; missing scratch files currently make open fail explicitly.

## Prior art and credit

Pi Durable by Earendil Works, version 1.0.4, MIT: <https://github.com/earendil-works/pi/tree/28dcce2ba45ce4a9efeb0f5b686f0be830fd89b9/packages/durable>. Accessed 2026-10-05. API patterns derive from the README/custom task recovery and persistent background-reporter examples. No upstream executable was copied or run. Source-commit/tarball byte equivalence is not claimed; installed APIs were actually exercised.

Existing driver `herdr_async_seam_pi.js` was inspected and retained unchanged: it does process-local receipts, whereas this fixture tests restart-safe external-assignment identity/state. Existing `test_herdr_async_seam.mjs` supplied the Node test-framework precedent. New isolated authorship is justified by avoiding changes to shipped/live integrations while evaluating an external durable engine.
