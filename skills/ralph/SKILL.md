---
name: ralph
description: Use when run one bounded fix-plan item per iteration with acceptance, plateau and handover checks.
---

# Ralph

Use this skill for one bounded fix-plan item per iteration. Plan before building; acceptance is an observed check, not a progress claim.

## Steps

1. Record independently acceptable ordered items in `fix_plan.md` and `fix_plan.json`. Each JSON item has a unique `id`, `work` and `accept` argv arrays, `fanout` depth/nodes/concurrency and a `sections` path. Search for prior work. Give every acceptance check a reason; no placeholders.
2. Set positive `ralph-budget.json` integers with `depth`, `nodes` and `concurrency` at most 1, `iterations` at most 100 and `wall_seconds` at most 3600. Use only declared zero-fan-out commands; this script cannot police commands that spawn children.
3. Call `python3 scripts/ralph.py --plan fix_plan.json --state ralph-state.json --budget ralph-budget.json` once per iteration. Work and acceptance commands run sequentially for the first unfinished item. Only acceptance exit zero completes it. After two failures with no decrease in remaining items, stop at `gave up`.
4. Provide source-indexed sections in the `session-handover` format. The runner creates a handover after each attempt. Before the next iteration, consume the previous handover with `python3 scripts/session_handover.py consume handoff/ralph-N.json`. Treat a handover as navigation, not permission.
5. On an interrupted intent, inspect the intent, work and handover instead of replaying an uncertain effect. Do not delete held intent as a retry. Do not use this script for outward effects, automatic commits, pushes or destructive rollback. Run `make gate` and `make test-gate` before any approved commit.
6. Report the item, its check and the next action. The closed outcomes are `completed`, `review requested`, `changes requested`, `blocked`, `crashed`, `timed out` and `gave up`. `review requested` belongs to external review, not this runner. In a private source checkout, check local behavior with the repository-only Ralph unit suite.

## Limits

The script enforces declared budget caps, sequential work and acceptance, intent and handover. It cannot enforce arbitrary child fan-out, independent review or runtime worker claims. Those parts remain guidance or belong to a separate host.
