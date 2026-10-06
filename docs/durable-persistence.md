# Default-off persistence API

The driver includes a document-store API backed by Pi Durable 1.0.4. No separate skill is required. Importing the module or loading the standard extensions does not open storage or enable persistence.

Only `openDurableSeamStore` is the supported export. The colocated `openDurableAssignmentFixture` export is development-only and requires non-shipped scratch files; do not call it from an installed package.

Trusted integration code can import `openDurableSeamStore` from `scripts/enforcement/durable_assignment_pi.js` and explicitly open an already-created, canonical private directory owned by the current user. Close the returned handle during teardown. A competing or stale `owner.lock` refuses; reconciliation is an operator responsibility. The store never automatically removes a stale lock.

This release slice packages the storage API and offline-tested seam integration. It does NOT provide a user-facing enable command or a verified live transport configuration. The `offlinePersistence` seam option still requires an injected test process adapter. Do not advertise live restart recovery until a separately approved contained pilot verifies it.

Storage holds bounded identities and attributed report bodies, not briefs or terminal snapshots. Both namespaces stop at 64 records without evicting send tombstones. Losing original attribution after restart holds rather than replaying. Already-committed proven reports can reopen. A report is evidence, never owner completion. Cancellation remains best-effort; received acknowledgements cannot retract effects.

Node >=22.19.0 is required. Pi Durable and chord are pinned runtime dependencies. The driver does not directly import or declare Pi AI; Pi Durable itself depends on Pi AI transitively. That dependency includes provider SDKs but this document-store path creates no model registry and makes no provider calls. Host extension dependency interoperability remains a review/test concern, not a claim of a shared host runtime instance. The store supplies every method of the pinned Models interface with a fail-closed implementation that throws on model/auth operations. It does not omit the required Harness option or import a provider registry; no generation operations are supported by this store.

SQLite NORMAL-mode operation is not power-loss proof. Live recovery, hostile same-user filesystem interference, deployed containment and production lock reconciliation remain unproved.

Credit: Pi Durable by Earendil Works, version 1.0.4, MIT, https://github.com/earendil-works/pi/tree/28dcce2ba45ce4a9efeb0f5b686f0be830fd89b9/packages/durable (accessed 2026-10-05). Upstream is installed as a dependency, not copied into driver source. Preserve upstream licence notices when distributing dependencies. Complete dependency licence auditing remains required before publication.
