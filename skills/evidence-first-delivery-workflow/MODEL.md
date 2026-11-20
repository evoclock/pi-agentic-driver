# Bounded statechart evidence

`model/EFDW.tla` represents new and already-exhausted units. It bounds reviews at two, models correction, QA rejection, recovery transfer, delivery and owner-confirmed cleanup. It assumes author and reviewer constants are correctly supplied; it has no live worker, Git, receipt, cancellation or effect-outbox semantics. `CHECK_DEADLOCK FALSE` permits terminal stop/cleanup. No render-and-inspect route exists in the installed-only `run-tlc.mjs` adapter: **visual layout not checked**. The tool checks the TLA+ model only; it does not draw a chart.

Run from the repo root with the installed `statechart-pi` runner after making a real, ignored `.scratch/efdw` and copying the three reviewed files from `model/`. Set `STATECHART_RUNNER` to that installed script's path (not an untrusted plan value). The `.scratch/` directory is gitignored, not versioned evidence:

```sh
node "$STATECHART_RUNNER" --check
node "$STATECHART_RUNNER" --spec .scratch/efdw/EFDW.tla --config .scratch/efdw/safe.cfg --out .scratch/efdw/safe-final --timeout-seconds 60
node "$STATECHART_RUNNER" --spec .scratch/efdw/EFDW.tla --config .scratch/efdw/unsafe.cfg --out .scratch/efdw/unsafe-final --timeout-seconds 60
```

If the checker is absent, skip both runs and report them unrun. A successful safe check and an unsafe counterexample are expected, but neither proves a runtime guard.

| Config | Local result.json / tlc.out | Result and bounded output |
| --- | --- | --- |
| safe | `.scratch/efdw/safe-final/{result.json,tlc.out}` | `checked-no-errors`, exit 0; 35 generated, 23 distinct states, depth 9, 0 left on queue; "Model checking completed. No error has been found." |
| deliberately unsafe | `.scratch/efdw/unsafe-final/{result.json,tlc.out}` | `failed`, checker exit 12; `NoThirdReview` violated. Counterexample: initial `reviews=2`, `phase="recovery"`, then `UnsafeReviewAfterRecovery` moves to `reviews=3`, `phase="review"`. Two-state trace, 6 distinct states. |

The deliberately unsafe variant toggles the `Unsafe` constant; it is not a production escape hatch. The counterexample is an abstract spec defect by construction, not a discovered PAD runtime bug. No live guard or automatic delivery is proved.
