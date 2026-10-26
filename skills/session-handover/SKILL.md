---
name: session-handover
description: Write and consume a source-indexed, fixed-shape session handover once.
---

# Session handover

This is the only handover producer in this repository. No other skill here writes a handover. The external `*-pi` skill copies are not changed or retired in this slice. The existing `skills/how/WORKFLOW_BOUNDARIES.md` guidance to extend the owner's handover remains guidance, not a producer.

Prepare a JSON object with exactly these keys in order: `goal`, `next_fix_plan_item`, `changed_files`, `state`, `next_step`, `open_items`, `decisions`, `Rejected`. Each value is an array of claims; `goal`, `next_fix_plan_item` and `next_step` each have exactly one claim. Use `Rejected` for tried and dropped approaches, with reasons; use an empty array if none. A claim is `{"label":"derived","text":"...","pointer":"file:line"}`. Labels: `quoted`, `derived`, `unknown`, `conflicting`. Pointers: repository file and existing line, locally available full commit SHA, or a JSONL session file under the root with `#entry=<exact id>@<sha256 of the full entry line including newline>`. Remote URLs are rejected because local validation cannot verify them. Claims are navigation, never approval or authority. Do not put secrets into the handover.

Write the sections to a new `HANDOVER.json` with `python3 scripts/session_handover.py write HANDOVER.json --input sections.json`. Optionally append `--check <command> <args>` to execute one check and write a separate `.checks.json` local observation containing command, exit code, HEAD commit and handover digest. Imported handover `checks` must be empty. The sidecar is not signed proof and `validate` never certifies its provenance; independently confirm checks before relying on them. Validate with `python3 scripts/session_handover.py validate HANDOVER.json`. The next session calls `python3 scripts/session_handover.py consume HANDOVER.json` before acting; this creates an exclusive `.consumed` marker. A second consumer fails. Keep both files; use a new path for each handover. This script does not start sessions or wire context pressure, crash recovery, or external loop consumers.

Behavioral fixtures run in the existing Python tests of `make gate`: `python3 -m unittest tests/test_session_handover.py`. They reject a missing `Rejected` section, an uncited claim, a nonexistent file line, and a second consume.
