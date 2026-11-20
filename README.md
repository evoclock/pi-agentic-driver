# pi-agentic-driver

<p align="center">
  <img src="assets/Yamagane-origami.png" alt="pi-agentic-driver, Yamagane origami mark" width="140"/>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL%20v3-blue?style=flat" alt="License: AGPL v3"/></a>
  <a href="https://www.npmjs.com/package/@evoclock/pi-agentic-driver"><img src="https://img.shields.io/npm/v/@evoclock/pi-agentic-driver?style=flat" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/status-active%20development-orange?style=flat" alt="Status"/>
</p>

Extensions and skills for [Pi](https://github.com/earendil-works/pi-coding-agent)
that make agent work checkable and controllable.

An agent without guardrails will sometimes rewrite code that already exists,
push to the wrong remote, lose context, or report success without evidence.
Pi is lean by design and leaves the harness to you. This package is my
harness. It adds:

- review before code is written;
- guarded worker start-up and messaging through [Herdr](https://herdr.dev/);
- a task board with recorded authority;
- durable journeys that resume without resending;
- confirmed Git writes;
- sandboxed proofs in a throwaway virtual machine.

A worker report, receipt or delivery is evidence. It is never approval.

<p align="center">
  <img src="assets/agentic-driver-full-color.gif" alt="Agentic Driver control vault" width="768">
</p>

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Supported hosts](#supported-hosts)
- [Tools and features](#tools-and-features)
- [Skills](#skills)
- [Safety model](#safety-model)
- [Multi-agent communication](#multi-agent-communication)
- [Task board and Pulse](#task-board-and-pulse)
- [Sandboxed execution](#sandboxed-execution)
- [Session continuity](#session-continuity)
- [Git safety](#git-safety)
- [Package integrity](#package-integrity)
- [Configuration](#configuration)
- [License](#license)

## Install

```sh
pi install npm:@evoclock/pi-agentic-driver
```

Or from Git at a release tag:

```sh
pi install git:github.com/evoclock/pi-agentic-driver@<tag>
```

Start a fresh Pi process after installing or upgrading so the new tools load.

Requirements:

- Node.js 22.19.0 or newer (durable dispatch and the router's `node:sqlite` store).
- [Herdr](https://herdr.dev/) for the worker tools. Tested against Herdr 0.9.1.
- The Treehouse CLI for worktree leases. It is a separate Go tool, not an npm
  dependency. The supported version is pinned in `config/treehouse.v1.json`.
- A Linux host with KVM, libvirt and QEMU for the microVM tool only.

Every extension loads on its own. You can load only some of them. See
[Choose what loads](#choose-what-loads).

## Quick start

1. Install the package and start Pi in a repository.
2. Ask for a review before writing code: "Run code_phage on this plan."
3. Start a worker: "Spawn an implementer tab for this repository."
   The agent calls `agentic_herdr_spawn_worker`.
4. Send it a brief: the agent calls `agentic_herdr_communication` with
   `prompt`, then checks `delivery` for the answer.
5. Copy [templates/AGENTS.md](./templates/AGENTS.md) into your repository as a
   starting agent contract. Add your own rules below it.

## Supported hosts

Pi is the host. Other agent apps can use the same worker tools when they run
Pi with this package loaded. They do not need a Herdr pane of their own.

| Host | How it connects | What works | Limits |
|---|---|---|---|
| Pi in a Herdr pane | Native. The caller's pane supplies the workspace. | All tools. | None beyond each tool's own limits. |
| Pi outside Herdr | Pass `workspace` (an existing Herdr workspace ID or label) to `agentic_herdr_spawn_worker`. | Spawn, then list, get, prompt, delivery, wait and read. | The workspace must exist and match exactly one entry. |
| External bots (MausBot/OpenMausBot and OpenBot as of the time of writing) | Call the packaged Pi tools through Pi, with an explicit `workspace`. | Spawn a guarded worker, then prompt it and read its answers. | They use the Pi tools only. No raw Herdr commands. This is not a general cross-framework agent launcher. |
| Electron apps (attended) | A trusted Electron main process calls `preflightAttendedElectronSpawn`, then `executeHerdrSpawnWorkerAttendedElectron`, with an `electron-attended` context. Board Pulse uses the same boundary when it is bound. | One guarded worker tab per call, with the same repository, model and pane checks as Pi. | Tab placement only. An Electron context never passes the Pi TUI check, and a TUI context never passes the Electron check. If the host has not bound this boundary, Pulse refuses. |
| Other agent apps | Same as "Pi outside Herdr": run Pi with the package and pass `workspace`. | Same as above. | No app-specific code. Support is through the shared Pi tools only. |
| Local machine host | `scripts/machine_host.mjs mcp` (JSON-RPC over stdio) or `scripts/machine_host.mjs rest` (loopback only). | Board, journey, durable run and reservation commands over one shared command table. | Standalone, it cannot confirm with the owner or start workers. Those commands return `needs-approval`, `needs-reconciliation` or `unverified` until the host wires in its own callbacks. See [docs/machine-host.md](docs/machine-host.md). |

On the attended Electron boundary, a supplied `authority.ledgerId` is checked read-only during preflight, then reserved before tab creation and recorded as spawned only after read-back. A grant must cover the exact repository, model, and role; revoked or expired grants fail before mutation. A linked worktree requires either its exact canonical path in the grant’s non-empty `paths`, or a repository grant with `paths: []` and a verified, actively leased Treehouse worktree belonging to that same repository; empty paths never authorize unrelated or unleased directories. Preflight consumes no use. Callers must send the same configured model to preflight and commit; an external fleet wrapper's hardcoded fallback cannot override the model authorized by a grant.

In every case the spawn path checks the target checkout, the workspace, and
the new pane and agent. A partial result is reported as partial, never as a
successful spawn. A prompt hands a brief to the worker's queue. Delivery only
tells you whether a matching answer arrived. It is not finished work.

A newly created pane may still be starting its shell. Spawn tries the same
pane again only when Herdr returns `agent_pane_busy`. The default readiness
window is 15000 ms, checked every 250 ms. An agent host can set
`PAD_HERDR_PANE_READY_TIMEOUT_MS` and `PAD_HERDR_PANE_READY_POLL_MS` in the Pi
process environment before calling `agentic_herdr_spawn_worker` with its
usual JSON arguments. Both values must be integer milliseconds from 1 to
120000; invalid values fail before tab creation. Internal callers can instead
pass `paneReadyTimeoutMs` and `paneReadyPollMs` in the execution options.
These settings do not change the tool's JSON parameter shape or require an
interactive step. The default applies to fleet spawns without overrides.

## Tools and features

Every model-callable tool the package registers, plus the commands and
background features that are not tools.

### Model-callable tools

| Tool | Extension | What it does |
|---|---|---|
| `code_phage` | code-phage | Reviews a plan against its goal before code is written. Finds prior art, measures complexity, flags scope drift. Advisory only. |
| `agentic_aidr` | aidr | Reviews writing for clarity, simplicity, brevity and humanity. Optional plain-language and STE-informed modes. Writes a file only after a confirmed apply. |
| `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` | tasks | The session task list, with optional P0–P3 priority. |
| `TaskPromote` | tasks | Previews selected session tasks as `TASKS.md` cards. Writes only after the owner confirms. |
| `agentic_kanban_board` | task-board | Shows the board: lanes, flags, priorities, dependencies and runnable cards. |
| `agentic_kanban_board_write` | task-board | Adds cards through the trusted writer and records who asked. |
| `agentic_kanban_board_update` | task-board | Moves, closes, flags, edits or removes cards, recording who asked. |
| `agentic_kanban_board_dispatch` | task-board | Claims one eligible card and creates its single-use assignment envelope. |
| `agentic_kanban_pulse` | pulse | Board Pulse. `check` reports ready work and capacity. `run`, `enable`, `disable` and `configure` act under the board policy. |
| `agentic_herdr_spawn_worker` | herdr-lifecycle | Starts and verifies one Pi worker tab in a trusted repository. Draft Codex kind requires an explicit account/kind grant, fixed account home/model/Daybreak flags and process readback; it is not live-ready. Accepts an explicit `workspace` and an optional leased worktree. |
| `agentic_herdr_communication` | herdr-communication (also registered by herdr-lifecycle) | `list`, `get`, `prompt`, `submit`, `delivery`, `wait` and `read` for allowlisted Pi, Claude and Codex worker panes. `ready` observes explicit Pi/Claude input readiness; Pi-only native `steer` requires a live exact-turn capability, binds repository/session/pane/turn, allows one steer per turn and expires after 15 seconds. Steer delivery is not input receipt or an answered report. Unnamed panes require a unique tab label and live pane readback. Cannot target the caller's pane/tab or coordinator; unmarked terminal text is not an answered delivery. Codex prompts on this draft branch refuse without account/PID attestation. Claude/Codex reply attribution is not live-verified and may remain `delivered` after a reply. |
| `agentic_herdr_close_tab` | herdr-lifecycle | Closes one verified local single-pane tab owned by the caller role or observed idle/done. Refuses remote, caller, coordinator, protected and last-workspace tabs. See the concurrency limitation in [Herdr workers](docs/herdr-workers.md#close-a-finished-tab). |
| `agentic_herdr_register_repository` | herdr-lifecycle | Kept for compatibility. It does nothing: pre-registration is no longer needed. |
| `agentic_relay_check_request` | herdr-lifecycle | Read-only check that a recorded relay covers each requested action. |
| `agentic_worker_dispatch` | herdr-dispatch | `pulse` checks worker liveness. `dispatch` runs a bounded journey over session tasks. `journeys` lists saved journeys. |
| `agentic_worker_dispatch_async` | herdr-dispatch | `submit` returns a receipt at once. `poll`, `observe` and `read` check on it later. No retries or resends. |
| `agentic_journey_outward_effect` | herdr-dispatch | One confirmed Git push, or private draft PR create or update, for an existing journey. |
| `agentic_interactive_safeguards_toggle` | attended-authority-guard | Turns generic destructive-command confirmations on or off. |
| `agentic_decision_evidence` | attended-authority-guard | Records the stated source of a decision. Verifies no identity and grants nothing. |
| `agentic_merge_review_record` | attended-authority-guard | Records Standards and Spec verdicts for an exact PR head. Merges nothing. |
| `agentic_linux_microvm_cutover` | linux-microvm | Runs one job in a throwaway QEMU/KVM VM. Needs isolation enabled and a confirmation per run. |
| `agentic_linux_microvm_checks` | linux-microvm | Runs only frozen workflow receipt checks through the fixed SSH subsystem. Requires native attended consent or a scoped standing grant and verified pinned-image readiness. Live backend acceptance remains pending; unavailable never means pass. |
| `agentic_recovery_evidence_summary` | recovery-evidence | Read-only counts of recent recovery records. Returns no content. |
| `agentic_task_skill_observation` | task-skill-observability | Records a task's declared recipe, outcome and observed tool activity, or reports coverage. |
| `agentic_workflow_run`, `agentic_workflow_status`, `agentic_workflow_tick`, `agentic_workflow_dispatch`, `agentic_workflow_gate`, `agentic_workflow_cancel`, `agentic_workflow_handbrake` | workflow-runner | Draft workflow controls sharing the CLI reducer. Dispatch uses guarded worker tools and parks unknown effects without retry. Frozen host checks remain separate from delivery acknowledgement and do not prove full skill adherence; cancel and hold need native confirmation. |
| `agentic_harvest_lessons` | harvest-lessons | Read-only collector for the `harvest-lessons` skill. Writes nothing. |

See [docs/review-and-writing.md](docs/review-and-writing.md) for review and writing workflows. [G8 exit checks](docs/design/workflow-runner/exit-gate.md) bind completion to frozen checks on recorded output bytes; [the guest-check delivery split](docs/design/workflow-runner/ssh-guest-check-contract.md) keeps core unavailable until the separate live backend ships.

### Commands, shortcuts and background features

| Feature | Extension | What it does |
|---|---|---|
| `/tasks` | tasks | Shows the session plan without changing it. |
| `/loop-until-done <steps> <goal> :: <exit check>` | loop-until-done | Works toward an exit check within a fixed budget (default: 200 attempts or 30 minutes). Detects idle, repeated calls, and explicit blockers; gives at most one recovery hint per run without granting another dispatch. |
| `/agentic-isolation-enable`, `/agentic-isolation-disable` | linux-microvm | Turns microVM isolation on or off for this session. The model cannot run these. |
| `/agentic-linux-microvm-cutover` | linux-microvm | Runs the confirmed microVM proof from the TUI. |
| `/agentic-recovery-evidence` | recovery-evidence | Opens private recovery evidence in the TUI. Review only. |
| `/skill-observation-report` | task-skill-observability | Shows local task and skill coverage, with no model inference. |
| Alt+Shift+S | attended-authority-guard | Flips interactive confirmations and shows the state in the status bar. |
| Attended-authority guard | attended-authority-guard | Checks shell and file tool calls. Enforces the merge policy and the raw Herdr ban. See [Safety model](#safety-model). |
| Inventory refresh | inventory-refresh | After a successful write or edit to a code file, `TASKS.md` or `HANDOVER.md`, refreshes the codebase inventory in the background. Never blocks or changes the tool result. |
| Treehouse recycle | treehouse-recycle | At session start and every five minutes, returns leased worktrees that are idle, clean and pushed, and whose exact head was merged. |
| Pulse timer | pulse | Runs Board Pulse on its configured interval when the board policy enables it. |
| Router and Janus | pulse | Picks a seat for Board Pulse. Janus is a bundled loopback service for ranking and the dispatch gate. See [docs/router.md](docs/router.md) and [janus/README.md](janus/README.md). |

## Skills

Invoke a skill with `/skill:<name>`. Pi may also load a skill's description by
itself. Loading a skill is not approval to act. Skills are guidance for the
model. They are not runtime guards. Where a skill relies on code (a script or
a tool), the table says so. Every skill listed here has a passing proof
test: tests of its backing code, or a behaviour test against a fixture.
The decision-gate contract covers packaging and the sample model only; its guidance behavior proof is unconfigured.

| Skill | What it does | Backed by code |
|---|---|---|
| `tasks` | Track work in the session list and promote owner-chosen tasks to `TASKS.md`. | `Task*` tools |
| `pulse` | Check board capacity and work through ready cards with Board Pulse. | `agentic_kanban_pulse` |
| `review-ready` | Run required-TLC preflight, list guard controls and map recurring findings before review. | PAD source checkout; Java/TLC; behavior proof separate |
| `decision-gate` | Settle bounded design decisions with statechart/TLC evidence and an enforcing check; hold owner-only actions. | Pi: `statechart-pi` (`pi-poteto-mode`); Claude: `/statechart`; TLC; behavior proof gap |
| `decision-to-spec` | Turn an explicit owner decision, or a sourced quoted relay, into one reviewable assignment with outcomes and a stop point. | `agentic_decision_evidence`, `agentic_relay_check_request` |
| `evidence-first-delivery-workflow` | Draft an inactive delivery plan for a new or resumed unit, then check it with a static validator. Plan only: it runs and dispatches nothing. | `validate_plan.mjs` (static checks only) |
| `harvest-lessons` | Mine past corrections (reviews, reverts, failed CI, session logs), rank the patterns, and hand the top ones to `correct-pi`. Explicit invocation only. | `agentic_harvest_lessons` (read-only) |
| `crew-tracker-sync` | Keep a team tracker current from live evidence: every open PR, worker stream and human unblock. | `validate_tracker.mjs` |
| `correct-pi` | Turn a repeated, evidenced mistake into a structural guard and prove it catches a real past failure. Explicit invocation only. | — |
| `public-pr-wording` | Draft PR titles and bodies in four sections, in the owner's voice, then lint them. | `pr_wording_lint.py` |
| `test-gate` | Prove changed tests fail first, then pass, and catch a mutation, using the host runner. Repository checkout only: the runner is not in the npm package. | `make test-gate` (needs `.driver/gate-rules.json`) |
| `workflow-runner` | Guide one bounded workflow event and report unresolved worker-dispatch and skill-procedure proof gaps. Draft and voluntary; no real-worker execution is implied. | `pad-runner` CLI and `agentic_workflow_*` Pi tools (non-authorizing) |
| `skill-usage-eval` | Compare skill-use recommendations with labelled task evidence and inspect uncertainty before choosing a default. A load requires a successful dedicated read of the exact catalog skill file. Relative reads resolve against the recorded session directory; without one, they do not count. Shell commands, writes and path mentions do not count. The evaluator CLI and its documentation ship with the skill for non-interactive workflow runs. The separate handcheck scorer and its evidence are repository-only. | `node scripts/skill_usage_eval.mjs --limit 20` (installed package root); `make skill-usage-handcheck` (repository checkout only) |
| `session-handover` | Write and consume a fixed-shape, source-indexed handover once. | `scripts/session_handover.py` |
| `ralph` | Run one bounded fix-plan item per iteration, with acceptance, plateau and handover checks. | `scripts/ralph.py` |
| `model-fidelity` | Compare built work against its original plan and model assumptions. Protocol mode exposes missing maps and diagram gaps; light statechart mode disclaims correspondence. The first slice supports prepare, diagram and read, not checker or evaluation calls. | `scripts/model_fidelity.mjs` (evidence-only CLI) |
| `driver-mode` | Route an explicitly named driver job (ship, Ralph, board run, lesson harvest, model fidelity, weekly recap and others) to its playbook. Ordinary work stays ordinary. | — |
| `weekly-build-recap` | Draft a local weekly GitHub recap with an image and draft posts. Never posts. | `recap.py`, `render.py` |
| `driver-principle-boundary-only-authority` | Check authority at consequential boundaries, not on every step. | — |
| `driver-principle-cite-your-status` | Pair every status claim with a source. | — |
| `driver-principle-dependency-policy` | Prefer first-party code; pin and justify every dependency. | — |
| `driver-principle-evidence` | A summary points to evidence. It does not replace it. | — |
| `driver-principle-fail-loud` | Never turn a missing or unknown result into a pass. | — |
| `driver-principle-working-memory-is-not-authority` | Task lists, summaries, hashes and receipts never grant permission. | — |

The pstack skill ports are not in this package. Install `pi-poteto-mode`
separately if you need them.

## Safety model

Some checks are enforced by code. Others are guidance the model follows.
This README keeps them apart.

**Enforced by code:**

- **Raw Herdr ban.** The attended-authority guard refuses raw Herdr CLI from
  the shell (agent start, prompt, read, wait, send-keys). Use the guarded tools.
- **Merge policy.** One owner-set value. See [docs/merge-policy.md](docs/merge-policy.md).
  - `human-merges-only` (default): every agent merge command is refused.
  - `agents-after-checks-and-review`: a plain `gh pr merge <ref>` is allowed
    only when every check on the head passed and independent Standards and
    Spec PASS verdicts are recorded for that exact head.
  - `agent-pr-merge`: the same review evidence, and the agent may also run
    `gh pr merge <ref> --auto --match-head-commit <sha>`. The SHA must be the
    reviewed head. No check may have failed. If checks are still pending,
    GitHub must be holding the merge (`BLOCKED`); otherwise every check must
    have passed. Only required checks hold an auto-merge.
  - Always refused: `--admin`, `--auto` under the other two values, REST and
    GraphQL merges (including enabling auto-merge), and branch-protection or
    ruleset writes.
- **Profile config protection.** Agent `write` and `edit` calls to the user
  profile's `config/` directory are always blocked.
- **Headless refusal.** When confirmations are on and no human can answer,
  destructive calls are refused.
- **Spawn checks.** Git identity, origin owner, installed model roster, an
  active Treehouse lease for worktree targets, fixed argv and `shell: false`.
- **Board writer.** Only the trusted writer changes `TASKS.md`. Agents cannot
  complete cards on their own.
- **Fail closed.** Bad config, unknown policy or missing evidence refuses the
  action.

**Limits of the code checks:** the guard reads command text. It does not see
a merge through shell indirection, another tool or the GitHub web page. It is
a workflow guard, not a sandbox. Branch protection on GitHub stays the real
gate.

**Guidance only:** every skill, including the driver principles, and the
`templates/AGENTS.md` contract. They shape what the model does. They do not
stop it.

Interactive confirmations are off by default. See
[docs/interactive-safeguards.md](docs/interactive-safeguards.md) for the
profile format. Relayed approvals are covered in
[docs/relay-authority.md](docs/relay-authority.md).

## Multi-agent communication

- **Start workers.** `agentic_herdr_spawn_worker` creates one labelled tab,
  starts one Pi agent, and checks role, model, pane and repository. Splitting
  the coordinator's pane is refused. A partial start is reported as
  `pane_created`, `tab_created` or `agent_started`. Nothing is retried or
  cleaned up automatically.
- **Talk to workers.** `agentic_herdr_communication` hands over one brief and
  returns a receipt at once. `delivery` reports queued, delivered, answered,
  failed, unknown or unattributed. An answer counts only when it matches its
  own delivery. Repeats inside a short window return the same delivery ID.
- **Run journeys.** `agentic_worker_dispatch` works through session tasks, one
  exchange per task, up to `maxSteps` (default 50, cap 200). A stuck worker
  ends the journey as unresponsive. A replacement can resume the same tasks.
- **Resume safely.** Each journey step is a durable checkpoint, saved before
  the send. After a crash the driver looks for the journey tag in the pane. It
  blocks instead of resending when it is unsure.

Deep dives: [docs/herdr-workers.md](docs/herdr-workers.md) (spawn,
communication, dispatch and journey limits) and
[docs/durable-persistence.md](docs/durable-persistence.md).

## Task board and Pulse

Planned work lives in `TASKS.md`. A generated `board.md` view works in
Obsidian. Agents use the board tools. The trusted writer assigns IDs, checks
fields and records your instruction.

Automated work needs an explicit board policy: allowed roles and
repositories, contained placement, maximum concurrency, expiry and risk
ceiling. Without a valid policy, automated dispatch is refused.
`agentic_kanban_board_dispatch` creates a single-use envelope bound to the
card, repository, revision, branch, paths, stop point and expiry. Using the
envelope releases the claim. It does not mark the card done.

Board Pulse picks a route seat through the router. The router's dispatch gate
asks Janus whether the task fits the seat. No verdict means no dispatch.

Deep dives: [docs/task-board.md](docs/task-board.md) (card fields, claim
contracts, external clients) and [docs/router.md](docs/router.md) (seats,
tunable values, Janus).

## Sandboxed execution

`agentic_linux_microvm_cutover` runs one job inside a throwaway QEMU/KVM VM
on a Linux host. The guest has no disk, network, host share, credentials or
GPU. The VM is deleted after the job.

- Isolation is off at the start of every session. Turn it on with
  `/agentic-isolation-enable`. The model cannot run that command.
- You choose the target machine. Saving or using a target needs your
  confirmation. Each run asks again.
- A killswitch watches for credential theft, network use, persistence,
  self-modification, payload staging, cross-agent contact, evidence tampering
  and reconnaissance. Denials go to a digest-chained log that outlives the VM.
- The bundled test guest is x86_64, so the full proof needs an x86_64 KVM host.

Deep dive: [docs/linux-microvm.md](docs/linux-microvm.md).

## Session continuity

- **Handover.** The `session-handover` skill writes one fixed-shape
  `HANDOVER.json` and consumes it once in the next session.
- **Ralph loops.** The `ralph` skill runs one fix-plan item per iteration and
  writes a handover after each one.
- **Bounded loops.** `/loop-until-done` keeps a session on one goal within a
  fixed budget.
- **Recovery evidence.** A private evidence store and a read-only TUI review.
  It does not perform recovery.
- **Task and skill observations.** Records which skill files a task read and
  which tool calls it made, with explicit capture gaps. It does not prove a
  task succeeded. See [docs/task-skill-observability.md](docs/task-skill-observability.md).

## Git safety

- `agentic_journey_outward_effect` makes one push or private draft PR write
  for a journey. It records intent first, needs TUI confirmation, refuses
  `main` and `master`, and after a crash checks the remote instead of writing
  again.
- It covers only writes the driver makes. Git commands a worker runs in its
  own shell are not intercepted.
- Treehouse recycle returns a lease only when the worktree is idle, clean and
  pushed, and its exact head was merged. A closed, unmerged PR keeps the lease.
  It never creates worktrees, cleans files or merges branches.

Create leased worktrees from the repository root:

```sh
treehouse get --lease --base main --branch <branch>
```

## Package integrity

- Public CI checks skill frontmatter and package registration, then loads the
  packed package in a fresh consumer and checks for skill errors. This is
  release validation, not an install-time security check.
- `make gate` runs the shared checks locally. See [docs/gate.md](docs/gate.md).
- The optional pre-commit hook (`.githooks/pre-commit`) checks the codebase inventory.

## Configuration

| File | Purpose |
|---|---|
| `$PI_CODING_AGENT_DIR/config/interactive-safeguards.v1.json` | Interactive confirmations. Example: `config/interactive-safeguards.v1.example.json`. |
| `$PI_CODING_AGENT_DIR/config/merge-policy.v1.json` | Merge policy. Example: `config/merge-policy.v1.example.json`. |
| `config/relay-authority.v1.example.json` | Relayed-approval example. |
| `config/treehouse.v1.json` | Pinned Treehouse CLI version. |
| `config/microvm-target.v1.json` | microVM target. The target you confirm is saved to your Pi config. |
| `.agentic-driver/router.defaults.json` | Router defaults. Override with `AGENTIC_DRIVER_ROUTER_PROFILE`. |
| `.agentic-driver/loop-until-done.defaults.json` | Loop limits. |
| `.agentic-driver/nudge.defaults.json` | Nudge classifier defaults (disabled). |

### Choose what loads

Use the object form in your Pi settings. Load two extensions:

```json
{
  "packages": [
    {
      "source": "npm:@evoclock/pi-agentic-driver",
      "extensions": ["extensions/aidr.ts", "extensions/code-phage.js"]
    }
  ]
}
```

Load one skill and no extensions:

```json
{
  "packages": [
    {
      "source": "npm:@evoclock/pi-agentic-driver",
      "extensions": [],
      "skills": ["skills/harvest-lessons"]
    }
  ]
}
```

Excluding `extensions/attended-authority-guard.ts` removes the guard, the
merge policy and the confirmation toggle. Use `pi config` to switch
individual resources on or off.

Optional structural code search: see the separate
[ast-sgrep fork](https://github.com/evoclock/ast-sgrep). It is not bundled.

## License

AGPL-3.0-only with author-attribution additional terms (Section 7(b)); see
[LICENSE](LICENSE). Commercial use, forks and substantial changes are allowed
when all AGPL and attribution terms are met. A separate commercial licence is
available for organisations that need terms the AGPL does not allow.
