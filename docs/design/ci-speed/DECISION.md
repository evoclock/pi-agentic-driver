# CI speed: parallel checks, private test state

## Measured priority

The initial unchanged-production baseline at `402521552097dc96a06607f5e1e91e040926cca1`
was 1,446.83 seconds for the inherited mutation gate. Its 61 unmutated commands
used 377.36 seconds and its 118 planted-fault commands used 998.479 seconds.
The registered TLC inventory used only 31.818 seconds. These are local wall
measurements, not Buildkite results. The baseline's clean-tree test-gate was a
no-op, not a substitute for the mutation-bearing measurement.

Parallelize independent contracts first. The later implementation steer also
requests Node and TLC startup reuse, but not across unknown test state. The
bounded reuse below retains native checking and fails closed on incomplete or
misattributed results; it does not turn uncertain state into shared state.

## Choice and invariants

Options: serial execution, a bounded private-tree pool, a shared-tree pool,
misattributed completion, partial proof, and hold. Select the private-tree pool:

- Each unmutated suite and each planted fault gets a new archive/overlay tree.
  Even `scriptEnv` controls run against private copies, not the source checkout.
- Each materialized tree has private Git worktree/index/refs, with the source
  commit and verified base available locally. Immutable Git objects and installed
  dependencies are shared read-only by convention; their stores are not an OS
  sandbox. Git-dependent suites can inspect their own repository without falling
  through to the source checkout. No Node worker is reused across mutants.
- At most four commands run at once, further bounded by available cores.
  `PAD_TEST_GATE_WORKERS=1` retains a serial comparison mode; only 1–4 are valid.
  Nested fixture runners use one worker to prevent multiplicative pools.
- Deduplicate only equivalent passing unmutated commands, as before. Every
  contract still runs its exact planted fault with the original timeout, count
  limit, and failure/error validation. No new short-circuit exempts any contract.
- Join the pool before returning; publish whole command/output/evidence blocks
  in registry order, not completion order. Bind each mutant to its contract ID,
  target path, exact content digest, exit code, and private execution tree.
- Evidence appenders use a cooperative OS file lock and flush before closing,
  so separate current runner processes serialize JSONL records. Batch output is
  published by its caller after joining its workers.
- Private commands clear inherited Git directory/index/object overrides and
  set a Git discovery ceiling at the scratch container. A fixture may use its
  own repository, but cannot accidentally discover the shared parent checkout.
  This is not an OS filesystem sandbox against deliberately hostile test code.
- Private materialization removes deleted base files and preserves current file
  bytes and executable modes. Changed linked/non-file inputs are blocked rather
  than silently restoring stale regular files in an unmutated head or mutant.
- Source-checkout guards remain, and pre-existing private-tree inputs are hashed
  before and after each command. Private `.git` metadata may change, but source
  and test bytes stay protected. A suite rewriting those inputs is blocked,
  rather than counted as a caught mutant.

`MutationPool.tla` is a finite scheduler abstraction: three contracts, at most
two active jobs, no fairness or wall-time claim. It assumes child-process
execution and host hash/exit collection work as specified; it is not a proof
of filesystem sandboxing, JavaScript isolation, or correspondence of all code.
Pool, serial and hold configs pass TLC. Shared-tree, misattribution and partial
proof controls exit 12 on `OwnTree`, `Attribution`, and `CompleteProof`
respectively. All negative configs are in the existing registry. Hold is safe
but makes no progress. Shared-tree and partial-proof shortcuts are rejected.

The enforcing checks are `tests/test_mutation_pool.py`, the inherited read-only
runner fixtures, and focused attribution/concurrency mutations. Tests were
committed before implementation. The native fail-first runner observed five
pool and four install assertion failures on base, with zero errors.

## Affected-only PR policy, with full-proof overrides

The later measured-priority steer permits affected-only mutation checks on PRs.
`make test-gate TEST_GATE_MUTATIONS=affected` selects contracts whose production
target appears in the diff against the verified main ancestor (the merge base
when the required main integration is current). Changes to any tests, contract
files, gate/runner machinery, or an unmapped file force the full registry.
Proof-tree detection covers helpers, fixtures and liveness files even when
filenames lack `test_`. Review/gate tools and model-fidelity helpers select full
mode as proof machinery. Discovery conformance exercises every registered suite
and explicit near-miss paths. Selection and its reason/counts are in the result.
No graph inference is used:
uncertain mappings select everything. This PR edits proof inputs and therefore
runs **all** contracts even in affected mode.

The portable schedule declaration is `.buildkite/nightly-schedule.json` (03:00
UTC daily on main). Repository YAML cannot create a Buildkite service schedule.
Apply that declaration through the authenticated Buildkite schedules API when
rolling out the merged change. The local schedule API attempt had no configured
Buildkite credentials, so service-side scheduling is **not yet installed**.

Default `all` mode executes every contract even on clean main. Buildkite uses
that mode for scheduled, non-PR and tag builds. Normal PR jobs request affected
mode, but cannot override the proof-input rule. Node suites, make gate, and
registered safe/negative TLC checks still run on every PR. The release checklist
requires a green full run for the exact candidate before every release tag;
a nightly result for another SHA cannot stand in for it.

`MutationSelection.tla` enumerates target/test/gate/unknown/clean observations.
The selected affected and full options pass; skipping proof-input overrides,
skipping unknowns, and widening a mapped-only subset are planted negative
choices. The model abstracts the path classifier, not Git correctness or
release enforcement outside the documented checklist. Executable conformance
covers exact subsets, all fail-safe overrides, a caught selected fault, and a
clean-main full run.

## Bounded startup reuse

Explicit multi-file mutation commands may group a small, closed pure JavaScript
subset with native `--experimental-test-isolation=none`. The AST classifier
checks local dependencies, imported binding identity and an explicit native API
allowlist. Unknown APIs, mutable/global state, test-context effects, filesystem
access, preloads, duplicate real paths and unknown flags retain native process
isolation. There is no cross-mutant Node reuse. Native per-group counts, argv,
exit status and output digests are recorded separately and summed by the host;
count and timeout caps still apply to the whole contract. The canonical explicit
TAP reporter flag is preserved in each native execution partition. Each command and each
bootstrapped worker owns a cleaned temporary directory, including Java scratch.
The initial 159-file npm-test snapshot had **zero eligible files**: this conservative
fallback is intentional, not a claimed Node wall-time saving. Real pure-file
fixtures exercise grouping, unsafe fallback and planted assertion failures.

Registered TLC controls use one bounded JVM with a **fresh classloader and copied
model/config directory per check**. The binary protocol binds each ordered result
to its job ID, source/config digest, native child PID and exact exit status. The
existing named-invariant, single-property, reachability and repository-status
checks remain. Per-model deadlines abort the whole JVM; partial frames are not
successful evidence. Missing compiler modules, pre-Java-11 launchers and unknown
version probes retain fresh-JVM execution with the same per-job attribution and
an identified timeout error. Live native-check adapters exercise both capability
fallbacks; they do not certify every historical JDK. Full Java mutation conformance requires an installed JDK/compiler;
fallback operation is not proof that the unused Java backend caught a mutant.

TLC 2.19 needs explicit disk-queue `finishAll` after early invariant failure.
Its temporal counterexample code also leaves an unreachable idle JDK executor.
Only an executor waiting in JDK `getTask`, with no remaining TLC producer after
`process()` returns, may be retired; its model context loader is detached. Other
live model threads abort the batch. Retired executors are checked for renewed
activity before each model and terminated with the bounded batch JVM, not reused.
This is lifecycle containment, not OS sandboxing or a general proof of TLC internals.
Repeated module names, alternating source contents, invariant/temporal failures,
fresh-JVM comparisons, wrong identity/digest/PID, deadlines and named-control
mismatches are executable conformance in `tests/test_tlc_batch.mjs`. Its registered
control fixture owns a private Git repository so another concurrently running
spec cannot invalidate its repository-status observation.

`WorkerReuse.tla` abstracts namespace reset, attribution, quiescent publication
and complete proof. Fresh, isolated and hold choices satisfy its invariants;
no-reset, wrong-identity, active-publication and partial-proof choices violate
their named properties. It assumes the purity classifier and native checker
operate as specified; it does not prove JavaScript purity, JDK behavior, fairness,
resource bounds or filesystem isolation. Hold proves no progress.

## Buildkite environment recurrence checks

Buildkite #634 exposed three CI differences, reproduced before the repair:

- Python 3.14 inherits `FORCE_COLOR` and styles `FAILED` with ANSI SGR. The
  parser now normalizes display styling for counts while retaining raw output
  evidence. An actual Python 3.14.0 assertion red produced zero reported failures
  with the old parser and one with the corrected parser; admission is unchanged.
- An evaluator CLI fixture inherited agent HOME and correctly warned about legacy
  key-file presence. Its assertions and production credential policy stay intact;
  it saves/sets/restores HOME locally. Its test file also owns the real npm-stage
  integration regression with owned fake markers, never real keys: old production
  lacks the isolation helper and fails that assertion, while the corrected stage
  must execute npm, retain only its cache and checker data, and clean private HOME.
  The generic dependency-proof guard and admission rules are unchanged.
- Linux containment had no configured TLC jar: the mapped killing file ran but
  live checks skipped. Registry-wide conformance confirms every target retains
  its declared killing tests. Official mutation context now refuses skipped live
  Java proof. Pinned Temurin 25.0.1+8 and TLC 2.19/v1.7.4 data are prepared on the
  host using Socket Firewall downloads and checksum verification, then mounted
  read-only. No install scripts or network access are added inside containment.
  `config/ci-tlc-tools.v1.json` records versions, hashes, sources and licenses.
  Existing 2 GiB, two-CPU and 128-PID bounds remain; the pool observes cgroup CPU
  quota. Fresh checks explicitly select private writable Java temp directories.

Buildkite #638 exposed a separate checkout-shape mismatch: Git's trailing-slash
`node_modules/` ignore pattern excludes directories but not CI's read-only
`node_modules` symlink. That untracked dependency mount entered the changed-input
set; it was not a changed main-owned source or a dropped killing test. The ignore
entry now covers this already-managed dependency name in either representation.
The existing private-snapshot dependency mechanism handles the mount; no generic
linked-source acceptance or inherited-contract exclusion was added. A native Git
fixture advances main with a new contract, merges it without rewriting history,
adds the dependency link, then proves the unchanged main-only contract still
executes and catches its fault. An unmanaged source symlink still refuses private
materialization. This tests selection and materialization together, not just a
path-list assertion.

Buildkite #644 exposed installed PATH launchers that read only `TLA2TOOLS`, not
its supported `TLA2TOOLS_JAR` alias. A parent-only canonical variable survives the
private-HOME stage; alias-only configuration reproduced the exact missing-main-
class failure because the helper saw the alias and skipped canonical export.
The private-HOME boundary now exports that same existing jar under the canonical
name as well, without changing the parent or credential policy. A regression
executes the existing installed-TLC crash test with real Java/jar in canonical
and alias-only modes, verifies the named unsafe outcome and safe pass, and rejects
skipped proof. Its owned launcher has private Java temporary state rather than
sharing extracted standard modules with neighbouring checker processes.

Buildkite #647's log identifies the later full-npm phase, not the already-passed
shared gate, but does not expose the remote wrapper or its parent environment.
An alias-compatible owned launcher was therefore not sufficient evidence about
that wrapper. The strengthened regression selects the actual installed PATH
launcher when available, runs the existing model test with absolute canonical,
alias and valid parent-relative jar paths, and records only bounded launcher
lookup booleans (not script contents or environment dumps). Parent-relative
configuration reproduced the exact ClassNotFoundException with the real local
launcher when the test changed cwd. The boundary now resolves the selected jar
to an absolute path before HOME/cwd changes. This is a verified resource-identity
repair, not a claim that the uninspected remote wrapper used that configuration.
Where no PATH launcher is installed, the contained JDK/jar remains an actual
checker execution route rather than a skip or a checker-output stub.

Buildkite #649 supplied the missing real launcher contract: the CI `ci-bin/tlc`
reads `TLA2TOOLS_JAR`, not `TLA2TOOLS`. Its alias-mode test passed and the following
canonical-only mode failed with ClassNotFoundException. Read-only authenticated
job-log access provided that exact phase and bounded lookup diagnostic; no auth,
secret/environment read or service change was required. The child now exposes the
same selected absolute jar under BOTH supported names. Canonical-over-alias
selection remains unchanged, and a conflicting alias cannot select a different
checker. The regression exercises the real installed launcher plus the observed
alias-only contract, using actual Java/jar for every safe and named-unsafe check,
with absolute, relative, alias and precedence modes and no skipped proof.

Conformance lives in `tests/test_test_gate.py`, `tests/test_skill_usage_eval.mjs`,
`tests/test_ci_install.py`, selection and live TLC tests.
A real Linux amd64 reproduction under network-none, read-only root, unprivileged
UID, 2 GiB, two CPUs and 128 PIDs first passes the checker, then catches the exact
Java zero-exit mutant with an assertion failure and no skipped live case.
These pinned checker artifacts are development infrastructure, not npm runtime
packages or Buildkite service setting changes.

## Install once, copy privately

After integrating the native-proof split from main, native-proof, gate, durable
and types call `scripts/ci_install.py`. On each agent, an exclusive
OS file lock serializes first publication for a build, manifest/lockfile digest,
Node/platform/architecture/ABI and npm version. Both root and Janus installs
still use `sfw`, `ci`, and `--ignore-scripts --no-audit --no-fund`.

Publication is atomic and occurs only after both installs succeed and inputs
still match the key. Other jobs copy the completed modules, never link their
writable modules back into the publication. Different builds cannot reuse an
installation. npm's download cache can persist across builds, but is keyed by
both lockfiles/manifests/runtime and separated into PR/non-PR namespaces.
Agent caches are local performance data, never gate evidence or repository
content. They are not a security boundary against another process with the
same host account. Interrupted installs publish nothing; OS locks release on
process death. Build-local publications can be removed by normal agent-cache
retention after a build; this change introduces no cleanup daemon.

## Audited configuration transition

The pipeline retains main's separate native-proof step, bounded process-group
cleanup, check scope and job caps. Affected/full routing is in native-proof, not
a duplicate invocation in the shared gate; Make forwards the mode through the
supervised entry. It shares repeated install blocks, adds PR/full routing, and
adds the full Node suite and registered model checks to the gate job. Renew its exact hash-scoped
install allowance and add focused mutation contracts before the native baseline
in a fresh lease, preserving the original attempt. Never edit generated locks
or evidence. Refresh correctly rejected changes to locked configuration in the
original attempt. Use the documented configuration-before-lock transition in
`docs/design/test-gate-freshness/DECISION.md`, not a weakened refresh rule.
Both shared-runner pins are updated to the exact new source hash; no private
containment pin is exported. All blocked results remain in the original lease.

Inspired by Vincent's “Load the tool once. Reset the test every time” CI-cost
article, supplied with the assignment. No external implementation was copied.
