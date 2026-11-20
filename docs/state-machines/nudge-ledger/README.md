# Nudge ledger lifecycle

One entry begins as `requested` with no delivery state and can receive **one** terminal result. The implementation never overwrites an existing terminal. The classifier is separate: its seven states describe agent observations, not the ledger's seven result values. No nudge transport or recovery action is enabled by this model.

| Result | Nudge deliveryState | Replacement deliveryState | Revert anchor? |
|---|---|---|---|
| requested | absent | absent | no |
| delivered | delivered | invalid | yes (nudge) |
| rejected | rejected-before-delivery | invalid | no |
| unknown | unknown | invalid | no |
| spawned | invalid | absent | yes (replacement) |
| failed | absent or delivered / rejected-before-delivery / unknown | absent | no |
| parked | absent or delivered / rejected-before-delivery / unknown | absent | no |

All other combinations are invalid for new entries. Historical entries lacking `deliveryState` remain readable by validation; new nudge writes of `delivered`, `rejected`, or `unknown` require it. `failed` and `parked` are action outcomes that may follow any transport state or no attempted delivery. A replacement has no nudge delivery field.

`NudgeLedger.tla` models one request, one allowed terminal transition, and a terminal state with no outgoing transition. `OneTerminal`, `ResultDelivery`, and `TypeOK` are checked with `NudgeLedger.cfg`. The in-memory ledger's entry ID links the phases; this model does not prove durable persistence, cross-process concurrency, or authorization. Existing ledger bytes are not migrated or rewritten.

TLC: run from a real repository `.scratch/` directory using `$PI_HOME/pi/bin/tlc -config NudgeLedger.cfg NudgeLedger.tla` on copies of the two model files. See `tlc-result.txt` for the checked result.
