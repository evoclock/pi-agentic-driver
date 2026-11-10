# Bounded statechart evidence

`model/EFDW.tla` represents new and already-exhausted units. It bounds reviews at two, models correction, QA rejection, recovery transfer, delivery and owner-confirmed cleanup. It assumes author and reviewer constants are correctly supplied; it has no live worker, Git, receipt, cancellation or effect-outbox semantics. `CHECK_DEADLOCK FALSE` permits terminal stop/cleanup. No render-and-inspect route exists in the installed-only `run-tlc.mjs` adapter: **visual layout not checked**. The tool checks the TLA+ model only; it does not draw a chart.

Run from the repo root with the installed `statechart-pi` runner after making a real, ignored `.scratch/efdw` and copying the three reviewed files from `model/`. Set `STATECHART_RUNNER` to that installed script's path (not an untrusted plan value). The `.scratch/` directory is gitignored, not versioned evidence:

```sh
node "$STATECHART_RUNNER" --check
node "$STATECHART_RUNNER" --spec .scratch/efdw/EFDW.tla --config .scratch/efdw/safe.cfg --out .scratch/efdw/safe-final --timeout-seconds 60
node "$STATECHART_RUNNER" --spec .scratch/efdw/EFDW.tla --config .scratch/efdw/unsafe.cfg --out .scratch/efdw/unsafe-final --timeout-seconds 60
```

Detected installed checker `tlc`, TLC2 **2.19**, adapter SHA-256 `ec715c4b58e04346f5f4ddfe39ad03faf43df7f18534d9de76bd764929e3049a`, Node **v26.12.1**. `--check` returned `available-not-run` before the checks. Spec SHA-256 `a1e84a7e64524dd726bd44e43c77315c9c0673f8d31846d81c6cc2ee2bdf9c69`; safe config `e045360a4f20fe2a5b74c84f7730e97bba5cfff2a95d87869a7bcbedba496165`; unsafe config `948f914eb4b4313bd8b4e17222de1a7d4941706136c9028775513f23fc9ee728`. Compare hashes before rerunning.

| Config | Local result.json / tlc.out | Result and bounded output |
| --- | --- | --- |
| safe | `.scratch/efdw/safe-final/{result.json,tlc.out}` | `checked-no-errors`, exit 0; 35 generated, 23 distinct states, depth 9, 0 left on queue; "Model checking completed. No error has been found." |
| deliberately unsafe | `.scratch/efdw/unsafe-final/{result.json,tlc.out}` | `failed`, checker exit 12; `NoThirdReview` violated. Counterexample: initial `reviews=2`, `phase="recovery"`, then `UnsafeReviewAfterRecovery` moves to `reviews=3`, `phase="review"`. Two-state trace, 6 distinct states. |

The deliberately unsafe variant toggles the `Unsafe` constant; it is not a production escape hatch. The counterexample is an abstract spec defect by construction, not a discovered PAD runtime bug. An initial parse/evaluation error from an unparenthesized conditional was corrected before these final runs; the final hashes above identify the checked version. No live guard or autonomous delivery is proved.
