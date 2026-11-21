# Router and seats

Board Pulse asks the router to select a route seat. The router reads `.agentic-driver/router.defaults.json`, optional profile overrides and a local SQLite operational store. Operational state does not replace authenticated board claims. A missing configuration key refuses rather than guessing.

Janus is the bundled loopback evaluation service. Semantic ranking of up to eight eligible seats falls back to preference order if unavailable. The binding dispatch gate requires a verdict that the task fits the seat; without one, dispatch is blocked. See [Janus setup and endpoint contract](../janus/README.md).

| Section | Key | Default | Meaning |
|---|---|---|---|
| `eligibility.reserve` | `floorPercent` | 40 | Keep quota headroom per account and window. |
| `eligibility.reserve` | `scope` | `account-window` | Apply the reserve per account and window. |
| `eligibility.reserve` | `coldStartFraction` | 0.25 | Estimate consumption without history. |
| `eligibility.reserve` | `estimateSamples` | 20 | Average recent dispatches. |
| `eligibility.reserve` | `estimateMinSamples` | 5 | Minimum trustworthy sample count. |
| `eligibility.reserve` | `estimateOutlierSigma` | 3 | Exclude extreme estimates. |
| `eligibility.reserve` | `ownerInteractiveOverride` | false | No reserve bypass for interactive dispatch. |
| `ranking` | `janusUrl` | `http://127.0.0.1:8787` | Loopback evaluation endpoint. |
| `ranking` | `maxCandidates` | 8 | Maximum seats ranked. |
| `ranking` | `fallback` | `preference-order` | Fallback when ranking is down. |
| `gate` | `threshold` | 0.9 | Required fit confidence. |
| `gate` | `timeoutMs` | 8000 | Gate wait before refusal. |
| `gate` | `requestBudgetTokens` | 30000 | Request size limit. |
| seat | `maxConcurrency` | 4 | Seat-local worker ceiling. |
| policy | `maxConcurrent` | 4 | Global worker ceiling. |

Seats describe infrastructure capacity, not fixed models. Each seat has a mutable model route and plain-language `scopeStatements` for the dispatch gate. Changing a model does not rename a seat. Route affinity does not override capacity or authority.

## Router and Janus: full configuration and operation

Board Pulse selects a route seat through the capacity/policy router. The
router reads a closed configuration file and a local-first SQLite file for
operational state (reservations, observations, route-decision audit).

Two router features call **Janus** — a separate local service, bundled under
`janus/`, that is the only component allowed to talk to the TypeSafe Jev
models:

- **Semantic ranking** (optional): Janus ranks up to eight eligible seats;
  on any Janus failure the router falls back to preference order.
- **The binding dispatch gate**: before a task is claimed, Janus judges
  whether the task fits the selected seat. No verdict, no dispatch — the
  gate fails closed when Janus is unreachable.

Janus binds loopback only (`127.0.0.1:8787`), reads its API key from the
macOS Keychain at runtime, redacts state before every external call, and
coalesces identical requests. See [Janus setup](../janus/README.md) for the endpoint
contract, Keychain provisioning, and configuration.

- **Repository defaults** ship at `.agentic-driver/router.defaults.json`. The
template contains no accounts and one disabled placeholder seat, so it loads
out of the box and schedules nothing until you enable a real seat.
- **User profile (precedence over defaults):**
the configured router profile path, or the path in the
`AGENTIC_DRIVER_ROUTER_PROFILE` environment variable. A profile section
replaces the matching defaults section wholesale; the merged config must
validate or the router refuses to produce decisions (fails closed).
- **Operational state:** `~/.local/share/agentic-driver/router/state.db`, or
`AGENTIC_DRIVER_ROUTER_DB`. This store is operational state only. The
authenticated claims file and the board writer remain the only dispatch
authority; the system repairs SQLite from them, never the reverse.
- **Runtime requirement:** the operational store uses the built-in
`node:sqlite` module. You need Node.js 22.5 or newer.


Every numeric policy in the router is a configuration key — never a
constant in code. All keys are **required**. The repository defaults below
are conservative starting values. Your profile overrides them. A missing key
is a configuration validation failure: the router fails closed rather than
guess. Changing a value participates in the configuration digest, so cached
routing decisions computed under the old values no longer apply.

| Section | Key | Default | What it controls |
|---|---|---|---|
| `eligibility.reserve` | `floorPercent` | 40 | Share of every quota window kept in reserve (per account, per window). Headroom for an unexpected burst and your next interactive session, without idling the account. |
| `eligibility.reserve` | `scope` | `account-window` | How widely the reserve floor applies (per account per window at launch). |
| `eligibility.reserve` | `coldStartFraction` | 0.25 | Consumption assumed for a seat with too little history: deliberately generous, so a mis-estimate fails eligibility instead of draining the account. |
| `eligibility.reserve` | `estimateSamples` | 20 | How many recent dispatches the consumption estimate averages: enough to smooth outliers, quick enough to track a model change. |
| `eligibility.reserve` | `estimateMinSamples` | 5 | Below this many observations, the estimator treats the average as noise and uses the cold-start value instead. |
| `eligibility.reserve` | `estimateOutlierSigma` | 3 | Outlier cut for the estimate: one unusually slow dispatch cannot inflate the average, real tail latency is kept. |
| `eligibility.reserve` | `ownerInteractiveOverride` | false | Whether your own interactive dispatches bypass the reserve rule (they do not, at launch). |
| `ranking` | `janusUrl` | `http://127.0.0.1:8787` | The local Janus evaluation service endpoint used for semantic ranking. |
| `ranking` | `maxCandidates` | 8 | The router ranks at most eight eligible seats per request; preference order trims the list first. |
| `ranking` | `fallback` | `preference-order` | What happens when ranking is unavailable: dispatch falls back to your preference order and never blocks. |
| `gate` | `threshold` | 0.9 | The dispatch gate's confidence threshold. A task is only dispatched when the evaluation clears it. Lower it only with evidence from your own audit log. |
| `gate` | `timeoutMs` | 8000 | How long the gate waits for an evaluation. On timeout there is no verdict, and the gate blocks dispatch (fail closed). |
| `gate` | `requestBudgetTokens` | 30000 | Maximum size of a gate evaluation request. Normal evaluations use under a thousand tokens. |
| seat record | `maxConcurrency` | 4 | How many workers one seat may run at once. The default suits a typical single machine or hosted seat. Tune it per seat: a cluster takes more, a constrained subscription endpoint may take less. |
| automation policy | `maxConcurrent` | 4 | How many workers may run at once across all seats. The default is a conservative start. Tune it to the capacity you actually have, and raise it when you add seats or hardware. |

Seats are named for infrastructure, not models: `dgx-spark`,
`dgx-spark-cluster`, `mac-studio`, `mac-studio-cluster`, `strix-halo`,
`strix-halo-cluster`, `merge-gateway-worker`. The model is a mutable field on
the seat, so changing models never renumbers your configuration. Each seat
also carries `scopeStatements`: plain-language descriptions of what the seat
is for. The dispatch gate reads them when judging whether a task fits.




Janus is the local evaluation service bundled in this repository under
`janus/`. It is the only component allowed to talk to the TypeSafe Jev
model. It wraps the official TypeSafe SDK. It exposes one evaluation endpoint
and health probes on loopback. The router's semantic ranking and binding
dispatch gate call it. Nothing else in the harness talks to Jev directly.

**Guarantees:**

- **Loopback only.** Janus binds `127.0.0.1:8787` and nothing else. There is
  deliberately no bind-address option: it is a local tool.
- **Key stays in the macOS Keychain.** Janus reads the TypeSafe API key at
  runtime with a guarded `security` lookup. It never passes the key to
  subprocesses. It never writes the key to logs or transcripts.
- **Redaction before every external call.** A secrets/PII pass runs over the
  state before anything leaves the machine. No disable knob exists.
- **Single-flight.** Janus coalesces identical requests. It caps distinct
  in-flight evaluations. It rejects overflow with `busy` instead of queuing
  silently.
- **Controlled requests.** Janus enforces a 30k-token request budget. It
  rejects oversized requests instead of truncating them.

**Running it:**

```sh
cd janus
```

```sh
sfw npm install
```

```sh
npx tsx janus/server.ts
```

For a persistent setup, use the launchd template at
`janus/user.janus.plist`. Provision the TypeSafe Direct key once in the
Keychain. The command is in [Janus setup](../janus/README.md).

**When Janus is down:** semantic ranking falls back to preference order. The
binding dispatch gate blocks dispatch and fails closed. Janus never becomes a
silent dependency: its absence is loud.

See [Janus setup](../janus/README.md) for the full endpoint contract, error taxonomy and configuration.
