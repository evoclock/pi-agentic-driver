# PAD workflow-runner authority API contract, v1.1 (G4)

Status: v1.1 draft. The owner selected both backends for the package. Backend A is specified in section 4 and follows in a separate stacked change. This change supplies the PAD client and model. The Durable Object maintainer supplies the remote server.
Placeholders only: `<AUTHORITY_HOST>`, `<TENANT_ID>`, `<TASK_ID>`, `<CF_ACCESS_CLIENT_ID>`,
`<CF_ACCESS_CLIENT_SECRET>`, `<ACCESS_TEAM_DOMAIN>`, `<ACCESS_AUD>`. No usernames, paths,
hostnames or account ids belong in any id, header, log or test fixture.

## 1. Shared authority interface (both backends)

The runner talks to one interface. The same TLA+ invariants cover every backend.

| Op | Mutates | Purpose |
|---|---|---|
| `commitCancel` | yes | Durably record cancel for a task. Ack only after commit. Sticky forever. |
| `readEpoch` | no | Current `{epoch, seq, cancelled, lease, unknownEffects}` for fencing. |
| `casAdmitEffect` | yes | Compare-and-set admission. `op` is `claim`, `effect` or `settle`. |
| `status` | no | Health, backend kind, `enabled`, highest committed `seq`. |

Backends:
- **C (this PR):** remote Cloudflare Durable Object on pi-durable-host (section 3).
- **A (built alongside C):** local daemon under a dedicated service account (launchd/systemd),
  Unix socket owned by that account (section 4). Same request/response shapes as below.
- **None configured:** every call returns `AUTHORITY_UNCONFIGURED`; the run parks.

### Authority state (one record per tenant+task)

```
tenantId, taskId           opaque, tenant-scoped, [A-Za-z0-9_-]{8,64}; never derived from usernames/paths
seq        int >= 0        +1 on every committed mutation; never decreases
epoch      int >= 0        +1 on every claim and on commitCancel; never decreases
cancelled  null | {atSeq, atEpoch, reasonCode, requestId}   sticky; no API clears it
lease      null | {leaseId, epoch, expiresAt}               fencing token = (epoch, leaseId)
effects    map effectId -> "admitted" | "ok" | "failed" | "unknown"
requests   map requestId -> {bodyHash, response}            retained for the task's whole lifetime; compacted only
                                                            after the task is terminal and past a retention window,
                                                            keeping cancel, epoch, seq and terminal facts exact
```

### Rules every backend must enforce

1. **Commit before ack.** A mutating call returns success only after the state change is durable.
2. **Idempotency.** Every mutating call carries `requestId` (UUIDv4 or 128-bit random, client-made).
   Replay with the same body returns the original response byte-for-byte meaning, with `replayed: true`.
   Same `requestId`, different `bodyHash` -> `IDEMPOTENCY_MISMATCH`.
3. **Sticky cancel.** After `cancelled` is set, `claim` and `effect` fail `CANCELLED`. `settle` is
   still accepted so outcomes of already-admitted effects can be recorded.
4. **CAS.** `claim` and `effect` carry `expectedEpoch` (and `expectedSeq` for `effect`). Any mismatch
   -> `CAS_CONFLICT` with current `{epoch, seq}`; nothing is committed.
5. **Fencing.** `effect` and `settle` must present the live `(epoch, leaseId)`.
6. **Lazy lease expiry.** Expiry is checked on every `claim`/`effect`/`settle` against authority time,
   whether or not an alarm has fired. Expired -> `LEASE_EXPIRED`. Alarms may clear expired leases early;
   correctness never depends on them.
7. **No advance on unknown effect.** While any effect is `admitted` or `unknown`, a new `effect` fails
   `UNKNOWN_EFFECT_PENDING`. Only a `settle` with `ok`/`failed` (trusted readback) clears it.
8. **Monotonic restore.** No delete, reset or rewind is reachable with machine credentials. Any
   owner/admin restore must refuse a snapshot whose `seq` or `epoch` is below the current values
   (`RESTORE_WOULD_REWIND`). Restore is not part of this API.
9. **Unreachable means no admission.** Client treats timeout, network error, 5xx, `AUTHORITY_DISABLED`
   or auth failure as "no admission". Nothing new runs.

### Requests

All bodies JSON, UTF-8. Common fields on mutating calls: `requestId`, `tenantId`, `taskId`, `clientSeenSeq`
(highest `seq` this client has observed; advisory, see stale detection).

```
commitCancel   {requestId, reasonCode: "owner_cancel"|"policy"|"other", clientSeenSeq}
casAdmitEffect {requestId, op: "claim",  expectedEpoch, leaseTtlMs (1000..600000), clientSeenSeq}
               {requestId, op: "effect", expectedEpoch, expectedSeq, leaseId, effectId, intentHash, clientSeenSeq}
               {requestId, op: "settle", expectedEpoch, leaseId, effectId, outcome: "ok"|"failed"|"unknown", evidenceHash}
readEpoch      (no body)
status         (no body)
```

`effectId` and `intentHash` are opaque client values (sha256 hex of the canonical intent). No
paths or prompts are sent.

### Response envelope

```
{ ok: bool, op, requestId?, replayed?: bool, tenantId, taskId,
  seq, epoch, cancelled, lease, unknownEffects: [effectId],
  result?: {leaseId?, admitted?: true, effectId?},
  error?:  {code, message, retryable: bool} ,
  committedAt?: "<RFC3339 UTC>" , backend: "remote-do" | "local-daemon" | "none" }
```

### Error codes

| Code | HTTP (C) | Retryable | Client action |
|---|---|---|---|
| `CAS_CONFLICT` | 409 | after `readEpoch` | re-read; never retry blindly |
| `CANCELLED` | 409 | no | stop; mark run cancelled |
| `LEASE_EXPIRED` | 409 | after re-claim | park current step |
| `UNKNOWN_EFFECT_PENDING` | 409 | no | park until readback settles |
| `IDEMPOTENCY_MISMATCH` | 409 | no | bug; park |
| `BAD_REQUEST` | 400 | no | bug; park |
| `UNAUTHENTICATED` / `FORBIDDEN` | 401 / 403 | no | park; owner must fix credentials |
| `AUTHORITY_DISABLED` | 404, no body detail | yes, same `requestId` | treat as unavailable: no admission; cancel stays pending |
| `TENANT_MISMATCH` | 403 | no | park, don't retry |
| `AUTHORITY_UNAVAILABLE` | 503 / timeout / network | yes, same `requestId` | no admission; cancel stays pending (404, 503 and timeout are handled alike) |
| `AUTHORITY_UNCONFIGURED` | n/a (client) | no | park |
| `BACKEND_NOT_IMPLEMENTED` | n/a (client) | no | park (unknown backend kind in config) |
| `STALE_AUTHORITY` | n/a (client) | no | park; authority `seq` < `clientSeenSeq` means a rewind/restore |

### Client semantics (PAD)

- `commitCancel` returns `acknowledged` only on `ok:true`. On unavailable/lost reply the local status is
  `cancel_pending` (shown as pending, never as durable), retried with the same `requestId`. No new effect
  is admitted for a task with a pending cancel.
- Every effect needs a fresh `casAdmitEffect op:"effect"` success; no cached admission is reused.
- Local journal/checkpoint is a cache. On replay, if local state disagrees with the authority (authority
  cancelled, higher epoch, or lower `seq` than `clientSeenSeq`), the authority wins or the run parks.
- Auth is a pluggable `authHeaders()` provider. Tests use an in-memory fake authority; no host, no token.

## 2. Model mapping (TLA+)

Abstract `Authority` with the state above. Ghost `acknowledgedCancels` (outside attacker reach).
Invariants: `TypeOK`, `CancelDurable` (acknowledgedCancels \subseteq authority cancelled),
`NoEffectAfterAuthoritativeCancel`, `NoAdvanceOnUnknownEffect`, plus `ReplayIdempotent`,
`EpochSeqMonotonic`, `LeaseFenced` (lazy expiry on admit). Safe config: AnchorGuard on.
Unsafe witnesses: AnchorGuard off (local rollback undoes cancel); C: partition, lost reply, stale
restore, replay, CAS conflict; A: daemon crash/restart, loss of local durability (ack without fsync).

## 3. Backend C: Cloudflare Durable Object

- One DO per tenant+task: `idFromName("<TENANT_ID>:<TASK_ID>")`. Single-threaded, transactional SQLite;
  the response is sent only after the storage transaction commits. No cross-DO transactions; nothing needs
  atomicity across tasks.
- Routes (all behind `AUTHORITY_ENABLED`, default off -> plain 404 with no body detail; the client maps it to
  unavailable):

```
POST https://<AUTHORITY_HOST>/v1/tenants/<TENANT_ID>/tasks/<TASK_ID>/cancel   -> commitCancel
GET  https://<AUTHORITY_HOST>/v1/tenants/<TENANT_ID>/tasks/<TASK_ID>/epoch    -> readEpoch
POST https://<AUTHORITY_HOST>/v1/tenants/<TENANT_ID>/tasks/<TASK_ID>/admit    -> casAdmitEffect
GET  https://<AUTHORITY_HOST>/v1/status                                        -> status
```

- No DELETE/PUT/reset/rewind routes. Unknown method/route -> 404.
- `Idempotency-Key: <requestId>` header must equal body `requestId`.
- Auth: Cloudflare Access service token. Client sends `CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>` and
  `CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>`; the Worker verifies `Cf-Access-Jwt-Assertion`
  against `<ACCESS_TEAM_DOMAIN>` / `<ACCESS_AUD>`. The JWT `common_name` is the service-token client id, which
  server-side config maps to exactly one tenant. The tenant is never taken from the path or the CN alone: if the
  path `<TENANT_ID>` differs from the mapped tenant, the Worker returns 403 `TENANT_MISMATCH`. Token does not
  exist yet; creating it needs the owner's approval.
- Lease expiry: alarm optional; every admit checks `now >= lease.expiresAt` first.
- Client timeouts: 5 s per call, at most 3 retries with the same `requestId`, then `AUTHORITY_UNAVAILABLE`.

## 4. Backend A: local service-account daemon

- Runs as a dedicated account `<PAD_AUTHORITY_USER>` that bots cannot become (no bot sudo, no shared group
  write). Bots reach it only through a Unix socket at `<PAD_AUTHORITY_SOCKET>` (mode 0660, group
  `<PAD_AUTHORITY_GROUP>`); the daemon checks peer credentials and maps the caller to one tenant.
- Same four operations, same JSON request/response envelope, one JSON object per line on the socket.
  Errors use the same codes; transport failure maps to `AUTHORITY_UNAVAILABLE`.
- State store: owned by `<PAD_AUTHORITY_USER>` under `<PAD_AUTHORITY_STATE_DIR>` (mode 0700). Each task is an
  append-only record log plus a snapshot. A mutation is written, the file is fsync'd and the directory is
  fsync'd before the reply is sent (commit before ack). A torn tail record is discarded on start; it was never
  acknowledged.
- `requestId` replay returns the original response, across restarts (requests are in the durable log).
- `epoch` and `seq` only go up across restarts. The daemon also keeps a high-water mark file
  (`seq`, `epoch` per task, fsync'd on every commit); on start, if the log/snapshot is below the high-water
  mark, the task is marked `STALE_AUTHORITY` and refuses `claim`/`effect` until an owner reconciles it.
- Restore: an owner-only CLI imports a snapshot and refuses any snapshot with lower `seq` or `epoch`
  (`RESTORE_WOULD_REWIND`). No socket operation deletes, resets or rewinds.
- Lease expiry: checked lazily on every admit, using the daemon's monotonic clock plus persisted
  `expiresAt` wall time; on restart, leases from before the restart are treated as expired.
- Install: the PR ships unit templates only, `launchd` plist label `<PAD_AUTHORITY_LABEL>` and a `systemd`
  unit, with every user/path as a placeholder. Tests run the daemon in-process against a temporary
  directory and a temporary socket that the test tears down; tests never install, load or start a real unit.
- Limits stated in docs: a privileged owner (root/admin) can still reset it; A protects against same-uid bots,
  not against the owner or the kernel.

## 5. Resolved with the Durable Object owner (18:09 London)

1. `requestId` records are kept for the task's whole lifetime; compaction only after terminal + retention window,
   with cancel, epoch, seq and terminal facts kept exact.
2. Disabled authority: 404 with no body detail. Client treats 404, 503 and timeouts alike as unavailable.
3. Tenant comes from server-side config keyed by the Access JWT `common_name` (client id). Path tenant must equal
   the mapped tenant, else 403 `TENANT_MISMATCH` (client: park, don't retry). PAD tests cover this with the fake
   authority.

Any further server-side deviations are listed in the pi-durable-host repo at `docs/authority-api.md` under
"Differences from client draft".

## PAD client pending-outbox clarification

An accepted local cancel must survive client crash/restart even before authority commit. The shared client requires a local `stateDir`, generates its requestId once, and fsyncs the immutable pending request and its directory before the first submission. A new instance loads all pending requests in the same task namespace and resubmits their original bodies/IDs before ordinary reads; explicit `retryPendingCancels()` is also available. New effect admission remains blocked while any cancel is pending. Only authoritative success permits durable removal of a pending record. Local acceptance and authoritative acknowledgement are distinct response fields (`accepted` and `acknowledged`). Missing or failed local persistence refuses acceptance.

This local outbox protects crash/restart, not hostile same-uid deletion before authority commit. It is not a second authority backend and cannot make an offline cancel durably acknowledged at the authority. The same shared-client restart contract must run against both backends.
