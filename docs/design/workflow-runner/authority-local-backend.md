# Local service-account authority (backend A)

Backend A keeps authoritative workflow fences outside the bot account. It uses the shared `local-daemon` backend loader. No account or service is installed by this change.

## Deployment boundary

An administrator must create a dedicated service account that bots cannot become. The state directory is owned by that account, mode 0700. The socket is mode 0660 with a client-access group; the socket parent must not be writable by bots. Bots must not have group write on state, service configuration, executables, Python installation, or service definitions.

The templates under `packaging/authority/` are substitution inputs, not installed units. Replace every placeholder before using them. Install the daemon script and its owner-managed `config.json` under the configured state directory. Configuration contains `stateDir`, `socketPath`, `tenantByUid`, and an absolute `pythonBin`. The tenant map binds each numeric kernel uid to exactly one opaque tenant id. Tenant and task ids match `[A-Za-z0-9_-]{8,64}` and contain no user, host, or path information. The configured socket must match the template placeholder.

Node lacks a public peer-credential API. The daemon therefore requires an administrator-managed Python 3 runtime with its standard library only. It passes the accepted socket descriptor to isolated Python, which calls macOS `getpeereid` or Linux `SO_PEERCRED`. A missing helper or unsupported platform fails closed. No Python package is downloaded. The daemon also obtains a nonblocking kernel `flock` through an inherited descriptor; its open descriptor retains that lock until close or process death. The restore CLI uses the same lock. Python and Node executable paths must be trusted and not bot-writable.

## Protocol

Each socket connection carries one newline-terminated JSON object. The object has `op`, `tenantId`, `taskId`, and a `body` for mutations. The four operation names and response envelopes are those in the shared authority contract. `body.op` is `claim`, `effect`, or `settle` for `casAdmitEffect`. Caller identity is never taken from the message.

`createLocalAuthority(config)` exports the four async backend methods. `config.socketPath` selects the socket; `timeoutMs` defaults to 5000. Configure the shared client with a bot-owned `stateDir` separate from the protected daemon state. That client fsyncs pending cancel requests before submission and retains their original request ids across client restart. Transport failure returns `AUTHORITY_UNAVAILABLE`, never admission. `TENANT_MISMATCH` is returned unchanged for the shared client to park without retry.

## Persistence and recovery

Each `tenant.task` directory contains `records.jsonl`, `snapshot.json`, and `high-water.json`. A mutation appends the whole state and its SHA-256 digest, fsyncs the log and directory, then atomically replaces and fsyncs the high-water mark and snapshot before acknowledging. Whole-state records retain all request ids and their original responses. This deliberately trades storage growth for exact replay; there is no compaction or delete API.

Recovery ignores records above the durable high-water mark and discards incomplete tail bytes. It checks the recovered state against that independent mark. A mismatch parks the task as `STALE_AUTHORITY`. Before-first-fsync faults are injectable only through the in-process test API, not the socket or JSON service configuration. Restart invalidates old leases. Within one boot, both a monotonic deadline and persisted wall-clock expiry fence effects. Every admission operation, including claim, first refuses an expired existing lease with `LEASE_EXPIRED`; a later fresh claim may reclaim it without lowering sequence or epoch.

The owner-only restore CLI is `node scripts/pad-authority-restore.mjs <state-dir> <snapshot>`. It requires root and an exclusive state lock. It refuses lower sequence or epoch, clearing sticky cancel, and losing retained replay records. Stop the service before restoring. Restore does not authorize new bot effects. Restore and crash recovery need independent review before deployment.

Root, the kernel, or an administrator able to replace all state can still reset the authority. Backend A protects against bot-account rollback, not a privileged owner. Loss of every independent high-water mark cannot be detected without an external anchor or a client's retained sequence.

## Verification status

Tests use only repository-local `.scratch/` directories and sockets. They never install or start a launchd/systemd unit and never create an account. The crash-between-write-and-fsync test is a deterministic fault injection, not a physical power-loss test. The local socket suite passed 17 tests, including an actual unreachable socket, accepted durable cancel, client restart, blocked admission, recovery with the same request id, and acknowledgement. The 18 shared authority tests also passed with only their fixture adapted to use a real local daemon in scratch; the shared file has no exported conformance factory. After merging the updated shared integration base, the complete workflow-runner suite passes 138 tests, including ownership reconciliation. The CI suite passes 405 of 406 tests locally; its fresh-pack test requires the unavailable `sfw` executable. That environment failure is not a pass, and no admission fallback or fake install guard is substituted. The official gate and Buildkite result must also pass before readiness.
