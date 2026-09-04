# pi-agentic-driver

An agent left unsupervised will happily rewrite what it should have reused,
ship to the wrong remote, lose its context at the worst moment, and report
success in words you cannot verify. Pi is an excellent agent harness; the
pieces I need for the way I work are the guardrails around it.

**pi-agentic-driver adds those guardrails as Pi extensions, and every one of
them obeys the same rule: the agent does the work, the extension makes the
work verifiable and bounded.** Review happens before code is written;
communication carries reports, never authority; automation runs inside
isolated proofs that prove their own cleanup; sessions survive compaction
and handover; and Git operations stay exact, confirmed, and protected.

Everything here is built the way it asks agents to work: every capability
passes fixture-based acceptance with native tests, live-session checks, and
independent model review before it ships, and each extension's own
restrictions are documented, not discovered.

Extensions for [Pi](https://github.com/earendil-works/pi-coding-agent):
advisory code review, bounded role communication, and governed isolation
proofs for agentic workflows.

**Status: active development and testing.** Each extension ships only after
passing fixture-based acceptance (native tests, live-session checks, and
independent model review). Released components are installable; pending
ones are listed for transparency and are not yet packaged.

## Keeping work bounded

*Extensions that review, route, and bound what an agent does.*

### code-phage — advisory code review *(released, 0.1.1)*

`code_phage` like a bacteriophage but for your code, it reviews a proposed change against a stated goal before code is
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

**Under development in this theme:**

- **work-mode routing** — an `ad-hoc` / `planned` / `restricted` contract
  that keeps routine read/edit/test work free of lifecycle ceremony while
  consequential operations stay behind native confirmation.
- **prompted planning lifecycle** — natural-language goals derived into
  complete semantic proposals with parent/scope choices at native
  boundaries; no retry loops, no model-supplied identifiers.
- **native assignment selection** — planned assignments chosen through a
  native UI over derived candidates, never by model-supplied targets.
- **inventory refresh** — Git-aware codebase inventory regeneration with
  verification receipts, so prior-art matching stays honest.

## Communicating without granting authority

*Extensions for bounded coordination between agents and boards.*

### herdr-communication — bounded role communication *(released, 0.1.1)*

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

- **Scales to many workers** — the trusted registry accepts up to 32
  worker repositories, and any dynamic non-coordinator role within them
  is eligible; `list` observes every live agent in one call. Fan-out is
  sequential by design: one role per prompt, one complete exchange, no
  broadcast primitive.
- **Agent/pane lifecycle (in development)** — from a session, in natural
  language: "spawn an agent in a split pane to the right, make it an
  implementer, set the model to X." Creates panes with directional splits,
  spawns agents into roles, assigns model and working directory at spawn
  time, and verifies what was created, trusted repositories only, the
  coordinator class reserved, no shell or credential surface. Not part of
  the released 0.1.1 tool; ships when its own qualification passes.

**Under development in this theme:**

- **project status and state review** — read-only projections of workspace
  Git state, formal records, and task-state health (`/agentic-status`
  family).
- **role-lane routing and warm sessions** — smart model routing: work is
  routed to the right model for the job, implementation, planning, and
  review run as separate declared lanes, preferring warm sessions where
  the lane already has an established agent, so context and cache survive
  across tasks. Route affinity is an optimisation, never authority: an
  incompatible or unavailable lane yields an explicit review-required
  result, never silent model substitution. Dispatch and shell authority
  are not granted by routing.
- **worker pulse** — liveness observation and dispatch-eligibility
  observation across role lanes: which agents are alive, what state they
  are in, and what is ready for work. Non-authorizing observation; planned
  work cannot be dispatched without it.
- **task-ledger integration for planned work** — agents read and act
  within the task ledger's card states (what is dispatchable, in progress,
  blocked) without owning board authority: no admission, completion,
  reconciliation, or migration by the agent itself.

## Executing in isolation

*Extensions that prove automation ran — and stopped — exactly as declared.*

**In development:**

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

**Under development in this theme:**

- **attended-authority guard** — the safety net between an agent and your
  shell: when a model tries to delete, overwrite, or push, the guard
  stops it before execution and asks you. Safe commands (reads, builds,
  tests) pass through untouched. If you deny, you get a clear reason and
  the session continues, the agent does not retry behind your back. In
  headless runs where no human can confirm, destructive commands are
  refused outright rather than silently allowed.

## Managing context pressure, compaction, and avoiding lossy handover

*Extensions for session continuity when context runs out or a session ends.*

**In development:**

- **context-pressure handling** — pressure detection, non-lossy handover,
  compaction completion without cancellation loops, and continuation of
  the latest user goal. Development-only until the full live journey
  passes.
- **lossless session-reference compaction** — selective, lossless retrieval
  of exact pre-compaction content, addressing factual degradation across
  repeated compactions; designed as an optional add-on, not yet
  implemented.

**Planned in this theme:**

- **handover, checkpoint, and recovery** — durable repository-local
  handover notes, governed checkpoint mutation, watchdog handoff, and
  fresh-session resumption that identifies goal, changed files, checks,
  and next step without executing anything.
- **evidence ledger** — deterministic evidence indexing, lossless source
  projection, universal checkpoint produce/store/recover, and run-ledger
  records with crash and corruption vectors tested.
- **offline multihost evidence** — record run evidence on each host while
  disconnected and reconcile it deterministically on reconnection, with no
  host as sole authority.

## Working with Git safely

*Extensions that keep routine Git low-friction and consequential Git guarded.*

**In development:**

- **git workflow safeguards** — exact-file staging with semantic
  derivation, native confirmation, post-confirmation drift revalidation,
  and protected-operation boundaries (no force push, no default-branch
  deletion, no history rewrite), while routine status/diff/stage/commit
  stays low-friction. Arbitrary wall-clock truncation of healthy
  operations is being removed.
- **assignment-aware Git journeys** — merge and protected-push flows bound
  to a verified assignment, so consequential Git operations carry their
  own recorded provenance.

## Trust in the extension set itself

*Extensions that keep the installed set honest and the record bounded.*

- **security and integrity scanning** — static scanning of MCP configs,
  agent skills, and extension packages for hardcoded secrets, prompt and
  shell injection, data-exfiltration endpoints, untrusted integrations,
  PII leakage, and OWASP/MCP threat families, with accept/redact/reject
  decisions. Built on the agent-scanner approach proven in
  Hillstar Orchestrator and Testudo.
- **checkpoint storage lifecycle** — compression, deduplication, retention,
  and purging rules for capsule/index stores once a product ships, so
  session evidence has a managed lifetime instead of growing without
  bound.
- **product knowledge graph** — semantic graph projection of a shipped
  product's checkpoints, decisions, and artifacts, so the record of what
  was built stays queryable after active development ends.

Each item lands here as its own extension when its scenario passes
acceptance with all prohibited effects absent.

## Install

```sh
pi install <tarball-or-npm-package>
```

Released extensions load standalone; neither requires the other.

## License

AGPL-3.0-or-later with author-attribution additional terms (Section 7(b));
see [LICENSE](LICENSE). A commercial licence is available on request.
