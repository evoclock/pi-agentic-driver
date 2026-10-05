# Durable fixture decision trail

Append-only technical evidence for owner handback. No report here grants canonical completion or integration authority.

## 2026-10-05: approved bounded fixture

Owner instruction: “ok go ahead and do it”, approving the preceding Treehouse/fake-transport/pinned-dependency/test/review proposal. No live integration permitted.

Treehouse allocation: /Users/julen/.treehouse/pi-agentic-driver-b38410/7/pi-agentic-driver; lease 1fa95fe8b01251c47773c743c89f87e8, holder durable-assignment-fixture. Base 171fa22b713c563bdba77c466d4533025a306461. Branch fixture/durable-assignment. Original checkout dirty state preserved.

Prior art: inventory searched for durable/assignment tests, and existing async seam and node:test test file inspected. Existing seam is process-local; isolated custom Durable task fixture avoids altering shipped integrations or building a storage engine. No upstream executable copied.

## First red: installed package resolution

Initial node --test tests/test_durable_assignment.mjs: 0/11 passed; all failed with ERR_PACKAGE_PATH_NOT_EXPORTED for pi-ai/models. Cause: createRequire.resolve uses CommonJS conditions, whereas installed pi-ai exports that subpath only for ESM imports. Replace loader with seven-line ESM shim in the isolated package; no dependency/settings or prototype scope expansion. Installed APIs, not upstream-only examples, are now exercised.

## Second red: cancellation boundary

After ESM correction: 10/11 passed. “cancel during dispatch boundary prevents the not-yet-started send” observed one send instead of zero. Cause: committed dispatch intent's initial send flag ignored cancellation during after-intent boundary. Add latest committed disposition read before invoking transport. In-flight cancellation is a different case: effect cannot be retracted and ack must still be retained.

## Green review candidate

Commit 411fc909ced3750e29f285efada04620a88de5ae. Eleven tests passed after correction; rerun after report-reopen coverage also passed 11/11. Latest full TAP: evidence/review-candidate.tap (retained locally, not committed). Four child processes deliberately exit 73 without Harness.close at admission/intent/send/ack checkpoints. Test parent observes exact child exit before retaining/quarantining only that fixture's lock and reopening. No generic stale-lock recovery, SIGKILL or power-loss guarantee follows this test.

node --check scripts/enforcement/durable_assignment_pi.js passed. Staged diff whitespace check passed. sfw npm install --ignore-scripts installed pi-durable 1.0.4 and lock-bound transitive dependencies only in isolated fixture package; npm reported zero vulnerabilities at install, not a general security verdict.

## Advisory complexity review

Tool's first review attempt rejected absolute paths because coordinator repository context differs from leased workspace. Direct existing core in workspace then failed because root TypeScript dependency is absent there. Ran the installed driver's SAME existing analyzeCodePhage core with explicit leased-workspace root instead, without installing another package. Result: advisory-review, aligned scope signal, two files analyzed, maximum cognitive complexity 10/cyclomatic 12, duplicate lines 42, no limitations/no possible scope drift. Source 177 counted lines, test 169 counted lines (count includes trailing newline). Signals are diagnostic; no threshold accepted/rejected the fixture. Credit: Earendil Works MIT pi-durable 1.0.4.

## Independent exact-artifact review submitted

Role skill-review, owner-approved Zai model. Delivery dlv-a32bf064f27b7891-muvu5sow accepted/delivered for exact candidate commit and seven-file diff, with all six skills explicitly included. Pulse observed alive/working; later delivery query could not read terminal history and left state delivered. No resend performed. Verdict outstanding at this entry. Review-only instruction forbids execution/install/writes/provider probes; source/API inspection permitted.

## Verification boundaries

No live worker sends, model/provider calls, VM/service deployment, production admission/containment proof, settings change, live integration, publication or merge. SQLite NORMAL power-loss limitations and stale lock's required explicit reconciliation are documented. Worker report is untrusted evidence; matching fixture identity is not cryptographic artifact validation or owner approval. No release artifacts built. Lease retained for independent review and owner integration gate; no merged workspace exists to prune.

## Independent review returned: accept, no blockers

After the first bounded wait timed out, a later bounded wait observed idle; manual role read retrieved the matching Delivery line dlv-a32bf064f27b7891-muvu5sow. No resend. This is a manually retrieved advisory report, not completion or owner authority; snapshot-backed delivery attribution was not established.

Reviewer inspected exact candidate 411fc909ced3750e29f285efada04620a88de5ae and installed Durable 1.0.4 API typings. Standards: APIs match; fake marker explicitly not sandbox/admission; no providers/env/CodingTools; adapter unregistered/unshipped; isolated dependencies and honest process/power-loss limits. Spec: stable committed identity, unknown hold without replay, exact delivery/assignment/artifact/role attribution, targeted controls and atomic mkdir owner lock match intent. Existing seam/root configuration unchanged. Verdict ACCEPT advisory, no blocking findings.

Consider #1 acted on: README now states snapshot-to-send cancellation is best-effort and an interleaving cancel is treated as in-flight (no retraction, ack retained, no attributed report). Consider #2 acted on: document controls are phase-boundary observations, not task abort/immediate worker stop. Consider #3 retained as integration constraint: scratch runtime is experimental and must not be registered before supported packaging is separately scoped. These are documentation corrections; source/test/shim/crash helper/lockfile unchanged after reviewed candidate. Later README wording is not claimed independently re-reviewed.

Dismissed by reviewer: snapshot/send race does not create replay/false-completion; observation failures hold conservatively; one doc/task and existing node:test are not needless framework machinery. Source-only limits: reviewer did NOT run tests/install/open databases; task abort and sleep-cancellation runtime unproved; lockfile spot-check not complete dependency audit; pi-ai/chord dist not inspected.

Reviewer SHA-256 values to compare before handback:
- adapter: 1d58dc603659b17f1c08199037373ad3975315e0a5901da1c08e12a47799ed74
- test: 38b2c40ae4b2aff7eea766b7f5b4d0bbd5e8ab0db84f5262be35b5a6bacc7bff
- runtime: 25f9a6cac2011541cef861ee2d8e90a5b966948ee8c269667488b47aff0a835a
- crash helper: 22c55e91e020dc3ea85b5ee0048e1910abfdc5a3e7b1e629148578ff6cf6db36
- package: 6051fe9bfb3b7863939c8d941ddd05bfee3c8d8cae95d9e0dc464bf7ce88c56a
- lockfile: 7b44a382716570336223548f2cb324d42256f04f3bce2488f382b12f94e27a18
- original README at reviewed candidate: f35a5de7217af912af392ca3f32b6465664b9c3b8ddbe14cecf1cbc207b499ec

Grounded decision: ADAPT Pi Durable for the next separately approved persistence/reporter seam, not wholesale harness migration. Offline fixture results prefer this primitive over writing custom storage but are insufficient to register a live bridge. Keep task-graph completion separate from assignment disposition and owner completion. No production/live integration performed. Distribution licence/dependency review remains outstanding; upstream licence metadata is not a full dependency audit.
