# Decision: stale base

Choose the reusable fetched-base check before baseline, lock publication and shared gate; expose it for review preflight. Alternative: reporting missing tests after diff inspection permits false evidence. Hold remains available on fetch failure. Owner-only merge is not automated. Review preflight is owned by the parallel stream; its integration is pending, not proven by this PR.

The finite model uses three monotonically advancing main generations and ancestry represented by generation equality. Fetch/check and each modeled boundary are atomic. Historical locks/reviews record freshness **at creation**, not perpetual freshness after main advances. Catch-up models a non-rebasing merge and resets the workflow. Push/CI/owner merge are modeled boundaries, not execution authority. A remote can advance after fetch: no local check can rule out that distributed race forever; later boundaries must recheck. No lease-tool implementation is trusted by this model.

Manual model: `BaseFreshness.tla`. Run each adjacent config using:

```sh
"$JAVA" -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -metadir ".scratch/base-freshness-tlc/$name" -config "$cfg" docs/design/test-gate-freshness/BaseFreshness.tla
```

Observed TLC 2.19, Java 27.0.1:

| Config | Exit | Result |
| --- | --- | --- |
| BaseFreshness | 0 | 148 generated, 48 distinct, queue empty, depth 9; all four invariants pass |
| unsafe-lock | 12 | NoLockOnStaleBase: Advance then Baseline records lockFresh=FALSE |
| unsafe-review | 12 | NoReviewOnStaleHead: Baseline, Advance, Review records reviewFresh=FALSE |
| unsafe-missing | 12 | StaleNeverClassifiedAsMissingTest: Advance then Reject records missing |
| reach-merge | 12 | NeverMerged: Baseline, Review, Push, CI, Merge reaches merged |
| reach-stale | 12 | NeverStale: Advance then CatchUp reaches stale |

Safe checking is not a vacuous hold: merge and stale-recovery witnesses are reachable. These results prove only the bounded abstraction. Review integration, actual ancestry/fetch failure, loader evidence and lock preservation require executable conformance tests.

## Implementation boundaries

`make base-freshness` invokes `scripts/check_base_freshness.py`. Remote `origin/*` refs are fetched explicitly into their tracking refs, with bounded Git subprocesses; configured local base refs support isolated fixture repositories. Failed observations block rather than falling back to cached refs. Test-gate checks before collecting changed/inherited tests and again immediately before publishing or refreshing a baseline lock. The latter check also rejects a changed HEAD or changed base generation. `make gate` checks freshness first. Buildkite PR jobs depend on an early freshness step.

`make lease-start` additionally requires HEAD to equal the fetched tip and exclusively records `.local/lease-base.json` before edits. It does not infer a historical lease start from current ancestry or silently rewrite an existing record. Fleet guidance requires this assertion immediately after creating new Treehouse leases. External lease creation is not intercepted by this repository; this is an explicit integration limit, not proof that every external lease invocation is fresh.

Loader classification uses failed TAP diagnostic blocks, not arbitrary output strings. File-level `ERR_TEST_FAILURE` and uncaught module-resolution error codes contribute infrastructure errors while preserving the reporter's observed failed-case total and actual child exit code. The ordinary fail-first error rejection then prevents both initial locks and audited refreshes. Caught import-error assertions and harmless printed error names remain valid.

## Observed implementation checks

Native baseline observed eight conformance cases with assertion failures against base production and zero unittest errors, then locked the inputs. A positive-control fixture initially lacked a supported automatic mutation; an audited `--phase refresh --reason ...` repaired that fixture's comparison without changing assertions. The corrected conformance suite passes on head. Existing and new test-gate conformance: 75 tests passed.

The first attempt was held: native check rejected changed production with only inherited mutation contracts. Its baseline already locked `.driver/test-gate.json` and `.driver/gate-rules.json`; audited refresh explicitly forbids changing locked configuration. No lock or evidence was hand-edited.

## Configuration transition

The approved route is an append-only authored mutation entry followed by a full native baseline in a fresh Treehouse lease, preserving the original attempt and evidence. `ConfigurationTransition.tla` models this route and hold; the safe config passes TLC (exit 0), and the unsafe control exits 12 on `LockCoversCheckedConfiguration`. Sanitized complete output is adjacent. Run it with the same TLC invocation above, replacing the module and config names. This abstracts configuration identity; it does not authorize editing a lock.

The new `test-gate-loader-infrastructure` entry targets the classifier and runs the focused CLI conformance suite in the native production snapshot. Every inherited entry and every unrelated configuration field is retained. The synthetic legacy-runner fixture copies the new freshness dependency, while its new reporter test executes a real uncaught Node import before checking observed errors. Pipeline conformance requires exactly seven steps: one early PR freshness step followed by all six original steps, with explicit dependencies from the five executing jobs.

`docs/gate.md` documents a reviewed exact-file/exact-hash allowance, not a hash-refresh command. `scripts/gate.py` only verifies allowances and runs checks; it exposes no refresh writer. The reviewed source updates therefore change only the existing pipeline allowance and the two matching shared-runner pins:

| File | Old SHA-256 | New SHA-256 |
| --- | --- | --- |
| `.buildkite/pipeline.yml` | `692b6cafd22ab8d29d8b861a4ba1c87251f4e6ae6b4e2a08295173a61d8e9bc7` | `6735353bd5eb8dfc220d95e8ef5ff9b933f3bbb09e616f1505b931df65921c30` |
| `scripts/test_gate_runner.py` | `0c96c3b05073c21dbf6bb46ef2b219f03126fea75b33463bd0fcbf7c1848e67a` | `4c0ee791f071b7939ffc1ef1db419593f40cdc3e621b5936fbb18012fbd97c17` |

The pipeline diff adds only freshness scheduling; existing install commands, check scope and caps remain unchanged. The runner diff adds freshness entry/publication checks and TAP infrastructure classification. Review the complete contents associated with these hashes; no broader allowance is introduced. Final native and shared-gate results must be observed after the fresh baseline before a readiness claim.

The fresh lease started at the fetched main tip, verified and recorded before selecting the prepared implementation head. The initial full native check killed the new loader mutant (three assertion failures, zero errors), then exposed an overbroad `ERR_TEST_FAILURE` classification in an inherited authority-daemon mutant: Node also uses that code for an executed TypeError. The fix requires a file-process `exitCode` diagnostic for generic `ERR_TEST_FAILURE`; direct loader-resolution codes remain infrastructure. A real Node assertion-plus-TypeError control fails against the prior classifier (one assertion failure) and passes with the narrowed classifier. Inherited mutations are unchanged. Updated test/pin hashes go through the existing audited test-only refresh with unchanged gate configuration; the original attempt and its evidence remain preserved.

## Decision: observability base handoff

Buildkite #590 reported a contained base from historical production even though the feature head already contained current main. Inspection found two unchecked selections in `scripts/ci-observability.sh`: the host used `git merge-base` against its cached tracking ref without fetching, then the container recomputed against its materialized local main. No literal historical SHA is selected by those statements. A real isolated Git fixture reproduces the failure with an old tracking ref and a feature head that has already merged new main. A separate fixture reproduces a stale image ref. This verifies the cache/materialization mechanism without claiming unobserved host metadata from the supplied excerpt.

The host now selects its base through the single freshness CLI after fetching on that host. `--print-base` emits only the verified commit on success and keeps rejection diagnostics on stderr so shell substitution cannot swallow them. The exact verified base/head pair crosses the existing cleared environment into the network-none container. Before invoking native test-gate, the same CLI checks local main and HEAD against that pair. This is observation binding, not an authorization token or permission to use an arbitrary stored SHA. No network is added inside containment; a host fetch failure has no cached fallback.

`ObservabilityBase.tla` adds `GateUsesVerifiedBase` to cover a fresh head paired with an obsolete selected base, a case the original head-ancestry model did not cover. Safe TLC exits 0 (68 distinct states). Unsafe cached-selection and unsafe image-check controls each exit 12 on that invariant. Reachability controls demonstrate both gate entry and rejection. Configs and complete sanitized output are adjacent; use the same TLC invocation with the new module/config names. The model binds the host's fetched sample, not a permanently frozen live remote.

Seven conformance cases execute the actual shell host/offline selection blocks in isolated Git repositories, without Docker or external network. They cover stale tracking refs, stale head, failed fetch, image-base drift, image-head drift, a valid offline handoff, and native fail-first with a named export added by new main. All seven fail by assertion against the previous implementation and pass after the repair. The native baseline case requires a real executed assertion and no loader errors. A focused cached-selection mutant is appended without changing any existing contract. The loader classifier, shared-runner pin, pipeline allowance, containment controls and package/lockfiles remained unchanged in that observability follow-up.

## Review recurrences B1 and B2

The exact-head review at 8519c58 reproduced two admission gaps. Dynamic ESM linking/parsing can report SyntaxError plus ERR_TEST_FAILURE with no process exitCode, so the first classifier accepted unreachable assertions. A comparison SHA also replaced the live anchor, permitting a stale head to lock against an old ancestor. Both were real defects, not missing tools or harmless remote advancement.

B1 now recognizes structured SyntaxError diagnostics whose first stack frame is in Node's module loader, in addition to file-process exits and resolution codes. It does not infer a loader crash from arbitrary output, every SyntaxError or an executed TypeError. A closed conformance table exercises static/dynamic resolution, linking and parsing through the real baseline and refresh CLI, including no-new-lock and byte-identical prior-lock assertions. Caught linking/parsing failures retain real assertion-red/head-green controls; the executed-TypeError control remains unchanged. New supported loading paths must extend the table's explicit closed inventory.

B2 separates the configured live freshness anchor from the comparison revision. Ordinary baseline/check/refresh always check the configured anchor, independently of --base; publication checks the anchor again. Historical comparison remains supported when HEAD contains the live anchor. The BaseFreshness model now has an independent comparison variable. Safe TLC passes with 72 distinct states. The new unsafe-override control exits 12 on NoLockOnStaleBase; all previous negative and reachability controls still meet their expected results. Current complete sanitized output is TLC-review-B2.txt; TLC-results.txt records the historical pre-override model run.

The offline acceptance route cannot be selected by a comparison override. Only the canonical contained work root with an observed pair requests it. The shared helper then verifies Linux, the existing unprivileged identity, no effective capabilities, no-new-privileges, loopback-only interfaces, read-only /source and exact immutable source main/head equality. The working main/head pair must also match. Ordinary fixtures and caller-supplied environment strings cannot opt an online checkout out of its live check. Read-only source Git inspection uses command-local safe.directory for that one verified mount, not a global trust change. No network or containment capability was added.

Two new focused mutation keys preserve the preceding 101 entries. Configuration transitions use a fresh native baseline with the final authored configuration, never edits to existing locks. The runner source pins and the single exact pipeline allowance are reviewed again for their changed contents.

### Gate headroom

The serial Buildkite gate step previously had a 25-minute cap (1,500 seconds). The measured prior local baseline/check/shared-gate chain was 113.780 + 1,466.043 + 239.2 = 1,819.023 seconds, already above that cap; Buildkite #592 itself took 24m16s overall. The approved anticipation/headroom route raises only that gate step to 45 minutes (2,700 seconds), 48.4% above the measured local chain, before adding the review regressions. Per-command test-gate caps remain 240 seconds and the shared-gate budget remains 600 seconds; observed individual suites remain well below those limits. Every other CI step retains its old timeout. Exact shape checks assert the one changed timeout. The path/hash allowance is refreshed only for this reviewed pipeline content; there is no separate refresh writer in docs/gate.md or scripts/gate.py. Long native checks run in the background, with separately observed completion rather than a tool-call timeout killing them.

### Integration with the main negative-control inventory

After the no-fast-forward main integration, the inherited model inventory test correctly failed on the unmutated head: these three models were not yet registered. The existing test supplied the red before the integration repair. Register every safe checked invariant in config/model-negative-controls.v1.json without changing the checker, tests or historical allowlist. Explicit unsafe controls expose an impossible lease generation, original-evidence erasure and stale-head host admission, alongside the existing unsafe controls. Safe state spaces remain 72, 6 and 68 states. Mark deliberately failing reachability configurations with the unsafe filename convention so the common runner never mistakes them for safe configurations; their four intended counterexamples are still checked separately. TLC-merged-inventory.txt records the observed sanitized results. All 115 combined native mutation contracts remain unchanged.
