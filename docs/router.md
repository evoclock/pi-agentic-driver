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
