---
name: crew-tracker-sync
description: >-
  Use when an orchestrator must keep a team tracker current every check: every
  open PR (draft or ready), every bot stream, and every human unblock (decisions
  and steps), from live agent and source-control evidence — not only when the
  human responds.
---
# Crew tracker sync

Keep a human's tracker current from structured evidence, not chat prose. Every run reconciles the tracker's data file against live sources. Completeness is the product: if the human has to ask whether an open PR or unblock is on the tracker, the last run failed.

## Inputs (set by the routine or repo config, not here)
- `tracker_data`: path to the tracker's data file, e.g. `data.json`. Validate its core sections against [`tracker-data.schema.json`](tracker-data.schema.json); other site-specific fields can coexist.
- `publish_cmd`: the build and deploy command(s) for the tracker site.
- `agents`: the agents/bots whose work the tracker covers, and how to read their latest reports.
- `scm_query`: the source-control search for the owner's open and recently merged PRs (must cover every owned repo, not a shortlist).
- `responses_store`: where the human's tracker answers (accept, reject, comment, tick) are saved.
- `snapshot_dir`: where dated snapshots of the data file are committed. This is a repo path, so history isn't just chat prose.

## Data shape (tracker_data)
- `streams`: one row per agent: `[agent, area, current work (with time), next for the human]`.
- `merges`: `[title, repo, owner agent, state]`. state is one of `draft (<age>)`, `ready`, `merged <time>`, `closed <time>`, or `blocked <why>`.
- `decisions`: `{state: open|settled, title, text, recommendation, why, phone_ok: bool, owner, meta: time}`.
- `steps`: human-only unblocks, `{text, done, meta}`. meta says when the step is parked and why (e.g. needs a desk or terminal).
- `settled`: decided items, with the time and who carried them out.
- `merge_note`: reminds that only ready, green PRs move to Your steps.

## Completeness invariants (every run)
These are hard requirements. A run that skips them is wrong even if it republishes.
1. **Every open PR** returned by `scm_query` has exactly one `merges` row. Drafts count. Age (or opened time) is on the state string. Umbrella rows do not replace per-PR rows.
2. **Recently merged or closed** PRs (last day) update their row; a matching "Merge …" step is marked done with the time.
3. **Every agent** in `agents` has a stream row with a time, current work, and an honest "next for the human" ("Nothing right now" only when truly nothing).
4. **Every human unblock** is either an open decision (needs a yes/no or choice) or a step (needs an action). Phone-doable items are marked `phone_ok` / not parked; desk/terminal items say parked and why. Ready+green PRs appear on Your steps; drafts never do.
5. **Stale open decisions** the human already answered, or that no longer apply, are settled or removed so the human never answers an obsolete question.
6. A missing human response is never a reason to skip reconcile or publish.

## Each run
1. **Gather evidence.** Read each agent's latest report and recent activity. Read live process or job state where you have access. List **all** open PRs and PRs merged or closed in the last day with the source-control connector (`scm_query`). Read the human's saved responses and note the newest `at` already handled.
2. **Apply the human's responses first.** An accept, reject or comment on a decision is the human's own decision, so relay it verbatim to the owning agent and move the item to settled. A ticked step is marked done. Ask the human only if an entry is ambiguous.
3. **Reconcile each section against the invariants above.** Edit `tracker_data` in place (never rewrite the file from scratch).
4. **Diff.** Compare the reconciled data with the last published copy. If nothing differs, stop.
5. **Publish and snapshot.** Run `publish_cmd`, then write a dated snapshot to `snapshot_dir` (`YYYY-MM-DD/HHMM.json`) plus a one-line change note, for the repo to commit.
6. **Report.** Log one line: open-PR count vs merges rows, what changed, and any completeness gap found and fixed this run. Message the human only when a result they're waiting on lands or something **new** needs their decision — but the tracker itself must already show the full picture without that message.

## Rules
- Never invent state. Every line traces to an agent report, a job or process reading, or a PR record.
- Use the human's local time zone, labelled.
- Never print secrets, and never change the tracker site's access settings.
- Keep each decision to one question, with a recommendation and why.
- Prefer surfacing an unblock on the tracker over waiting for the human to ask whether something exists.
