# Bounded completion after the history cap

## Design

The ordinary cap remains 1,024 admitted events. It stops polling and new
work, not verified completion of an already-issued **final** intent. Five
reserved records allow one verified wake, its consuming tick, one verified
receipt, the DONE tick, and an owner stop instead of continuing. The absolute
admission guard is 1,029 records. No invalid evidence, replacement receipt,
repeated wake, ordinary look, or fresh dispatch may consume that reserve.
A receipt can finish without a wake. A wake alone cannot attest completion.
Existing receipt identity, commit, epoch and writer checks remain unchanged.

Settled owner controls are semantic no-ops. They return the current settled
state without appending history, admitting another event id, or increasing
the epoch. Previously admitted ids still receive the existing conflict and
replay checks first. Fresh no-op control ids are deliberately not remembered;
this is not a promise of permanent id-conflict detection for rejected or
unadmitted inputs. Both hold and cancel retain their first stop record.

This uses small terminal headroom rather than exempting all receipt/wake
traffic, which could grow history indefinitely. It does not restart earlier
steps or permit a new effect after the cap. Legacy stores already beyond the
new absolute limit require reconciliation; this change does not rewrite them.

## Model and action mapping

`Fix4RunnerGap5.tla` is a bounded completion refinement alongside the unchanged
original and RR5 writer/owner-stop models. Two polls abstract the production
cap; the model starts with an issued final intent parked awaiting evidence.

| Model action | Runtime rule / regression |
| --- | --- |
| Poll | Ordinary `look` admission ends at 1,024. |
| Wake | Verified final-intent wake can use the reserve once. |
| WakeTick | A tick consumes that wake without dispatching another effect. |
| Receipt | A verified final receipt fills an empty pending slot. |
| Finish | Matching pending evidence advances the final intent to DONE. |
| OwnerStop | First cancel/hold still settles at the ordinary cap. |
| RepeatControl | Settled controls return without history or epoch growth. |

The new completion regression replays Wake, WakeTick, Receipt and Finish
through `run()` after a reducer-generated polling prefix. That prefix is
seeded as an authenticated checkpoint in its isolated temporary repository;
it is not a claim of 1,024 disk-level poll interleavings. Invalid receipts,
repeated wakes and replacement receipts are refused without using headroom.
The owner-control regression replays OwnerStop then repeated controls with
fresh synthetic ids. The existing RR5 defect-2 test is unchanged.

## TLC observations

All outputs below are new files. Existing evidence baselines are unchanged.
Home paths in saved output are replaced with `<OWNER_HOME>`.

| Config | Result | Generated | Distinct |
| --- | --- | ---: | ---: |
| Gap5 safe | TypeOK, CompletionAvailable, HistoryBound pass | 118 | 45 |
| Gap5 unsafe terminal | CompletionAvailable violation | 34 | 19 |
| Gap5 unsafe control | HistoryBound violation | 151 | 75 |
| Original safe, repeated after controls | All seven invariants pass | 49,255 | 6,163 |
| Original IdentityGuard off | CancelledNeverActs violation | 1,538 | 324 |
| Original HaltGuard off | NoActAfterHalt violation | 1,408 | 247 |
| Original WriterGuard off | OneWriterNoFork violation | 29,474 | 2,496 |
| Original FactGuard off | CompactionExact violation | 58 | 38 |
| Original BoundGuard off | StoreBound violation | 156 | 65 |
| Original WriterGuard off, journal only | NoJournalFork violation | 161,038 | 11,278 |
| RR5 safe | TypeOK, OneWriterNoFork, OwnerStopAvailable pass | 131 | 48 |
| RR5 unsafe generation | OneWriterNoFork violation | 145 | 68 |
| RR5 unsafe owner-cap | OwnerStopAvailable violation | 108 | 48 |

New output names are `gap5-safe.out`, `gap5-unsafe-*.out` and
`gap5-recheck-*.out`. Parallel breadth-first exploration can change unsafe
state counts without changing the violated invariant or shortest trace.
The HaltGuard control omits CancelledNeverActs to expose NoActAfterHalt;
the journal control checks only NoJournalFork, as prescribed by the skill.
The original safe run checks TypeOK, CancelledNeverActs, NoActAfterHalt,
OneWriterNoFork, NoJournalFork, CompactionExact and StoreBound explicitly.

Reproduce by copying each model and selected config into a fresh repository
`.scratch/workflow-runner/` directory. Name the selected config after the
module and use the installed Java/TLC invocation in the project formal skill.
Do not overwrite existing output. Unsafe runs must exit with their named
invariant violation, not parsing errors. The control counterexamples begin
with ordinary polling or an owner stop, then attempt refused completion or
repeat settled controls beyond the bound.

## Runtime checks and limits

The four-file runner fixture suite passed 68 tests on the candidate source.
All 13 isolated source mutations were killed: three new terminal admission,
pre-lock admission and control-deduplication mutants, plus ten inherited
controls. The inherited owner-cap mutation anchor includes the new terminal
predicate while its original behavioral test remains unchanged. Each mutant
is exercised in a temporary copy and removed afterward.

The finite model assumes an already-issued final intent and valid evidence.
It does not prove fairness, arbitrary filesystem schedules, serialization,
same-user security, worker effects or procedure adherence. DONE still reports
`procedureVerified: false`. The reserve bounds admitted records, not arbitrary
input byte sizes or external worker lifetime. Gate and CI are separate checks;
these TLC and fixture observations alone are not delivery or merge approval.
