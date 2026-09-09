# pi-agentic-driver v0.5.0

<p align="center">
  <img src="assets/Yamagane-origami.png" alt="pi-agentic-driver, Yamagane origami mark" width="140"/>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL%20v3-blue?style=flat" alt="License: AGPL v3"/></a>
  <a href="https://www.npmjs.com/package/@evoclock/pi-agentic-driver"><img src="https://img.shields.io/npm/v/@evoclock/pi-agentic-driver?style=flat" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/version-0.5.0-blue?style=flat" alt="Version 0.5.0"/>
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
checks, and independent model review before release. We document each
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
| `agentic_herdr_communication` | Exchanges marked reports with worker agents; never grants authority. | shipped |
| `agentic_herdr_spawn_worker` | Starts one Pi worker in a pane or tab, with native confirmation. | shipped |
| `agentic_aidr` | A remedy for AI;DR. Reviews writing for clarity, simplicity, brevity, and humanity. | shipped |
| `agentic_linux_microvm_cutover` | Runs one job in a throwaway QEMU/KVM virtual machine on a Linux host, with a severity-tiered killswitch that stops escape attempts. | user-enabled, native confirmation |
| `agentic_worker_dispatch` | Runs controlled worker journeys and observes worker liveness. | shipped |

**Status: active development and testing.** Each extension ships only after
it passes fixture-based acceptance, native tests, live-session checks, and
independent model review. You can install released components. Pending
components are listed here for transparency and are not packaged.

## Code review and planning

*Extensions that review, route, and control what an agent does.*

<details>
<summary><strong>code-phage, advisory code review</strong> <em>(released, 0.1.1)</em></summary>

`code_phage` reviews a proposed change against a stated goal before the agent
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

**Under development in this theme:**

- **prompted planning lifecycle.** Natural-language goals become complete
  semantic proposals with parent and scope choices at native boundaries. No
  retry loops, no model-supplied identifiers.
- **native assignment selection.** Planned assignments are chosen through a
  native UI over derived candidates, never by model-supplied targets.
- **inventory refresh.** Git-aware codebase inventory regeneration with
  verification receipts, so prior-art matching stays honest.

## Multi-agent communication

*Extensions for controlled coordination between agents.*

<details>
<summary><strong>herdr-communication, controlled role communication</strong> <em>(released, 0.2.1)</em></summary>

`agentic_herdr_communication` exchanges controlled, marked reports with
configured Pi worker roles running under [Herdr](https://herdr.dev/) 0.8.2.

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

`agentic_herdr_spawn_worker` turns one natural-language request into Herdr's
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

`agentic_worker_dispatch` runs controlled worker journeys and observes worker
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

**Under development in this theme:**

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

`agentic_aidr` reviews the last assistant response, supplied prose, or a
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

Isolation is off at the start of every session. You turn it on with
`/agentic-isolation-enable` in the Pi TUI, and confirm. The model cannot run
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

### What an example test looks like

We ran a containment job whose payload printed a greeting, then invoked a
network tool. This is what happened:

- The greeting printed.
- The network tool tripped the killswitch at the HIGH tier, immediately.
- The line after the denied command never ran.
- The session log recorded one denial and a clean evidence digest.
- A durable kill report was written to the state directory, naming the rule,
  class, and tier, with teardown proof: the machine was gone, the temporary
  access grants were restored byte-for-byte, and nothing persisted.

The guest had no disk, no network, no host share, no credentials, and no GPU.
It could mount nothing beyond the kernel's virtual filesystems. It tried to
reach the network anyway. It died for it, and the record of why survived.

While this is a toy test of sorts my own personal work will be running on these as well.

### What the containment layer defends against

Agent escape attempts follow a pattern. The published incidents from frontier labs, including
the HuggingFace agent incident, read like a playbook: grab credentials, phone
home, install something persistent, rewrite your own tools, stage payloads in
caches, look for other agents to recruit, and clean up the evidence. The
containment layer denies each stage of that playbook:

- **Credential theft.** Reading SSH, cloud, or token material, or dumping
  environment secrets, ends the session immediately.
- **Exfiltration and remote control.** Any network tool, any socket, ends the
  session immediately.
- **Persistence through dependencies.** Package installs, registry writes,
  and manifest tampering are denied and counted. Repeat attempts end the
  session.
- **Self-modification.** Rewriting the agent's own tools or the monitoring
  layer is denied and counted.
- **Payload staging.** Sudden growth in cache and package directories is
  sampled by size. Repeated growth ends the session.
- **Cross-agent escalation.** Coordination channels and shared paths used to
  reach other agents end the session immediately.
- **Evidence tampering.** Editing logs, forging receipts, or writing to the
  console channel ends the session immediately.
- **Reconnaissance.** Probing the sandbox to learn whether it is watched is
  counted into a concealment index that ships in the run receipt.

Every denial goes into a tamper-evident, digest-chained log that outlives the
session. Every trip produces a durable kill report that names what happened
and proves the cleanup. The repository carries an acceptance matrix of 79
scenarios, one executable test per row, covering every rule, every way a
command can be invoked, and every threshold boundary. These will of course be expanded as more scenarios are considered/come to light.

### A note on review quality

A quantized GLM-5.3-Flash model running locally on an NVIDIA DGX Spark
reviewed this work alongside two frontier reviews at high reasoning. The
local model matched their coverage and found one issue they all missed.
This is just to say that small models on your own desk are worth taking seriously as implementers/reviewers.

**What the containment layer defends against.** The severity-tiered killswitch
covers the attack chain observed in published agent-escape incidents —
including the HuggingFace agent incident — at every stage:

- **Credential theft** (reading SSH/AWS/token material, dumping environment
  secrets) — immediate termination.
- **Exfiltration and remote control** (network tools, any socket activity) —
  immediate termination.
- **Persistence via dependency installs** (package-manager invocations,
  registry writes, manifest tampering) — denied and accumulated; repeated
  attempts terminate the session.
- **Self-modification** (rewriting the agent's own tools or the monitoring
  layer) — denied and accumulated.
- **Bulk cache staging** (sudden growth in package/cache directories, the
  payload-staging pattern) — detected by size-delta sampling; repeated growth
  terminates the session.
- **Cross-agent escalation** (coordination channels, shared paths used to
  reach other agents or the coordinator) — immediate termination.
- **Evidence tampering** (editing or truncating logs, forging receipts,
  writing to the transcript or console channel) — immediate termination.
- **Reconnaissance of the monitor itself** (probing the sandbox to learn
  whether it is watched, enumerating watchers, timing detection) — accumulated
  into a concealment index surfaced in the run receipt.

Every denial is logged to a tamper-evident, digest-chained evidence log that
survives the session; every trip produces a durable kill report naming the
rule, class, and severity tier, with teardown proof. A full acceptance matrix
(79 scenarios covering every rule, invocation form, and threshold boundary) is
executable-tested in the repository.

</details>

**Under development in this theme:**

- **native macOS container proof.** The native Apple Container runtime has
  passed a fixed local isolation qualification: read-only repository mount,
  no network, automatic removal. The native Pi adapter is not yet part of the
  released package.
- **attended-authority guard.** The safety net between an agent and your
  shell. When a model tries to delete, overwrite, or push, the guard stops it
  and asks you. Safe commands pass through untouched. If you deny, you get a
  clear reason and the session continues, and the agent does not retry behind
  your back. In headless runs where no human can confirm, destructive
  commands are refused rather than silently allowed.

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

**In development:**

- **git workflow safeguards.** Design only; the package contains no Git
  extension yet. The planned capability covers exact-file staging, native
  confirmation, post-confirmation drift checks, and protected-operation
  boundaries.
- **assignment-aware Git journeys.** Merge and protected-push flows bound to
  a verified assignment, so consequential Git operations carry their own
  recorded provenance.

## Package integrity

*Extensions that keep the installed set honest and the record controlled.*

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

`templates/AGENTS.md` is a starting contract you can copy into any repository
that uses Pi agents. It asks for controlled tasks and realistic tests, and
treats agent reports as untrusted evidence. It never overwrites an existing
`AGENTS.md`; add your project rules below it.

## Install

From npm:

```sh
pi install npm:@evoclock/pi-agentic-driver
```

Or from Git at a pinned tag:

```sh
pi install git:github.com/evoclock/pi-agentic-driver@v0.5.0
```

Released extensions load standalone; neither requires the other.

### Choose which extensions load

A normal install loads all six extensions by default. You can load only the
extensions you want with the object form in your Pi settings:

```json
{
  "packages": [
    {
      "source": "npm:@evoclock/pi-agentic-driver@0.5.0",
      "extensions": [
        "extensions/aidr.ts",
        "extensions/code-phage.js"
      ]
    }
  ]
}
```

The package also includes `herdr-communication.ts`, `herdr-lifecycle.ts`,
`herdr-dispatch.ts`, and `linux-microvm.ts`. Use `pi config` to enable or
disable individual resources from an installed package. You are not required
to use every extension.

## License

AGPL-3.0-or-later with author-attribution additional terms (Section 7(b));
see [LICENSE](LICENSE). A commercial licence is available on request.
