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

## 2026-10-05: approved #13 resumed; offline seam-store foundation

After the owner requested continuation, resumed the already-approved offline adapter slice in the retained Treehouse workspace. Read actual async submission and communication delivery paths and searched the inventory. Existing fixture already supplies the isolated pinned library and private ownership convention; extend its module with a bounded Durable document store instead of adding a scheduler or writing another storage engine.

Added experimental, unregistered `openDurableSeamStore`: separate submission/delivery namespaces; atomic digest-bound reservation; immutable identity and committed answered reports; 64 records per namespace with refusal rather than tombstone eviction. Closed primitive-field allowlists reject prompts, terminal snapshots, and marker objects. A report-proof field is an assertion from trusted driver code, not an authenticator or independent provenance verification; actual snapshot-backed attribution must still be enforced by the communication seam. No automatic resume, sends, providers or stale-lock cleanup.

Red: first combined run passed 62/63. Concurrent duplicate reservation tried to structuredClone a Durable draft proxy inside a commit, producing DataCloneError. Permitted record fields are primitives; materialize the duplicate record with object spread. Green: repeated combined run passed 63/63 across the Durable, async-seam and communication suites, including the original 11 fixture tests and three new store tests. TAP retained locally at evidence/seam-store-first-run.tap and evidence/seam-store-second-run.tap. git diff --check passed.

Advisory review used installed analyzeCodePhage with the explicit leased-workspace root: scope aligned, no drift or limitations; max cognitive 22 / cyclomatic 21; 37 duplicate lines. Diagnostics, not thresholds. No new dependency installation.

This is a FOUNDATION ONLY, not finished #13 integration: async and communication files remain unchanged, including their legacy process-local maps and idle normalization. Remaining work: opt-in offline injection into both seams, committed delivery identity before send, no replay after ambiguous intent, attribution-loss hold on reopen, no idle-based completion in opted-in mode, end-to-end restart/crash coverage and independent exact-head review. Prior independent acceptance of the original fixture does not cover this new store or its tests. No live registration/settings/release activation, VM deployment, publication or merge.

## Offline seam integration review candidate

Implemented explicit `offlinePersistence` injection in both existing seams. The port requires the existing fake `runProcess` adapter; default legacy behavior and all live registration/settings remain untouched. Submissions bind repository/role/brief digest, retain a committed delivery ID, and never resend a persistent duplicate. Communication retains the existing full-echo plus exact leading correlation-line attribution algorithm; only proved report bodies and identity/state metadata reach the closed store. Original pre/post terminal snapshots and framed prompts stay volatile in per-store maps. Reopen without them holds; already-committed proven reports reopen without transport. Opted-in observations never infer completion from idle or use the role's latest unbound report. `report-ready` remains nonterminal evidence, not owner completion.

Red: delivery integration first run passed 65/66; proven report did not attribute because the initial stable delivery ID omitted the existing framing grammar's separator/suffix. Inspected promptContractRange, retained its parser unchanged, and changed offline ID generation to the existing `dlv-<16hex>-<opaque suffix>` shape. Next run passed 66/66. Async integration then passed 69/69. Five additional real child exits at submission intent, delivery intent, send, delivery ack and submission ack passed 74/74; no surviving child remains. Exact child exit precedes each retained test-lock quarantine. Concurrent submit and pre-send hold/failed-ack-commit checks passed 76/76. Added atomic hold/ack/report transaction coverage: final combined candidate run passed 77/77, including the original four and five new real process-exit windows. Tests are retained in existing node:test suites; TAP pointers: evidence/delivery-seam-first-run.tap, delivery-seam-second-run.tap, async-seam-first-run.tap, seam-crash-run.tap, seam-failure-run.tap, seam-review-candidate.tap. Synthetic fixture journals only, no credentials or real worker transcripts.

Hold enforcement is monotonic inside the store transaction: racing ack metadata is retained without clearing an observed hold, and held delivery reports cannot commit. Pre-send rechecks are best-effort, not atomic external cancellation. Missing injection, failed admission persistence and digest conflicts cause no new send. No exactly-once, SIGKILL, power-loss or production-recovery claim follows these checks.

Syntax checks for all three implementation modules and whitespace checks passed. Advisory code-phage ran with explicit leased-workspace root: max cognitive 31/cyclomatic 23, duplicate lines 274, no missing-path limitations. Its lexical scope warning flagged the two seam files; both are explicitly required by approved #13 and no paths beyond its accepted implementation/test/fixture scope were changed. No metric rejects the candidate. Separate independent Standards/Spec and evidence review remains outstanding until its exact-head report arrives; previous original-fixture acceptance does not cover any changed source or tests here. No new dependency install, live transport/provider, deployment, publication, release activation or merge.

## Independent full-slice review and scoped correction

Reviewer skill-review received delivery dlv-3145dda104cd9b0e-muvx6vg1 for exact base ec0962c and head 29c979c76b48fadc1a12ff5d0bcd8fedf8e8bae2. A bounded wait observed done; per-delivery query lacked the echoed handoff. Manual read retrieved a report with that exact correlation ID, padded by terminal rendering. This is manually correlated advisory evidence, NOT snapshot-backed adapter attribution or owner acceptance. No resend occurred. Reviewer applied the explicit six skills, source/diff/evidence inspected; no reviewer tests or databases executed. Original review hashes bind all nine changed files. Standards accepted; Spec CHANGES NEEDED for one medium blocker: direct opted-in communication get/wait/read still reached legacy role-keyed observation/report paths, despite the async integration using only delivery-bound queries.

Act on: refuse all non-prompt/submit/delivery operations in opted-in communication before transport, including list as the closed offline port has no need for it. Default behavior remains unchanged. Added regression asserting refusal and no report/traffic for get/wait/read/list. Consider #1 addressed with comment that offline delivery observation can commit proof/hold metadata, not a strictly read-only store operation. Consider #2 addressed with a direct communication failed-ack-commit test retaining queued intent and one send across repeat. Consider #3 retained prominent README pending-duplicate semantics. Reviewer dismissed eviction leak, documented best-effort cancel interleaving and proof-label-as-authenticator concern; no other blockers. One reviewer typo describes a 32hex suffix; actual stable ID suffix is 16hex, matches the unchanged grammar, and the exact source hash remains the evidence.

Fresh combined suites passed 79/79; TAP evidence/seam-review-fix.tap. Whitespace check passed. This correction invalidates affected communication/test/evidence review until exact-new-head re-review. No live activation or merge.

## Independent final-head review accepted

Owner selected kimi-coding/k3. New durable-review role received delivery dlv-45e6596deae6f2a8-muvy3w6z for the entire nine-file base ec0962cb11e279a6d7cc331249eaa79a2c152c78 to head d0713cae16285b196573bd885b92e4aa6f251907. Manual read retrieved the matching padded correlation line; the delivery query had no handoff echo, so this is manually correlated review evidence, not snapshot-backed attribution. Standards ACCEPT; Spec ACCEPT; no blockers. Reviewer inspected all nine files, the six skill methods and retained 79/79 TAP, but did not execute tests or open databases. Earlier role-keyed fallback finding is closed.

Nonblocking considerations retained: async uses resolve(cwd) while communication prefers repository over cwd; divergent direct-call context conservatively holds after one send and should use a shared resolver before supported activation. Catch-all obscures some pre-send error reasons. Failed persisted deliveries could expose a clearer distinct state. Permanent 64-record quotas require owner reconciliation. These do not enable replay or owner completion in the approved offline scope. Final review does not establish production, power-loss, hostile filesystem or live containment proof. This documentation-only record does not change independently reviewed executable bytes.

## Packaging review and lockfile correction

Packaging candidate e0ab8dcb1357af22678621b7aed5c8ec273ec0e8 vs base8a56c4df3f103139f47b7f82d75350a67a2c981a moved store imports to declared pinned dependencies, shared repository resolution and preserved validation codes. Socket Firewall wrapped installation. Coordinator suites passed80/80 at evidence/packaged-runtime.tap; code-phage max cognitive33/cyclomatic23, duplicate274, no path limitations. Installed-artifact proof was NOT performed. No release artifacts built, live activation or publication.

Owner supplied review correlated to dlv-1415c5aa45d8edc8-muw0za7s: Spec ACCEPT; Standards CHANGES NEEDED for stale root lockfile Node minimum22.5.0 vs manifest22.19.0. Reviewer inspected source/installed typings/TAP, did not execute tests. Act on: sfw npm install --package-lock-only --ignore-scripts refreshed metadata; rerun passed80/80 at evidence/packaging-lock-correction.tap. Nonblocking findings: omitted required models option tolerated by exact pinned document runtime; shipped fixture export depends on absent scratch; transitive Pi AI host interoperability unproved; invalid oversized brief consumes a tombstone. Documentation now explicitly supports only openDurableSeamStore and discloses model-option reliance. Remaining considerations retained, not represented as resolved. Updated-head review outstanding; no canonical completion or release authority inferred.

## Corrected packaging accepted; document-only Models contract follow-up

Manual role read retrieved matching delivery dlv-69d1e13135160117-muw1i4xt: Kimi Standards ACCEPT and Spec ACCEPT at3a424597ca733a9f3dd3e8399a8677cf37ae7647. No executable changes in that correction; retained findings/gaps explicitly stand. Acceptance is advisory, not completion or release authority.

Next scoped change supplies all24 methods of installed pi-ai Models interface (models.d.ts:130 onward) as frozen throwing functions, satisfying required Harness models option without importing a provider registry. Documents remain functional; coordinator combined suites passed80/80 at evidence/closed-models.tap. Docs supersede the omitted-option reliance claim. Code-phage explicit workspace: maximum cognitive22/cyclomatic21, duplicate36, no limitations. New executable bytes require affected independent review.

Lock metadata inventory observed116 entries with licence metadata: MIT67, Apache-2.0 35, BSD-3-Clause12, Unlicense1, 0BSD1; no missing metadata. This is a manifest inventory, NOT complete licence-text/notice compliance audit. Required source/docs exist in package allowlist. Neither check is installed-artifact verification. Release-artifact construction remains behind owner integration confirmation under project rules; no tarball built, published or claimed tested. Live host interop, service/VM activation and full licence notice audit remain outstanding.
