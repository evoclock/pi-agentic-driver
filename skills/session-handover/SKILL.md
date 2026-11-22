---
name: session-handover
description: Use when write and consume a source-indexed, fixed-shape session handover once.
---

# Session handover

Use this skill to hand off one session's state without confusing navigation with approval. The repository script is the handover producer; it does not start sessions.

## Steps

1. Prepare a JSON object with exactly these keys in order: `goal`, `next_fix_plan_item`, `changed_files`, `state`, `next_step`, `open_items`, `decisions`, `Rejected`. Each value is an array of claims. `goal`, `next_fix_plan_item` and `next_step` have exactly one claim. Record dropped approaches with reasons in `Rejected`, or an empty array.
2. Give each claim `{"label":"derived","text":"...","pointer":"file:line"}`. Labels are `quoted`, `derived`, `unknown` and `conflicting`. Use an existing repository file and line, a locally available full commit SHA, or a JSONL session entry under the root with `#entry=<exact id>@<sha256 of the full entry line including newline>`. Remote URLs cannot be validated locally. Never include secrets or present a claim as authority.
3. Write a new handover with `python3 scripts/session_handover.py write HANDOVER.json --input sections.json`. Optionally use `--check <command> <args>` for a separate `.checks.json` observation. The sidecar is not signed proof; imported handover checks must be empty.
4. Validate with `python3 scripts/session_handover.py validate HANDOVER.json`. In the next session, consume it once with `python3 scripts/session_handover.py consume HANDOVER.json` before acting. Keep the exclusive `.consumed` marker and use a new path for another handover.
5. In a private source checkout, run the repository-only session-handover unit suite to check rejection of missing sections, uncited claims and duplicate consumption. The unit suite is not bundled with this skill.

## Limits

The script enforces shape, local source pointers and one-time consumption. It does not validate sidecar provenance, start a session or grant authority; independent check review remains guidance.
