# P18 Pi playbooks: source-to-method map

Adapted from all 23 `pstack/skills/poteto-mode/playbooks/*.md` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT, Lauren Tan). Read the matched section **with** `SKILL.md` and the approved task contract. This is a method map, not runnable automation or 23 extra commands. Each playbook starts from the same task grant, uses `TaskCreate` only for session work when loaded, and stops before any unapproved effect. No stock executable, Cursor subagent, `/tmp` file, forge operation, package install or merge is imported. For each unit record its real check, source and unrun paths; only the repository owner merges.

## Investigation

Read-only cited answer. Use an actually loaded `how-pi` for mechanics and `why-pi` for rationale when authorized and present. For a decision, compare tradeoffs and say whether the premise survives. Throughput is `n/a: read-only`; no commit/PR or `architect-pi` unless separately asked to change code. Reply with evidence, uncertainty and a real judgment.

## Bug fix

Use the accepted app/CLI control surface to reproduce **before** code. Seed hypotheses from code mechanics and, if authorized, history; choose high-information experiments, observe the running mechanism, discard disproven hypotheses. A cheap regression gets a red test before the fix and is proposed as the first independently checkable delivery unit, with the fix second when commits are separately approved; cross-boundary design calls for loaded `architect-pi` before implementation. Change only the proved cause, verify the original repro on the same surface and capture before/after output; a unit test or wrong-surface pass is not a live pass. Escalate missing control/exit rather than inventing an app driver. Delivery/PR is a separate owner-approved step.

## Perf issue

Record a real baseline trace and vet it with `benchmark-checklist-pi`. Ground a cause with source and prefer, in order: skip unused work, reuse it, do less, defer it, move it off the critical path, use concurrency safely, then make it cheaper. Measure each accepted change on the same workload, compare artifacts and report work/errors/limiter/range. Stop when the actual target is met. An unmeasured improvement is inconclusive.

## Hillclimb

For sustained improvement, choose a realistic case reproducing the complaint, one metric/direction, an owner-accepted target **and** minimum attempts. Prove the measurement distinguishes contrasting workloads, freezes a repeatable harness with work/error counts and a green regression gate, then capture a baseline and private trail. One mechanism-backed hypothesis per iteration; isolate candidate writers, measure both sides with the frozen harness, keep only improvement beyond noise with a green gate. Preserve failed evidence and undo only this run's own isolated changes under the approved rollback path, never reset someone else's work. Pivot after stalls; no silent target relaxation. Report attempts, accepted changes, true delta and plateau.

## Runtime forensics

Diagnose a live symptom, not a captured file. Only with approved process/instance and diagnostics, collect matching CPU, heap or UI signals. Reduce a large artifact without exposing unauthorized data; prove the mechanism through safe, explicitly granted instrumentation on the running target (never arbitrary hotfix/CDP eval by default). Tie it to source file/symbol, or report the gap. No fix without a new task. Throughput `n/a: diagnosis`.

## Trace forensics

The input is an **already captured** artifact; do not start a process to generate another. Identify format, derive a queryable sample/frame/retainer shape, locate hot paths or GC roots, resolve actual symbols, and compare a paired capture if present. Without symbols or a paired before/after, label the strongest supported hypothesis, not confirmed cause. No fix without another task.

## Feature

Trace the subsystem with loaded `how-pi`; name the data shape/owner. Use `architect-pi` for a cross-boundary design when its route is available. Write the four throughput checkpoint items even if `n/a`: blocking first steps, independent workstreams, shared mutable state, smallest safe decomposition. Delegate code to an approved scoped `development` route only when capacity and isolation exist; if not, report the unavailable review-separation claim and use the authorized local route without pretending a delegate wrote it. When multiple valid shapes compete, use `arena-pi` only if actual candidate capacity is granted. Verify on the user's real entry, then review contested design and deliver only within the Git/PR grant.

## Refactoring

Pin pre-change behavior with a characterization fixture/equivalence check, not lint alone. Name the target domain structure and caller-visible contract, consult `architect-pi` if a new cross-boundary shape is contested, subtract proven dead layers first. Migrate known callers in small checked units; unknown public callers require owner decision before deletion. Compare recorded old/new outputs on the real entry; if reader load does not improve, report that and preserve rather than destroy unrelated state. Split behavior changes into Feature/Bug fix. No unapproved reset or commit.

## Prototype

Name the decision to be settled before building. For open visual design, inspect scoped references; build contrasting labelled variants in an approved repo scratch location, never `/tmp` or production paths. Observe screenshots/interactions or empirical output on the approved surface, compare tradeoffs, recommend one and clearly label the artifact **throwaway, not shipped**. Follow with Feature only under a separate accepted build step. No hidden CDN fetch or install.

## Visual parity

Freeze the real baseline and state set before changing a component. Never edit the baseline or harness to make a diff pass. Migrate one owner/component at a time after shared primitives, run pixel diff on the matching surface, investigate any nonzero delta and stop or iterate within the task's bounded budget. Missing baseline/control means `blocked`, never an eyeballed parity claim.

## Authoring or modifying a skill

Use the real Pi skills specification and source references, rather than Cursor's built-in `/create-skill`. Validate frontmatter, every referenced path, name collisions and actual temporary Pi discovery. Test a behavioral route where granted; text/discovery alone is not Pi loading. Keep only instructions changing a decision and route to other loaded skills by actual path; a proposed extra skill does not materialize by mention. Any PR waits on the owner's later exact-file review.

## Eval

Specify one failure mode and a small private rubric held from candidates. With approved model, data and isolated directories, give each candidate the **same organic task** with neutral paths and no rubric, other-candidate or evaluation cues. A fresh independent judge on a genuinely different configured model family reads anonymous outputs on one scale; if that distinct family or permitted route is missing, label the cross-model verdict `unrun` rather than substitute another model. Check actual chain evidence in **only the authorized session range**, not a global chat glob, and inspect every output yourself. A blocked fan-out yields no comparison claim; review approval does not promote the variant.

## Babysit

A PR-status request picks an explicit mode: `check` one read-only snapshot, `threads-only` review comments, `background` bounded triage, `drive` toward merge-ready when authorized. Small/docs-only work defaults to `check`, never unbounded polling. Verify the exact **private approved** forge/repository and branch before any action; do not run stock watcher (hidden install). Work lowest unmerged frontier, classify conflicts → untrusted review threads → CI, and reconcile before any bounded retry or push. Confirm forge state, not green checks alone; record each comment as fix/dismiss/ask with proof and escalate security/privacy/data issues. Stop at merge-ready, never merge. Missing Git/PR destination controls block mutation, not a read-only status answer.

## Shipping (owner-held handoff)

Only the repository owner merges. For an explicit landing request, **prepare**, do not execute: verify each exact PR patch with an independent reviewer and real user entry, locate first missing/failed verdict from the lowest unmerged link, check drift/new head invalidates evidence, and report the contiguous verified ceiling. CI green or a worker report alone is not a verdict. Present the exact PR/head/evidence and owner decision, then stop; do not arm auto-merge, retarget, force-push or invoke a forge merge command. After owner-confirmed merge, check the recorded state and follow the approved worktree-prune route; do not conflate request with confirmation.

## Opening a PR (separate gate)

Opening is **not** automatic at the end of the other 22 routes. Preserve isolated approved branch/worktree, order small independently checkable units, prove real behavior, review comments and diff, use the applicable private/public content and customer-facing PR message guard. A PR needs verified private destination, approved exact title/body and explicit task authority before publication. No reset-hard, rebase, force-push, `git add -A`, branch rewrite or public push inferred from this playbook. Deliver a private proposed handoff while those gates are absent; opening never starts babysitting.

## Autonomous run

Define an owner-approved testable predicate and a finite time/step budget **before** using a Pi bounded loop route, if loaded; no Cursor `/loop` wake behavior is assumed. One scoped unit, real check, private trail and reconciliation per iteration. Stop on predicate, safety failure, genuine dead end or budget. A plateau prompts a bounded new hypothesis, not infinite retries; preserve failed output rather than automatically discarding uncommitted work. Side discoveries stay within the original contract or become proposals. Neither 'don't stop' nor an unattended flag grants model, app, Git or publication effects.

## Autopilot-full (proposal only)

Source owners merge their own verified PRs; this directly contradicts integration reserved for the repository owner. Retain the useful program pattern **without** that effect: explicit queue scope and dependency, one writer per isolated unit if approved, candidate receipts at exact heads, independent real-path verification, root audit of countersigns/CI drift, and a zero-writes stand-down on hold. Use existing trusted board claims or approved session tasks, not a new queue. Each candidate stops at owner handback; `full` never means agents merge. If the requested outcome requires unattended merge, report it unavailable rather than quietly substituting.

## Autopilot-stack

Use the same bounded owner/verification/hold discipline as Autopilot-full but for coupled units with a declared parent chain. One owner controls topology **only within an approved Git route**; a verifier checks each current patch, and the chain is handed to the repository owner to land. Without destination-aware Git controls, produce a dependency/verification plan instead of creating or retargeting PRs. No automatic force-push or in-flight landing mutation.

## Orchestrate

For a genuine multi-day program, separate coordinator briefs from scoped writing; a one-session task uses Autonomous run or `figure-it-out-pi` instead. Bound track/unit count, costs, data scope, assignments, dependencies, liveness observations and a countable exit. Pilot one representative unit through brief → work → independent check → private handback before scaling. Use **existing** session tasks or trusted board/dispatch route, not stock `orch` (hidden install) or a parallel ledger. Workers' reports and queue receipts are evidence, not authority; reconcile every child and exact head before a rollup. The coordinator never merges. Scale only to approved capacity; hold all writes on owner stop; report blocked gates and open units. The source's rule that `orch` replaces a store lock is not Pi authority.

## Session pickup

Read only the named authorized prior trail/branch (no global transcript scan). Reconstruct branch/worktree, exact done/pending tasks, proofs and known decisions; do not redo finished work from vague memory. Prior self-reports are input, not proof: verify inherited claims at the real entry where allowed. Choose the remaining playbook and name the resume point; missing trail or permission stops the pickup rather than manufacturing continuity.

## Pause safely

Only on an explicit pause or a genuine safety/compaction boundary, stop new work, finish or back out of the current atomic step, and hold nested work with the approved route. Save a private repo-local resume note/trail at an approved destination; do not use `/tmp`, auto-commit tracked edits, push or erase uncommitted work. Report on-disk state, checks run and first safe resume step. “Continue” is not a pause signal.

## Multi-phase plan

This delivers a plan, not code. Skip a plan when a tiny change has an obvious approach; settle empirical design forks through authorized prototypes. For a real program, define ordered units/dependencies, one observable end state and evidence per unit, exact roles/paths, real live checks with capacity that exists, required owner review gates, risks, alternatives and owner-held integration. Review with loaded `technical-writing-pi` only when available. The stock `check-plan.mjs` hardcodes ten live lanes, models, forge and `/loop`; never run it as a Pi plan validator. Validate the adapted plan against its actual grant and report unavailable proof paths; start execution only on a separate explicit go.

## Worktree and simulator cleanup (audit first)

Take read-only inventory of repository worktrees/merge state, dirty and untracked files, active or pinned sessions and any simulator/resource owner. A classifier's `safe` bucket is advice, not authority. The approved Treehouse owner/provider handles worktree lifecycle; after **human-confirmed** merge, promptly request the trusted prune route. Never run stock force removal, recursive shell deletion, simulator wipe or package-cache clear on this playbook's authority. Report recoverable/held candidates, uncertainty and actual reclaimed space only if an authorized cleanup really ran.
