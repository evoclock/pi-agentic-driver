# pi-agentic-driver

<p align="center">
  <img src="assets/Yamagane-origami.png" alt="pi-agentic-driver, Yamagane origami mark" width="140"/>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL%20v3-blue?style=flat" alt="License: AGPL v3"/></a>
  <a href="https://www.npmjs.com/package/@evoclock/pi-agentic-driver"><img src="https://img.shields.io/npm/v/@evoclock/pi-agentic-driver?style=flat" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/status-active%20development%20%26%20testing-orange?style=flat" alt="Status"/>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black" alt="JavaScript"/>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white" alt="Python"/>
</p>

An agent without guardrails will rewrite code an existing abstraction already
covers. It will ship to the wrong remote. It will lose context and report
success without evidence. Pi is deliberately lean by design: the harness is yours to
shape. That philosophy is exactly what these extensions practice, they make them mine (and possibly yours too). They take
some concerns I consider worth addressing, and make them part of the
harness.

**pi-agentic-driver makes agent work verifiable and controllable. The agent does
the work and each extension makes sure the work can be checked.** Review happens
before code is written. Communication carries reports without asserting authority that isn't granted.
Isolation proofs verify their own cleanup. Sessions survive compaction and
Git operations stay exact, confirmed, and protected.

Every capability passes fixture-based acceptance, native tests, live-session
checks, and independent model review before release. I/we document each
extension's restrictions before release, not after.

Extensions for [Pi](https://github.com/earendil-works/pi-coding-agent):
advisory code review, controlled role communication, and governed isolation
proofs for agentic workflows.

<p align="center">
  <img src="assets/agentic-driver-full-color.gif" alt="Full-color Agentic Driver control vault" width="768">
</p>

## Shipped features

| Tool | What it does | Status |
|------|--------------|--------|
| `code_phage` | Reviews a plan against a stated goal before code is written and advises your agent. | shipped |
| `tasks` | Keeps a session plan close to the work, then lets the owner make selected items durable in `TASKS.md`. | shipped |
| `agentic_herdr_communication` | Exchanges marked reports with worker agents; never grants authority. | shipped |
| `agentic_herdr_spawn_worker` | Starts one Pi worker in a pane or tab, with native confirmation. | shipped |
| `agentic_aidr` | A remedy for AI;DR. Reviews writing for clarity, simplicity, brevity, and humanity. | shipped |
| `agentic_linux_microvm_cutover` | Runs one job in a throwaway QEMU/KVM virtual machine on a Linux host, with a severity-tiered killswitch that stops escape attempts. | user-enabled, native confirmation |
| `agentic_worker_dispatch` | Runs controlled worker journeys and observes worker liveness. | shipped |
| `agentic_kanban_board` | Shows the workspace task board: lanes, flags, priorities, dependencies, and which cards can run. | shipped |
| `agentic_kanban_board_write` | Adds cards to the board through the trusted writer, which records who authorized the work. | shipped |
| `agentic_kanban_board_update` | Moves, closes, flags, edits, or removes cards on the board, always recording who authorized the change. | shipped |
| `agentic_kanban_board_dispatch` | Claims an eligible board card for automated contained work and creates its assignment envelope. | shipped |
| `agentic_kanban_pulse` | Checks for ready work and available capacity, then starts assignments under the board policy. | shipped |
| Router | Capacity/policy routing for Board Pulse: seats with scope statements, tunable policy values, and a binding dispatch gate. | shipped |
| Janus (bundled service) | Local Jev evaluation service on loopback: semantic ranking, the dispatch-gate judgment, redaction before every external call. See `janus/README.md`. | shipped |

**Status: active development and testing.** Each extension ships only after
it passes fixture-based acceptance, native tests, live-session checks, and
independent model review. You can install released components. Pending
components are listed here for transparency and are not packaged.

## Code review and planning

*Extensions that review, route, and control what an agent does.*

<details>
<summary><strong>code-phage, advisory code review</strong> <em>(released, 0.1.1)</em></summary>

The `code_phage` tool reviews a proposed change against a stated goal before the agent
writes or commits code. Give it a goal, candidate files, accepted
requirements, and test paths. It will:

- **Find prior art structurally.** It matches exported symbols, function
  signatures, and dependency imports against a repository inventory, so the
  agent reuses an existing abstraction instead of writing a parallel version.
  Word overlap alone never counts. When prior art informs the result, the
  implementation records its source, version, and license.
- **Bind an implementation budget.** Goal, requirements, write set, and tests
  become one reviewable budget. Coverage checks flag requirements nothing
  binds and tests nothing covers.
- **Measure diagnostic signals.** Cognitive and cyclomatic complexity, line
  counts, duplication, module-level mutable state, dependencies, test burden.
  These are signals for human judgment, never rejection thresholds.
- **Redirect scope drift.** It names the files that support no accepted
  requirement and recommends the smallest coherent write set. The deletion
  test guards justified complexity: what would fail if we removed this?
- **Stay advisory.** It never mutates files, creates tasks, grants authority,
  or blocks work. Every result says `advisoryOnly: true`.

Concept credit: Matty Stratton, "Cognitive Complexity" (2024-09-20, concept
only, no code copied); `flake8-cognitive-complexity` 0.1.0, MIT (concept
only, not a runtime dependency).

</details>

<details>
<summary><strong>tasks, from session plan to durable work</strong> <em>(shipped)</em></summary>

Plans stay close to the work. They do not become board work by accident. The tasks skill gives Pi a familiar session list. It adds an owner-approved way to keep selected tasks in the durable `TASKS.md` board.

- **Keep the working list simple.** Use `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate` as usual; the above-editor widget and footer pill stay live as tasks change.
- **Keep the Claude-like view.** `/tasks` provides descriptions, active forms, and internal-task markers without mutating the plan.
- **Make durable work deliberate.** `TaskPromote` never runs automatically. It previews the exact cards and destination before the owner confirms.
- **Keep authority clear.** The trusted board writer creates and updates `TASKS.md`. The skill does not bypass it.
- **Make migration gentle.** Existing task files remain readable. Moving to the driver-owned skill does not strand current plans.

The result is a clean handoff from a session plan to durable work. Selected tasks can survive the session, appear on the shared board, and become available for controlled dispatch when ready.

</details>

**Available now:**

- **task-ledger integration.** Agents can read and act within board card
  states while the trusted writer retains authority over admission,
  completion, reconciliation, and migration. The Tasks skill also bridges
  session planning to the durable `TASKS.md` board.
- **role and phase routing.** The router separates planning, implementation,
  review, and escalation phases. It reports endpoint warm state when
  configured. Warm-session preference remains future work; route affinity
  never overrides authority.

**Planned in this theme:**

- **prompted planning lifecycle.** Turn natural-language goals into complete
  proposals with parent and scope choices at native boundaries. No retry
  loops or model-supplied identifiers.
- **native assignment selection.** Choose planned assignments through a
  native UI over derived candidates, never through model-supplied targets.
- **inventory refresh.** Regenerate the Git-aware codebase inventory with
  verification receipts so prior-art matching stays honest.
- **project status and state review.** Add read-only views of workspace Git
  state, formal records, and task-state health.

<details>
<summary><strong>router, capacity/policy routing with a binding dispatch gate</strong> <em>(released, 0.9.2)</em></summary>

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
coalesces identical requests. See `janus/README.md` for the endpoint
contract, Keychain provisioning, and configuration.

- **Repository defaults** ship at `.agentic-driver/router.defaults.json`. The
template contains no accounts and one disabled placeholder seat, so it loads
out of the box and schedules nothing until you enable a real seat.
- **User profile (precedence over defaults):**
`~/.config/agentic-driver/router/profile.json`, or the path in the
`AGENTIC_DRIVER_ROUTER_PROFILE` environment variable. A profile section
replaces the matching defaults section wholesale; the merged config must
validate or the router refuses to produce decisions (fails closed).
- **Operational state:** `~/.local/share/agentic-driver/router/state.db`, or
`AGENTIC_DRIVER_ROUTER_DB`. This store is operational state only. The
authenticated claims file and the board writer remain the only dispatch
authority; the system repairs SQLite from them, never the reverse.
- **Runtime requirement:** the operational store uses the built-in
`node:sqlite` module. You need Node.js 22.5 or newer.

<details>
<summary><strong>Tunable configuration values</strong> <em>(all keys required, defaults are conservative starting values)</em></summary>

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

</details>

</details>

<details>
<summary><strong>Janus, local Jev evaluation service</strong> <em>(shipped)</em></summary>

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
npm install
```

```sh
npx tsx janus/server.ts
```

For a persistent setup, use the launchd template at
`janus/user.janus.plist`. Provision the TypeSafe Direct key once in the
Keychain. The command is in `janus/README.md`.

**When Janus is down:** semantic ranking falls back to preference order. The
binding dispatch gate blocks dispatch and fails closed. Janus never becomes a
silent dependency: its absence is loud.

See `janus/README.md` for the full endpoint contract, the error taxonomy, and
configuration.

</details>

## Multi-agent communication

*Extensions for controlled coordination between agents.*

<details>
<summary><strong>herdr-communication, controlled role communication</strong> <em>(released, 0.2.1)</em></summary>

The `agentic_herdr_communication` tool exchanges controlled, marked reports with
configured Pi worker roles running under [Herdr](https://herdr.dev/) (validated
against Herdr 0.9.1; the trust seam accepts the Homebrew-managed herdr binary
across versions rather than pinning one).

- **List and observe.** Worker roles are filtered to trusted repositories: a
  checked-in registry plus canonical-path validation. Unlisted or
  symlink-escaped repositories are denied.
- **Prompt exactly once.** The tool re-observes the role, sends one approved
  prompt with a role-specific report contract, waits for terminal settlement,
  and reads exactly one complete marked report. No retry, no target
  substitution, no resend on timeout.
- **Wait and read.** The same trust checks apply to partial journeys.
- **Grant nothing.** Fixed argv, `shell: false`, a pinned executable, the
  coordinator role class denied. Results come back as untrusted evidence. The
  tool cannot control panes, start agents, run shells, or create authority.
- **Scale to many workers.** The trusted registry accepts up to 32 worker
  repositories, and any dynamic non-coordinator role within them is eligible.
  Fan-out is sequential by design: one role per prompt, one complete
  exchange, no broadcast primitive.

</details>

<details>
<summary><strong>herdr-lifecycle, role-labelled worker dispatch</strong> <em>(released, 0.2.1)</em></summary>

The `agentic_herdr_spawn_worker` tool turns one natural-language request into Herdr's
native lifecycle. Choose a placement (`right`, `below`, or `tab`), a safe role
label, a model from the active Pi model roster, and a trusted repository. The
extension:

- creates the split pane or labelled tab;
- starts exactly one Pi agent in it;
- verifies the role, model arguments, pane identity, and canonical repository;
- requires native confirmation before changing layout or starting a process;
- uses fixed argv with `shell: false` and no arbitrary Herdr or shell surface;
- returns explicit `pane_created`, `tab_created`, or `agent_started` partial
  states when only part of the operation succeeds; and
- never retries, moves, closes, or deletes created state automatically.

![A role-labelled worker spawned in a right-hand pane](assets/spawn-right-pane.png)

The same request can place a worker below the coordinator or keep it in an
individual tab:

<p>
  <img src="assets/spawn-below-pane.png" alt="A role-labelled worker spawned below the coordinator" width="49%">
  <img src="assets/spawn-worker-tab.png" alt="A role-labelled worker spawned in an individual tab" width="49%">
</p>

See [Dispatching a Multi-Model Workforce from Anywhere](https://evoclock.github.io/fieldnotes/articles/herdr-natural-language-agent-automation.html)
for the wider task and model-routing workflow.

</details>

<details>
<summary><strong>herdr-dispatch, continuous worker journeys</strong> <em>(released, 0.5.0)</em></summary>

The `agentic_worker_dispatch` tool runs controlled worker journeys and observes worker
liveness. Two actions:

- **pulse** reports whether a worker role is alive, its current state, and
  whether it is dispatch-eligible.
- **dispatch** runs one journey. The worker works through the existing task
  sequence, one prompt-and-report exchange per task, at most `maxSteps`
  steps (default 50, cap 200).

Continuous mode is the default: the journey keeps going until the worker
finishes the queue or reaches the step bound. Turn-by-turn mode stops after
each step and is explicit opt-in. Each journey emits one collated marked
report covering every step.

A worker that never reaches idle across the observed exchange cycle ends the
journey with an explicit unresponsive state. You can then spawn a replacement
through the guarded lifecycle boundary. The replacement resumes the same
pending tasks, reuses existing task cards, and never duplicates them. The
stuck exchange is never resent to the same worker.

Journeys never create, own, or complete task cards themselves, never retry
silently, and return results as untrusted evidence.

</details>


<details>
<summary><strong>task board and Pulse, planned and automated work you can see</strong> <em>(released, 0.9.1)</em></summary>

Keep planned work in canonical `TASKS.md`. You can read it directly or use
the generated `board.md` view in Obsidian. Agents use the same canonical
record through natural-language board tools.

You can tell an agent to add, edit, move, block, propose, close, or remove a
card. The trusted writer assigns its ID, checks its fields, records your
instruction, and protects its dispatch provenance.

Agents cannot invent additional work or complete a card on their own. An
agent report is evidence for your review. Only your clear instruction or
direct board action completes the card.

For automated work, you set an explicit policy for the board. It defines:

- allowed roles and repositories;
- contained placement;
- the maximum concurrent work;
- the policy expiry; and
- the risk ceiling.

Without a valid policy, automated dispatch is refused.

The `agentic_kanban_board_dispatch` tool claims the highest-priority eligible card. It
creates a single-attempt assignment envelope that binds the card, repository,
starting revision, assigned branch, allowed paths, stopping point, expiry, and
interaction profile.

Blocked, altered, expired, reused, or unauthorized assignments fail closed.
The journey validates the authenticated envelope before each consequential
step. It runs on the assigned branch and consumes the envelope when the
attempt ends.

Consuming an envelope releases the claim. It does not mark the card done.

Claims and envelopes are kept in authenticated state beside `TASKS.md`. The
derived `board.md` view shows active claims but never becomes an authority
source.

The `agentic_kanban_pulse` tool checks the board for ready work and available capacity.
A check only reports which work is ready to run. It does not claim cards.

Interactive host work needs explicit policy and one native confirmation for
the batch. Automated work requires containment and never falls back to the
host.

Coming next:

- contained Pulse execution through Testudo;
- Vogelkop support for the shared card fields; and
- our own Obsidian plugin for canonical `TASKS.md`.

</details>

- **project status and state review.** Read-only projections of workspace Git
  state, formal records, and task-state health.
- **role-lane routing and warm sessions.** Separate lanes handle
  implementation, planning, and review, and the router prefers a warm session
  so context and cache survive across tasks. Route affinity is an
  optimisation, never authority: an incompatible lane yields an explicit
  review-required result, never silent model substitution.
- **task-ledger integration.** Agents read and act within the task ledger's
  card states without owning board authority: no admission, completion,
  reconciliation, or migration by the agent itself.

## Writing clearly

*AI;DR (AI; Didn't Read) keeps technical writing clear without flattening the
writer's voice.*

<details>
<summary><strong>AI;DR, writing review</strong> <em>(released, 0.4.2)</em></summary>

The `agentic_aidr` tool reviews the last assistant response, supplied prose, or a
Markdown file. It checks four principles:

- **Clarity.** Each sentence carries one useful idea.
- **Simplicity.** Clutter, pompous phrases, and needless jargon go.
- **Brevity.** Fewer words when they carry the same meaning.
- **Humanity.** An authentic human voice stays.

The `simple` and `ste` modes add an ASD-STE100-informed profile: sentence
length, direct word choice, precise verbs, and clear requirements,
permissions, abilities, and conditions. It targets 20 words per procedural
sentence and 25 per descriptive one, and returns the rule and an example for
each finding.

The profile is advisory. It does not include the licensed ASD-STE100
approved-word dictionary and does not certify conformance. Check final text
against the licensed specification and your project terminology list.

AI;DR also flags dense paragraphs, suggests bullets when they reduce working
memory load, and supports plain-language and analogy modes. Review is
read-only. An explicit file apply action shows a git diff and writes the
exact replacement only after native confirmation. Release 0.4.2 adds controlled
inputs, atomic replacement, drift checks, and exact write verification.

</details>

## Sandboxed execution

*Extensions that run agent jobs in a sealed environment and prove it.*

**Available in this release:**

<details>
<summary><strong>microVM isolation</strong> <em>(user-enabled, native confirmation)</em></summary>

The `agentic_linux_microvm_cutover` tool runs a single job inside a throwaway
QEMU/KVM virtual machine on a Linux host. The job cannot reach the host, the
network, or anything else outside the machine. The system deletes the machine
after the job ends.

Isolation is off at the start of every session. Use the `/agentic-isolation-enable`
command in the Pi TUI, and confirm. The model cannot run
that command. Every cutover run asks for its own confirmation too. Nothing is
saved to settings, and headless sessions stay blocked.

### You choose the machine

The model can only relay your words. Saving a target, or running on one,
always requires your confirmation dialog first.

1. Tell the agent where to run the proof, for example "run the microVM proof
   on deploy@192.168.1.50" or "run it on this machine". The first run asks
   you to confirm. Your Yes saves the choice to your Pi config and the run
   continues.
2. Run `/agentic-isolation-enable` and confirm.
3. Each cutover run asks for its own confirmation. Later runs reuse the saved
   target without asking where the microVM runs again.

The tool discovers the technical details from the machine itself:
architecture, kernel, libvirt driver. You configure nothing. Before any run,
the probe checks three requirements: `/dev/kvm` is accessible, libvirt
reports the system-level driver, and a matching `qemu-system-<arch>` binary
exists. A failed check denies the run before anything happens. The shipped
fixture guest is x86_64-built, so the full proof currently needs an x86_64
KVM host.

### What example tests look like

We started with one payload: print a greeting, then call a network tool. The
greeting printed, the tool tripped the killswitch at the HIGH tier, and the
line after it never ran. A kill report landed in the state directory naming
the rule and tier, and the teardown proof showed the machine was gone with
nothing left behind.

From there we wrote a payload for every rule in the taxonomy: credential
probing behind chained commands, secret dumping inside subshells, package
installs, coordination files reaching for other agents, a forged receipt, a
write to the evidence channel, and ten unclassified commands in a row to push
the anomaly threshold to its limit.

The guest had no disk, no network, no host share, no credentials, and no GPU.
Nothing outside the kernel's virtual filesystems could be mounted. Every
attempt was denied and written to a log that survived the machine.

While this is a toy test of sorts my own personal work will be running on
these as well.

### What the containment layer defends against

Agent escapes tend to follow a playbook, and the published incidents from
frontier labs (the HuggingFace incident among them) read like one: grab
credentials, phone home, install something persistent, rewrite your tools,
stage payloads in caches, look for other agents to recruit, clean up the
evidence. The containment layer has a rule for each step:

- **Credential theft.** Reading SSH, cloud, or token material, or dumping
  environment secrets, ends the session immediately.
- **Exfiltration and remote control.** Any network tool, any socket, ends the
  session immediately.
- **Persistence through dependencies.** Package installs, registry writes,
  and manifest tampering are denied and counted. Repeat the attempt and the
  session ends.
- **Self-modification.** Rewriting the agent's own tools or the monitoring
  layer is denied and counted.
- **Payload staging.** Growth in cache and package directories is sampled by
  size; repeated growth ends the session.
- **Cross-agent escalation.** Coordination channels and shared paths used to
  reach other agents end the session immediately.
- **Evidence tampering.** Editing logs, forging receipts, or writing to the
  console channel ends the session immediately.
- **Reconnaissance.** Probing the sandbox to learn whether it is watched is
  counted into a concealment index that ships in the run receipt.

Denials are written to a tamper-evident, digest-chained log that outlives the
session, and a trip produces a kill report naming what happened, with proof
that the cleanup completed.

### Proven against real machines

Every rule above has been run against a real QEMU/KVM guest with a payload
built to trigger it. The kill switches fired where they should, the denials
stopped the jobs, and the cleanup held. One boundary is worth stating: two
rules watch the same directories by design, and together they are stricter
than either alone, so the growth-sampling trip is covered by automated tests
rather than a live run.

The repository carries an acceptance matrix of 79 scenarios, one executable
test per row, covering every rule, every way a command can be invoked, and
every threshold boundary. It grows as new scenarios come to light.

### A note on review quality

A quantized GLM-5.3-Flash model running locally on an NVIDIA DGX Spark
reviewed this work alongside two frontier reviews at high reasoning. The
local model matched their coverage and found one issue they all missed.
Small models on your own desk are worth taking seriously as reviewers.

</details>

<details>
<summary><strong>autonomous journeys, overnight operation</strong> <em>(released, 0.7.0)</em></summary>

Dispatch a worker journey that runs end to end while you are away. The
journey proceeds through steps without pausing for confirmation, replaces
agents that get stuck, and records everything in one report you read when
you come back.

Autonomy is entered by your words alone. Say "run these overnight end to
end" or "don't wait for me" and the journey runs in autonomous mode. Say
"do these two things" and it runs in the normal mode, pausing for you
between steps. The mode is recorded in the report either way.

Autonomous journeys can run work you dispatch directly or work claimed from
a task board. Board-managed journeys use the card's authenticated assignment
envelope and the board's automation policy. Direct journeys continue to work
without a board.

### The cast

You name the agents for the journey, and that list becomes the standing
permission. If the implementer gets stuck at 3am, a replacement spawns
automatically: same role, same model, both in the list you authorized.
If a task needs an agent you didn't name, the attempt is recorded and that
thread stops. Nothing outside your list can appear while you sleep.

The cast is frozen at dispatch and never grows. It can only shrink in
practice (roles finishing their work), never widen.

### When agents get stuck

A stuck agent doesn't block the journey. The journey detects the stall,
spawns a replacement from the cast, and the replacement starts with a
mandatory gap analysis: read the task spec, inspect the repository, consult
the journey history, and state what remains before resuming. The replacement
must show that the remaining work is smaller than what its predecessor left.
If it can't, the journey stops that role and continues with the others.

### The morning report

One block tells you what happened: the terminal state, each step's outcome,
every replacement with its gap analysis and progress judgment, and any
denials. Every claim is tied to a receipt or a report excerpt. No prose
narrative to reconstruct; you read the report and know exactly where things
stand.

</details>

<details>
<summary><strong>attended-authority guard</strong> <em>(released, 0.7.0)</em></summary>

The safety net between an agent and your shell. When a model tries to
delete, overwrite, or push, the guard stops it and asks you. Safe commands
pass through untouched. If you deny, you get a clear reason and the session
continues, and the agent does not retry behind your back. In headless runs
where no human can confirm, destructive commands are refused rather than
silently allowed.

</details>

**Under development in this theme:**

- **native macOS container proof.** The native Apple Container runtime has
  passed a fixed local isolation qualification: read-only repository mount,
  no network, automatic removal. The native Pi adapter is not yet part of the
  released package.

## Session continuity

*Managing context pressure, compaction, and avoiding lossy handover.*

**In development:**

- **context-pressure handling.** Pressure detection, non-lossy handover,
  compaction completion without cancellation loops, and continuation of the
  latest user goal. Development-only until the full live journey passes.
- **lossless session-reference compaction.** Selective, lossless retrieval of
  exact pre-compaction content, addressing factual degradation across
  repeated compactions. Designed as an optional add-on, not yet implemented.

**Planned in this theme:**

- **handover, checkpoint, and recovery.** Durable repository-local handover
  notes, governed checkpoint mutation, watchdog handoff, and fresh-session
  resumption that identifies goal, changed files, checks, and next step
  without executing anything.
- **evidence ledger.** Deterministic evidence indexing, lossless source
  projection, universal checkpoint produce/store/recover, and run-ledger
  records with crash and corruption vectors tested.
- **offline multihost evidence.** Record run evidence on each host while
  disconnected and reconcile it deterministically on reconnection, with no
  host as sole authority.

## Working with Git safely

*Extensions that keep routine Git low-friction and consequential Git guarded.*

**Planned:**

- **git workflow safeguards.** Not packaged yet. The planned capability covers
  exact-file staging, native confirmation, post-confirmation drift checks,
  and protected-operation boundaries.
- **assignment-aware Git journeys.** Planned merge and protected-push flows
  bound to a verified assignment, so consequential Git operations carry their
  own recorded provenance.

## Package integrity

*Extensions that keep the installed set honest and the record controlled.*

**Planned:**

- **security and integrity scanning.** Static scanning of MCP configs, agent
  skills, and extension packages for hardcoded secrets, prompt and shell
  injection, data-exfiltration endpoints, untrusted integrations, PII
  leakage, and OWASP/MCP threat families, with accept/redact/reject
  decisions. Built on the agent-scanner approach proven in Hillstar
  Orchestrator and Testudo.
- **checkpoint storage lifecycle.** Compression, deduplication, retention,
  and purging rules for capsule and index stores once a product ships, so
  session evidence has a managed lifetime instead of growing without bound.
- **product knowledge graph.** Semantic graph projection of a shipped
  product's checkpoints, decisions, and artifacts, so the record of what was
  built stays queryable after active development ends.

Each item lands here as its own extension when its scenario passes
acceptance with all prohibited effects absent.

### Portable repository contract

The `templates/AGENTS.md` file is a starting contract you can copy into any
repository that uses Pi agents. It asks for controlled tasks and realistic tests, and
treats agent reports as untrusted evidence. It never overwrites an existing `AGENTS.md`. Add your project rules below it.

## Install

From npm:

```sh
pi install npm:@evoclock/pi-agentic-driver
```

Or from Git at the latest release tag (see the repo's tags for the current one; the npm badge above shows the live version):

```sh
pi install git:github.com/evoclock/pi-agentic-driver@<latest-tag>
```

Released extensions load independently.

### Choose which extensions load

A normal install loads all packaged extensions by default. You can load only the
extensions you want with the object form in your Pi settings:

```json
{
  "packages": [
    {
      "source": "npm:@evoclock/pi-agentic-driver",
      "extensions": [
        "extensions/aidr.ts",
        "extensions/code-phage.js"
      ]
    }
  ]
}
```

The package includes the Herdr communication, lifecycle, and dispatch
extensions, the board and Tasks extensions, and `linux-microvm.ts`. Use
`pi config` to enable or disable individual resources from an installed
package. You are not required to use every extension.

## License

AGPL-3.0-only with author-attribution additional terms (Section 7(b));
see [LICENSE](LICENSE). Commercial use, forks, and substantial modifications
are permitted when all AGPL and attribution obligations are followed. A
separate commercial licence is available for organisations requiring
proprietary modifications or other terms incompatible with the AGPL.
