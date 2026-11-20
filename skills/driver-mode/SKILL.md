---
name: driver-mode
description: Route explicit Agentic Driver jobs to their driver playbooks. Use only for shipping, project knowledge, Ralph, clean-room, release, board, lesson-harvest, weekly-recap, or model-fidelity requests.
---

# Driver mode

Use this index only when the request explicitly names a driver job. Ordinary coding, research, and writing stay on the ordinary route. This index routes work; it does not grant permission or prove a destination is installed.

## Steps

1. Decide whether the request explicitly names a driver job. If not, stay on the ordinary route.
2. Find the matching destination in the table. If an optional route is absent, report it rather than substituting another workflow.
3. Follow the installed route only within its own scope and permission boundary.

## Driver job routes

| Driver job | Request | Destination |
|---|---|---|
| `ship` | Take a change to a review PR or merge-ready stop. | Load `ship` if installed; otherwise report that this route is unavailable. |
| `project-knowledge` | Build or update the cited project knowledge pack. | Load `project-knowledge` if installed; otherwise report that this route is unavailable. |
| `ralph` | Run a bounded Ralph iteration. | Load `ralph`; work on one item and honor the caps. |
| `clean-room` | Study a tool, capture an oracle, then replace it. | Load `clean-room` if installed; otherwise report that this route is unavailable. |
| `release-to-public` | Prepare a public release. | Use `release-public` if installed; otherwise report that this route is unavailable. Do not publish a package. |
| `board-run` | Run work explicitly selected from the board. | Use the native `tasks` and `pulse` skills; do not route ordinary work through the board. |
| `harvest-lessons` | Review recorded corrections. | Use the native `harvest-lessons` skill. |
| `weekly-recap` | Prepare the weekly build recap. | Use the native `weekly-build-recap` skill; do not post it. |
| `model-fidelity` | Compare a built change with its original plan and model assumptions. | Load `model-fidelity`. Only prepare, diagram and read are currently callable; keep other stages as caller-owned steps. |

## Shared method

For generic engineering steps inside a driver job, call `/skill:poteto-mode` only if installed and name the matching playbook or skill. Do not copy its instructions into this package. If `pi-poteto-mode` or a required method is unavailable, report `skip: <name> unavailable`; continue only when the remaining work does not depend on it.

If the request does not match one of these jobs, do not start a board, lifecycle, release, or Ralph workflow. Ordinary work is the default.

## Limits

This routing index is guidance, not a runtime guard. It never loads a missing route automatically or grants permission for effects.
