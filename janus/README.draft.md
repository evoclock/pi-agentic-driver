# janus — Jev evaluation wrapper service

janus is the local wrapper service for the Jev decision layer (design of
record: `.private-planning/JEV_DECISION_LAYER_DESIGN.md` §5–§7, Revision 2.1).
It wraps the official `@typesafe-ai/sdk` (TypeSafe Direct — the sole
provider; the Vercel AI Gateway and merge gateway were dropped by owner
decision) and exposes one evaluation endpoint plus health/readiness/version
probes on loopback.

## What janus does

- `POST /evaluate` — evaluates typed questions (boolean / choice / score)
  against one shared state via TypeSafe Direct (`typesafe-ai`, model `jev-latest`).
- `GET /healthz` — liveness.
- `GET /readyz` — readiness (gateway key resolvable from the Keychain).
- `GET /version` — janus version, AI SDK version, schema versions, allowlist.

Guarantees:

- **Model allowlist** (server-side config; request-level model overrides are
  rejected with `model_unauthorized`).
- **Loopback only** — binds `127.0.0.1` and nothing else. No auth beyond
  loopback; it is a local tool. There is deliberately no bind-address option.
- **Single-flight** — identical requests (same evalInputDigest) coalesce;
  distinct in-flight evaluations are capped (default 4) and rejected with
  `busy`.
- **30k-token request budget** — oversized requests are rejected with
  `state_too_large`, never truncated silently.
- **Redaction** — a general secrets/PII pass runs over the state before any
  external call.
- **Audit log** — append-only JSONL of request id, timestamps, question
  names, verdict probabilities, and token usage. **State contents never
  reach the audit log.** 90-day default retention, size-capped with
  oldest-first rotation.
- **Daily cost breaker** — token/cost ceilings in config; on exceed,
  `/evaluate` returns `busy` with `budget_exhausted` detail until the UTC
  day window resets.
- **Timeouts** — 30s service-side cap; callers may pass a shorter
  per-request `timeoutMs` (capped at 30s).

## Provisioning the Keychain item

The TypeSafe Direct key is read from the macOS Keychain at runtime — janus
does not rely on inherited environment variables. The `typesafe-ai` /
`Typesafe AI` generic-password item does not exist by default; create it
once (interactive provisioning):

```sh
security add-generic-password -U -a typesafe-ai -s "Typesafe AI" -w
# prompts for the secret; nothing is echoed
```

janus reads it with `security find-generic-password -w` under guarded
capture: stdout is piped directly into memory, never echoed, never logged,
never passed to spawned subprocesses. If the item is missing, janus returns
`model_unauthorized` with `detail.key_unavailable: true` and `GET /readyz`
reports 503 with the provisioning hint.

Verify the item is present (no secret material is printed):

```sh
/usr/bin/security find-generic-password -s "Typesafe AI" -a typesafe-ai >/dev/null 2>&1 && echo present
```

To rotate the secret, re-run the `security add-generic-password -U` command
above and enter the new value at the prompt (`-U` updates the existing item).
To remove the item entirely:

```sh
security delete-generic-password -a typesafe-ai -s "Typesafe AI"
```

## Running

Dev (from `janus/`):

```sh
npx tsx janus/server.ts          # listens on 127.0.0.1:8787
```

Config is read from `~/.config/typesafe-ai/jev/janus-config.json`
(override with `JANUS_CONFIG_PATH`). Defaults work with no file:

```json
{
  "port": 8787,
  "modelAllowlist": ["typesafe-ai/jev"],
  "defaultModel": "typesafe-ai/jev",
  "maxConcurrent": 4,
  "dailyTokenCeiling": 2000000,
  "dailyCostCeilingUsd": 10,
  "audit": { "path": "~/.local/share/janus/audit", "maxBytes": 10485760, "retentionDays": 90 }
}
```

launchd (label `dev.julen.janus`) — template at `janus/dev.julen.janus.plist`:

```sh
cp janus/dev.julen.janus.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/dev.julen.janus.plist
```

Tests (no live gateway calls — the SDK is mocked):

```sh
cd janus && npm test
```

## Endpoint contract

### POST /evaluate

Request:

```json
{
  "state": "string | object | array (message histories pass directly)",
  "questions": [
    { "type": "boolean", "question": "Was a refund issued?", "threshold": 0.9 },
    { "type": "choice", "question": "Route this ticket", "choices": ["billing", "tech", "other"] },
    { "type": "score", "question": "Rate this PR" }
  ],
  "model": "optional; must be on the server allowlist, overrides rejected",
  "timeoutMs": 10000
}
```

Question schema v1 (§6), enforced atomically — any malformed, absent, or
contradictory element fails the whole request with `validation_error`:

- **boolean** — `threshold` optional, default `0.9`, comparison
  `probability >= threshold`. Optional `criteria: {true?, false?}` labels.
- **choice** — `choices` array REQUIRED; the verdict's `choice` is guaranteed
  to be a member.
- **score** — numeric 0..5, one decimal. Ordinal vocabularies must be
  **choice** questions, not scores.

§6 → SDK mapping (verified against ai@7.0.106 at launch step 1): the SDK's
`experimental_evaluate` has **no top-level `criteria` argument**; the
candidate set lives inside each question as a REQUIRED `criteria` field
(choice: `Record<option, description | null>`; score: ordered level array;
boolean: optional `{true?, false?}`). janus accepts §6's `choices` array at
the transport layer and maps it to `criteria: {a: null, b: null, ...}`. The
score vocabulary is passed as the ordered level array `["0".."5"]`.

Success response (200):

```json
{
  "request_id": "uuid",
  "verdict": {
    "Was a refund issued?": { "type": "boolean", "probability": 0.97, "passed": true },
    "Route this ticket": { "type": "choice", "choice": "billing", "probabilities": {} },
    "Rate this PR": { "type": "score", "score": 3.0 }
  },
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
  "model": "typesafe-ai/jev",
  "digest": "sha256 evalInputDigest"
}
```

"Model returned false" is a **200** with `passed: false` / low probability —
not an error.

### Error taxonomy

All errors: `{ "error": code, "message": ..., "request_id": ..., "detail"?: {...} }`

| Code | HTTP | Meaning |
|---|---|---|
| `validation_error` | 400 | bad request (schema, JSON, unknown route) |
| `state_too_large` | 413 | over the 30k-token budget; never truncated |
| `unknown_question` | 400 | reserved for router/schema-version mismatches |
| `model_unauthorized` | 403/502/503 | not on allowlist, credential rejected, or key unavailable (`detail.key_unavailable`) |
| `gateway_unavailable` | 503 | gateway unreachable / model missing / rate limit |
| `timeout` | 504 | evaluation exceeded the budget |
| `busy` | 429 | concurrency cap or `detail.budget_exhausted` |
| `degraded` | 503 | internal error |

Callers distinguish **"model returned false"** (200, low probability) from
**"no verdict"** (`timeout` / `gateway_unavailable`) from **"bad request"**
(`validation_error`).

## Layout

```
janus/
  janus/
    config.ts          config load/validate (allowlist, ceilings, retention)
    schema.ts          §6 question schema v1 enforcement (atomic fail-closed)
    verdict.ts         verdict enforcement (membership, ranges, thresholds)
    budget.ts          token estimation, 30k budget, evalInputDigest
                       redaction pass: shared library typesafe-secure
                       lib/redaction (MIT), wired via a file: dependency
    keychain.ts        guarded `security find-generic-password -w` capture
    single_flight.ts   digest coalescing + concurrency cap
    budget_breaker.ts  daily token/cost breaker
    audit.ts           append-only JSONL audit log, rotation + retention
    sdk.ts             THE ONLY AI SDK import site (pinned versions)
    evaluate.ts        /evaluate pipeline + SDK error classification
    server.ts          HTTP surface, loopback bind, entrypoint
  tests/               node:test suites (mocked SDK, no live calls)
  dev.julen.janus.plist  launchd template
```
