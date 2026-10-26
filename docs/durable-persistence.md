# Driver dispatch persistence

The driver uses Pi Durable 1.0.4 tasks and a small document index. No separate skill is required. The worker-dispatch extension opens its private store on the first dispatch or journey listing, not during import or extension registration. The separate async transport seam remains explicit opt-in.

Only `openDurableSeamStore` is the supported export. The colocated `openDurableAssignmentFixture` export is development-only and exercised from test fixtures; production never calls it.

Trusted integration code can import `openDurableSeamStore` from `scripts/enforcement/durable_assignment_pi.js` and explicitly open an already-created, canonical private directory owned by the current user. Close the returned handle during teardown. The dispatch extension creates a separate private directory for each stable Pi session ID. A lock records the owner's PID, hostname, process start time and release token. A competing live owner refuses. A proven dead same-host owner (or a different process at that PID) permits one gated stale-lock reclaim; a concurrent or interrupted reclaim refuses until reconciled. Normal close releases the lock. The gate protects the rename-and-claim window; unknown ownership still refuses.

Worker dispatch accepts a caller-supplied `journeyId` or generates one for ad-hoc work. `journeys` lists bounded records for the repository (optionally filtered by role or journey ID). Every dispatched prompt carries a journey/iteration marker; an interrupted send does not automatically resend. A missing marker or unreadable pane blocks the iteration without replaying a prompt. One clean journey tag followed by one attributable role report settles the interrupted iteration. With a tag but no report, the tool polls for up to about two minutes, then blocks without resending. An admitted checkpoint has not sent a prompt; after restart it checks worker liveness and requests fresh native confirmation before sending. In-flight and later checkpoints only observe the pane and never resend. An abandoned pending task without a caller waits at most 30 seconds before Pi Durable settles it blocked. The offline async transport seam still requires an injected test process adapter. The process-kill tests exercise actual dispatch code with a simulated Herdr adapter, not a live pane or deployed restart.

`defineTask` owns each iteration checkpoint, and `runtime.commit` records effect intent before the Herdr call; `Harness.resume()` and `waitForTask()` schedule and await recovery.

### Outward effects

The production dispatch extension registers `agentic_journey_outward_effect` for an existing journey. It commits a separate durable task before a confirmed push, private draft PR creation, or draft PR update.

- A push binds its branch, expected remote head (or null for a new branch), and target commit.
- A PR call binds its remote head, branch, base, and title/body digests. Updates also bind the PR number and prior body digest.
- Recovery observes the remote state. It never repeats an in-flight effect. Missing, changed, or multiple PR observations block; a missing branch is not proof that a push failed.
- A transient observation failure after a landed effect settles that effect ID as blocked. Reusing it cannot retry. A newly confirmed effect ID can observe the exact landed result and verify without another write.

If apply fails locally but observation proves that the exact target commit or PR fields already exist, verification is intentional. The tests cover both a changed local HEAD with an already-pushed target and a stale prior-body digest with an already-updated PR. The tool requires native TUI confirmation and verified private GitHub identity; it cannot push to main or master. Worker shell commands are not intercepted. The PR body is supplied only for that call, not stored in the index.

Each synchronous Git/GitHub subprocess has a 15-second timeout and a 16-MiB output limit, enough for the requested 100-PR page. It blocks the harness event loop and cannot immediately honor a cancellation signal. Timeout or oversized output fails closed; neither proves an effect did not happen.

The small document index maps stable journey identities to durable task IDs. Storage holds bounded identities and attributed report bodies, not briefs or terminal snapshots. Both namespaces stop at 64 records without evicting send tombstones. Losing original attribution after restart holds rather than replaying. Already-committed proven reports can reopen. A report is evidence, never owner completion. Cancellation remains best-effort; received acknowledgements cannot retract effects.

Node >=22.19.0 is required. Pi Durable and chord are pinned runtime dependencies. The driver does not directly import or declare Pi AI; Pi Durable itself depends on Pi AI transitively. That dependency includes provider SDKs but this document-store path creates no model registry and makes no provider calls. Host extension dependency interoperability remains a review/test concern, not a claim of a shared host runtime instance. The store supplies every method of the pinned Models interface with a fail-closed implementation that throws on model/auth operations. It does not omit the required Harness option or import a provider registry; no generation operations are supported by this store.

SQLite NORMAL-mode operation is not power-loss proof. The owner lock reads the process start time via `ps -p <pid> -o lstart=`; hosts without compatible `ps` output fail closed at dispatch-store open. Live pane recovery, hostile same-user filesystem interference and deployed containment remain unproved. Verified means a report was attributed at the transport boundary; it is not owner approval or task completion.

Credit: Pi Durable by Earendil Works, version 1.0.4, MIT, https://github.com/earendil-works/pi/tree/28dcce2ba45ce4a9efeb0f5b686f0be830fd89b9/packages/durable (accessed 2026-10-05). Upstream is installed as a dependency, not copied into driver source. Preserve upstream licence notices when distributing dependencies. Complete dependency licence auditing remains required before publication.
