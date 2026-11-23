## 3.2.3

- Idle Pi tabs report ready when Herdr omits launch_pending

## Unreleased

- Make every PAD skill model-invocable and give the three conflicting skills unique PAD names: `correct-it-pi`, `pad-harvest-lessons`, and `pad-public-pr-wording`. Their old PAD slash names change; the other packages keep theirs. Add a lint to prevent PAD correction references from routing to the poteto skill.

## 3.2.1

- Record every SKILL.md read with its nearest package name and version, including sessions without an active PAD task; clarify repository-only gate guidance.

## 3.2.0

- Pin published `@evoclock/pi-bowerbird` 0.3.0 for existing model-fidelity views; its TLA+/TLC verify and composition/click-through diagramming are available without changing the view API. Workflow-runner TLC migration and diagram rebuilds remain follow-ups.
- Add a guarded workflow runner for bot-host recipes: a statechart of pinned skill steps advances one move at a time, checks the spec before Pi worker dispatch, and requires a new-commit/output-digest receipt. Six public workflow tools (`run`, `dispatch`, `gate`, `status`, `tick`, `cancel`) plus `agentic_herdr_close_tab` ship. The route is draft; procedure verification remains false without trusted task-bound evidence. Durable claims, handovers and completion limits park uncertain effects instead of replaying them.
- Add receipt-bound exit checks, frozen output paths and observed digests; connect guest checks to a guarded launcher and pinned image. Bound checks and timeouts, and keep unavailable guest verification explicit.
- Add parallel workflow scheduling and recurrence verification, with evidence checks, conservative review budgets and explicit negative controls. Strengthen model-fidelity records, attempt tracking, crash fixtures, changed-rule detection, classification and review views.
- Add a decision-gate skill with statechart evidence, enforcing checks and explicit exclusions. Add skill-usage evaluation and prefer secret-store credentials, with validated local configuration and warned fallback.
- Improve worker lifecycle: guarded tab creation, pane readiness, trusted local integration, queued communication, bounded delivery attribution, stalled-worker detection, scoped abort and close, and one-status reporting. Keep unsupported worker transports and prompting explicitly refused.
- Export local skills as dry-run-first wrappers with safe apply backups. Make worker code search cancellable with bounded deadlines, optional index prewarming and a resolved CLI.
- Harden confirmation and approval scope, prompt delivery and finish handling, fleet claims, message attribution, workspace selection, and registration-free spawning. Prevent duplicate tool registration and retain the verified process boundary.
- Improve test-gate contrast and mutation coverage, multiple contracts, loader and fixture handling, snapshot cleanup, and explicit configuration-only warnings. Add reproducible skill proofs, containment tests and stricter host cleanup checks.
- Increase CI headroom for container runs, launcher fixtures, cleanup, exit checks and timeout tests; tune concurrency and macOS acceptance. Keep gate integrity and reviewed pipeline pins current.
- Generalize repository-owner configuration, correct release preparation and tag-from-main checks, and keep public synchronization tests and documentation aligned.

## 3.1.9

- Add the `agent-pr-merge` policy: agents may arm auto-merge for a reviewed head, pinned with `--match-head-commit`.
- Make every shipped skill complete, with a proof test for each one.
- Rewrite the README around hosts, tools and skills, with deep dives in `docs/`.
- Fix broken links and stale wording in shipped skills and docs.
- Add an on/off toggle and an optional TUI shortcut for generic command confirmations.

## 3.1.8

- Keep worker delivery attribution and add local task and skill observations.

## 3.1.7

- Recover a labeled worker from the live pane list when its tab has no pane id, and surface that recovery error instead of hiding it as not found.

## 3.1.6

- Keep worker delivery reports visible after a reconnect, report the worker directory instead of the caller directory, and let a finished worker take the next brief.

## 3.1.5

- Let trusted hosts start and contact workers without a caller pane.

## 3.1.1

- Strip remaining Herdr spawn registration and workspace friction so canonical trusted repos start guarded workers without registry or per-spawn ceremony.
- Vendor shared pr/env guards into the private driver with source provenance and tool-call coverage.
- Repo hygiene: ignore local Obsidian/pad/ci/treehouse scratch paths; stop tracking generated `pipeline_output/` inventory and the archify trial scratch.

## 3.1.0

- Registered workers start without repeated prompts, and the task panel shows five items while the full task list stays available.

## 3.0.3

- Document unattended Herdr spawn ledger grants; refuse all raw Herdr CLI including send-keys; treat empty ledger models/roles lists as any.

## 3.0.2

- Restore `@earendil-works/pi-ai` as `peerDependencies: "*"` so Pi stops warning about host-provided duplicate modules.

## 3.0.1

- Refuse raw herdr agent start fail-closed; document fleet Herdr spawn-only; keep public-pr-wording for sync PRs; document bounded stall recovery in README.

# Changelog

Release dates below come from the read-only npm registry `time` record for `@evoclock/pi-agentic-driver` (checked 2026-10-22).

## 3.0.0

- Remove the 53 bundled pstack Pi skill ports; install pi-poteto-mode separately. The native correct-pi skill remains.

## 2.1.0 (2026-10-23)

- Add the weekly build recap skill with an optional local phrase override and neutral default palette.
- Guard worker spawning by workspace label so workers start in their repository's own workspace.
- Queue briefs and messages for busy workers instead of dropping them.
- Classify idle workers without a done marker as stalled; the former idle-eligible state was renamed.
- Document bounded loop-until-done, packaged since 2.0.0 rather than new in this release.

## 2.0.0

- Rename `claimFrom[legacy private client]Request` to `claimFromBoardRequest` without an alias.
- Migrate `[legacy private client].board-claim-request.v1` to `agentic-driver.board-claim-request.v2`, `[legacy private client].board-claim-receipt.v1` to `agentic-driver.board-claim-receipt.v2`, `[legacy private client].board-claim-route.v1` to `agentic-driver.board-claim-route.v2`, and `[legacy private client].async-transport.receipt.v1` to `agentic-driver.async-transport.receipt.v2`. Legacy request schemas are refused; update producers and consumers together.
- Move the workspace capability registry from `.[legacy private client]/capabilities.json` to `.agentic-driver/capabilities.json`. Route identity now uses `board-<alias>` and `board-router`.
- Preserve the packaged decision-to-spec skill already shipped in 1.1.2; do not package the private worker-repository registry.

## 1.1.2 (2026-10-11)

- Published package included `skills/decision-to-spec/SKILL.md` and excluded `config/herdr-worker-repositories.v1.json`.

## 1.1.1 (2026-10-03)

- Published maintenance release. Registry timestamp: 17:40:59 UTC.

## 1.1.0 (2026-10-03)

- Published minor release. Registry timestamp: 13:55:31 UTC.

## 1.0.0 (2026-10-02)

- Published major release. Registry timestamp: 16:54:13 UTC.
