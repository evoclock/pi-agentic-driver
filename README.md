# pi-agentic-driver

Evidence-oriented extensions for [Pi](https://github.com/earendil-works/pi-coding-agent):
advisory code review, bounded role communication, and governed isolation proofs
for agentic workflows.

**Status: active development and testing.** The extensions below are at
different stages of qualification — each ships only after passing
fixture-based acceptance (native tests, live-session checks, and independent
model review). Released components are installable; pending ones are listed
for transparency and are not yet packaged.

## Released (0.1.1)

### code-phage — advisory code review

`code_phage` reviews a proposed change against a stated goal before code is
written or committed. Given a goal, candidate files, accepted requirements,
and test paths, it:

- **Finds prior art structurally** — matches exported symbols, function
  signatures, and dependency imports against a repository inventory, so an
  agent reuses an existing abstraction instead of writing a parallel version.
  Word overlap alone never counts; credit (source, version, license) is
  required whenever prior art informs the implementation.
- **Binds an implementation budget** — goal, accepted requirements, write
  set, and tests become one reviewable budget, with coverage checks that
  flag unbound requirements and uncovered tests.
- **Measures diagnostic signals** — per-function cognitive and cyclomatic
  complexity, line counts, duplication, module-level mutable state,
  dependency lists, test burden, and a rollback proxy. These are signals
  for human judgment, never rejection thresholds.
- **Redirects scope drift** — files that support no accepted requirement are
  named, excluded, and the smallest coherent write set is recommended; the
  deletion test ("what fails if this is removed?") guards justified
  complexity from false-positive flagging.
- **Stays advisory** — it never mutates files, creates tasks, grants
  authority, or blocks work; every result states `advisoryOnly: true`.

Concept credit: Matty Stratton, "Cognitive Complexity" (2024-09-20, concept
only, no code copied); `flake8-cognitive-complexity` 0.1.0, MIT (concept
only, not a runtime dependency).

### herdr-communication — bounded role communication

`agentic_herdr_communication` exchanges bounded, marked reports with
configured Pi worker roles running under [Herdr](https://github.com/herdr)
0.7.5. Each operation:

- **Lists and observes** worker roles (`list`, `get`) filtered to trusted
  repositories only — a checked-in registry plus canonical-path validation;
  unlisted or symlink-escaped repositories are denied.
- **Prompts exactly once** (`prompt`): re-observes the role, sends one
  bounded prompt with a role-specific report contract, waits for terminal
  settlement (`idle`/`done`/`blocked`), and reads exactly one latest
  complete marked report. No retry, no target substitution, no resend on
  timeout.
- **Waits and reads** (`wait`, `read`) with the same trust checks for
  partial journeys.
- **Grants nothing** — fixed argv with `shell: false`, a pinned executable,
  the coordinator role class denied, and results that are untrusted
  evidence (`nonAuthorizing: true`). It cannot control panes, start agents,
  run shells, or create authority.

## In development and testing

These capabilities exist in the development tree and are working through
qualification. Release of each is pending completed tests and review:

- **container-isolation proof** — a parameter-free, natively confirmed
  probe that a pinned local Podman image runs with `--network none`, a
  read-only workspace mount, no privilege/PID/socket surface, mechanically
  enforced no-pull (`--pull=never`), and verified container teardown.
  Planning, argv construction, and the receipt come from one audited
  planner; the adapter is orchestration only.
- **microVM-isolation proof** — a transient, diskless, network-less
  QEMU/KVM guest on a fixed remote backend: BusyBox initramfs built
  per-run and hash-bound, `virsh create` with destroy-on-exit, exact ACL
  restoration on every success and failure path, and a checked
  domain-absence proof. Evidence is one structured receipt, never
  self-attested strings.
- **git workflow safeguards** — exact-file staging with semantic
  derivation, native confirmation, post-confirmation drift revalidation,
  and protected-operation boundaries (no force push, no default-branch
  deletion, no history rewrite), while routine status/diff/stage/commit
  stays low-friction. Arbitrary wall-clock truncation of healthy
  operations is being removed.
- **context-pressure handling** — pressure detection, non-lossy handover,
  compaction completion without cancellation loops, and continuation of
  the latest user goal. Development-only until the full live journey
  passes.

## Planned

The wider capability set, each item shipping individually as its scenario
passes acceptance:

- **ordinary-work mode routing** — a work-mode contract (`ad-hoc`,
  `planned`, `restricted`) that keeps routine read/edit/test work free of
  lifecycle ceremony while consequential operations stay behind native
  confirmation.
- **handover, checkpoint, and recovery** — durable repository-local
  handover notes, governed checkpoint mutation, watchdog handoff, and
  fresh-session resumption that identifies goal, changed files, checks,
  and next step without executing anything.
- **attended-authority guard parity** — one destructive-operation policy
  enforced identically across Pi, Claude Code, and Hermes hosts, in TUI
  and headless contexts, with progress after denial and no
  false-positive stops on safe work.
- **prompted planning lifecycle** — natural-language goals derived into
  complete semantic proposals with parent/scope choices at native
  boundaries; no retry loops, no model-supplied identifiers.
- **project status and state review** — read-only projections of workspace
  Git state, formal records, and task-state health (`/agentic-status`
  family).
- **board cutover and card-author compatibility** — fixed-scope migration
  between planning boards with legacy card compatibility, exact write
  sets, and rollback facts.
- **evidence ledger** — deterministic evidence indexing, lossless source
  projection, universal checkpoint produce/store/recover, and run-ledger
  records with crash and corruption vectors tested.
- **synthetic dispatch family** — run-ledger cutover, autonomous Git
  delivery, interactive envelope, dispatch lifecycle, and managed-worker
  proofs exercised strictly in synthetic namespaces with private remotes;
  no live activation.
- **inventory refresh** — Git-aware codebase inventory regeneration with
  verification receipts, so prior-art matching stays honest.
- **extension-registration and profile isolation** — loader registration
  inventories, digest comparison, and strict config/session/cache/log/
  extension separation between usable and development profiles.

Each lands here when its scenario passes with all prohibited effects
absent.

## Install

```sh
pi install <tarball-or-npm-package>
```

Released extensions load standalone; neither requires the other.

## License

AGPL-3.0-or-later with author-attribution additional terms (Section 7(b));
see [LICENSE](LICENSE). A commercial licence is available on request.
