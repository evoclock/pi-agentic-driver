# Shipped skills, tools and commands

This packed reference lists the registered public surface. The [README](../README.md) explains use and limits. Names here do not grant authority.

## Model-callable tools

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
| `agentic_herdr_close_tab` | herdr-lifecycle | Closes one verified local single-pane tab owned by the caller role or observed idle/done. Refuses remote, caller, coordinator, protected and last-workspace tabs. See the concurrency limitation in [Herdr workers](../docs/herdr-workers.md#close-a-finished-tab). |
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
| `agentic_workflow_run`, `agentic_workflow_status`, `agentic_workflow_tick`, `agentic_workflow_dispatch`, `agentic_workflow_gate`, `agentic_workflow_cancel` | workflow-runner | Draft workflow controls sharing the CLI reducer. Dispatch uses guarded worker tools and parks unknown effects without retry. Frozen host checks remain separate from delivery acknowledgement and do not prove full skill adherence; cancel needs native confirmation. |
| `agentic_harvest_lessons` | harvest-lessons | Read-only collector for the `pad-harvest-lessons` skill. Writes nothing. |

## Commands

| Command | Extension | What it does |
|---|---|---|
| `/tasks` | tasks | Shows the session plan without changing it. |
| `/loop-until-done <steps> <goal> :: <exit check>` | loop-until-done | Works toward an exit check within a fixed budget (default: 200 attempts or 30 minutes). Detects idle, repeated calls, and explicit blockers; gives at most one recovery hint per run without granting another dispatch. |
| `/agentic-isolation-enable`, `/agentic-isolation-disable` | linux-microvm | Turns microVM isolation on or off for this session. The model cannot run these. |
| `/agentic-linux-microvm-cutover` | linux-microvm | Runs the confirmed microVM proof from the TUI. |
| `/agentic-recovery-evidence` | recovery-evidence | Opens private recovery evidence in the TUI. Review only. |
| `/skill-observation-report` | task-skill-observability | Shows local task and skill coverage, with no model inference. |

## Skills

| Skill | What it does | Backed by code |
|---|---|---|
| `tasks` | Track work in the session list and promote owner-chosen tasks to `TASKS.md`. | `Task*` tools |
| `pulse` | Check board capacity and work through ready cards with Board Pulse. | `agentic_kanban_pulse` |
| `review-ready` | Run required-TLC preflight, list guard controls and map recurring findings before review. | PAD source checkout; Java/TLC; behavior proof separate |
| `decision-gate` | Settle bounded design decisions with statechart/TLC evidence and an enforcing check; hold owner-only actions. | Pi: `statechart-pi` (`pi-poteto-mode`); Claude: `/statechart`; TLC; behavior proof gap |
| `decision-to-spec` | Turn an explicit owner decision, or a sourced quoted relay, into one reviewable assignment with outcomes and a stop point. | `agentic_decision_evidence`, `agentic_relay_check_request` |
| `evidence-first-delivery-workflow` | Draft an inactive delivery plan for a new or resumed unit, then check it with a static validator. Plan only: it runs and dispatches nothing. | `validate_plan.mjs` (static checks only) |
| `pad-harvest-lessons` | Mine past corrections (reviews, reverts, failed CI, session logs), rank the patterns, and hand the top ones to `correct-it-pi`. Model-invocable and available via `/skill:pad-harvest-lessons`. | `agentic_harvest_lessons` (read-only) |
| `crew-tracker-sync` | Keep a team tracker current from live evidence: every open PR, worker stream and human unblock. | `validate_tracker.mjs` |
| `correct-it-pi` | Turn a repeated, evidenced mistake into a structural guard and prove it catches a real past failure. Model-invocable and available via `/skill:correct-it-pi`. | — |
| `pad-public-pr-wording` | Draft PR titles and bodies in four sections, in the owner's voice, then lint them. | `pr_wording_lint.py` |
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
