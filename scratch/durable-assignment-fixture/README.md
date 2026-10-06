# Offline Durable assignment fixture

This is an experimental offline fixture and opt-in seam adapter, not a registered Pi extension or release dependency. Default driver admission, scheduling, transport and authority are unchanged. It uses Pi Durable documents/custom tasks instead of a new persistence engine. The fake transport has no live worker/provider integration.

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

During the original evaluation, `herdr_async_seam_pi.js` was inspected and retained unchanged: it supplied process-local receipts, whereas the fixture tested restart-safe assignment state. Existing `test_herdr_async_seam.mjs` supplied the Node test-framework precedent. The subsequent approved offline seam integration is described below; the original fixture review does not cover these later changes.

## Approved offline opt-in seam adapter

`openDurableSeamStore({ directory })` uses a Durable document behind the same private-directory/exclusive-owner convention. No background task runner, automatic resume, live worker or provider is opened. The store contains bounded identity/state fields and already-attributed report bodies, never briefs or terminal snapshots. It refuses additional records at 64 per namespace rather than evicting effect tombstones. Holds cannot be overwritten by racing acknowledgements; received acknowledgement metadata is retained. The proof label is an assertion from trusted driver code, not an authenticator.

Pass the returned handle as `offlinePersistence` and an existing fake `runProcess` adapter to the communication or async seam's options. Missing process injection refuses before any Herdr invocation. Injection is trusted same-user test code, not a sandbox or network firewall. No extension/settings registration supplies these options automatically.

`offlineRequestId` optionally binds a caller-owned request identity. Reuse with changed role/brief/repository binding refuses. Otherwise identity is derived from repository, role and brief. Persistent repeats never resend, even outside the legacy two-minute window; a genuinely new approved assignment needs a distinct request identity. An accepted duplicate receipt describes the original handoff, not new execution or current report readiness. A pending duplicate is conservatively held; the original already-running invocation may still finish. Identity is not authorization.

Async admission commits submission and delivery identity before transport. Delivery commits its intent before handing off. Restart at either ambiguous intent holds without replay; loss of the original volatile snapshot/framed echo holds without trying fresh role-based attribution. An already-proven committed report can be read after reopening without transport. Opted-in poll/observe use delivery-specific attribution, not the legacy get-only observation. A proven report yields `report-ready` with `terminal: false`: it is evidence, not worker success or owner completion. No role-idle state can complete the opted-in assignment. The default legacy get/read behavior is retained explicitly, including its previous lifecycle normalization.

Controls are best-effort phase-boundary checks; no external stop or cross-system atomic cancellation is provided. Failed commits never trigger a retry. The five new abrupt-exit windows cover submission intent, delivery intent, send, delivery ack and submission ack. The parent proves exact child exit before retaining its test lock and reopening; production lock recovery, power-loss durability and live reconciliation remain unproved.

Run the three existing suites together in the approved workspace:

```sh
node --test tests/test_durable_assignment.mjs tests/test_herdr_async_seam.mjs tests/test_herdr_communication.mjs
```

Full-slice independent review is required before handback. Live registration, supported dependency packaging, real transports/providers, VM deployment, release activation and owner integration remain separate gates.
