---
name: show-me-your-work-pi
description: Keep and audit one evidence-linked decision trail for approved multi-phase work, then present an independently checked Attention section. Use explicitly for a long reviewable run.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Show your work for Pi

Adapted from Lauren Tan's `show-me-your-work`, its six-column TSV template and append-only `scripts/log.sh` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This P47 leaf maps the full pinned run-boundary/TSV/audit method without creating a second writer or automatically executing the stock shell helper. Keep the **single** approved private record for an assignment; existing Markdown records need not be converted to TSV. No transcript access, reviewer or Git commit follows from reading a skill.

## One append-only decision trail

Before starting, identify the approved, version-controlled **private** evidence destination and single writer; if none exists, stop a long run rather than invent a hidden `.audit` file. The source defaults to untracked `decisions.tsv`/`.audit/<task>.tsv` and commits only for complex reviewer-needed work. Here commit only within the owner's separately approved scope; an ignored artifact is not version-controlled evidence. Keep a decision/checkpoint/pivot/failed gate row as it happens, not every tool call or a retrospective green story. Record timestamp, phase, decision, plain **why**, resolving evidence pointer and actual result (`INCONCLUSIVE`/`open` included); retain run identity and exact artifact/revision. If the owner selects TSV, use the pinned header `ts\tphase\tdecision\twhy\tevidence\tresult`, one physical line per row, neutralize tabs/newlines/CR and any cell with a leading (including leading-whitespace) spreadsheet formula prefix `=`, `+`, `-`, `@`. The stock `log.sh` writes header, UTC time and sanitizes immediate-prefix cells but is **not** bundled or invoked; do not assume it handles leading whitespace. An existing approved Markdown trail may carry the same fields without a format change.

A run is one agent conversation including later turns; a replacement agent or new chat is a new run. On pickup read last entries; if another run wrote since, add a fresh `start` boundary naming the prior timestamp range and this actual run ID. Never claim concurrent Markdown/TSV appends are safe without single-writer ownership. Correct a wrong/invented row by appending a superseding entry with accurate pointer, never by rewriting history. Preserve an abandoned fork, retry or gate change that affected the result.

## Audit and independent attention

Before handback, name and obtain access to **this run's actual transcript and bounded range**. Audit only this run's stretches, bounded by its `start` rows, against decisions/actions, resolvable evidence and omitted pivots; do not glob unrelated Pi or Cursor chats. If transcript access is absent, audit only permitted tool/evidence results and say transcript-versus-trail audit `unrun`. Give the exact approved trail and transcript range to a fresh configured `independent-review` context **distinct from the author** via `/skill:setup-pstack-pi`, but only with model/data/route/budget grant. It checks weak evidence, skipped checks and risky scope pivots, not a new implementation. Without it, independent attention review is `blocked`, never “no flags”. A report is evidence, not approval.

Hand back a short **Attention** section naming actual reviewer findings with specific row/moment pointers, saying `no flags` **only after** an actual independent review that found none, or explicitly stating review was not performed. The source's model-name reporting is replaced by the configured **role** in owner-facing copy; do not publish provider identity. Show exact completed/unrun checks and safe next step. Do not auto-file board items, launch a worker, edit skills or push the trail because the source method mentions review.

- **Positive BDD:** Given an approved long task, single-writer private trail, accessible named transcript and distinct authorized reviewer, when Pi appends decisions and audits only this run's rows then reviewer spots weak proof, then the handback cites exact artifact, corrected append-only history and attributed Attention findings.
- **Refusal BDD:** Given no evidence destination, transcript grant, reviewer identity/data route or owner Git scope, when auditing, independent review or committing would need it, then mark that phase `blocked`/`unrun`, keep existing records intact and do not invent a TSV log, transcript check, independent verdict or commit.

Pi discovering this file is not an audited run, a cross-model review or a real Pi session journey.
