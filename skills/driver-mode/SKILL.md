---
name: driver-mode
description: Route explicit Agentic Driver jobs to their driver playbooks. Use only for shipping, project knowledge, Ralph, clean-room, release, board, lesson-harvest, or weekly-recap requests.
---

# Driver mode

Use this index only when the request explicitly names a driver job. Ordinary coding, research, and writing stay on the ordinary route. This index routes work; it does not grant permission or prove a destination is installed.

## Driver job routes

| Driver job | Request | Destination |
|---|---|---|
| `ship` | Take a change to a review PR or merge-ready stop. | Load the driver's `ship` playbook. Stop at `merge-ready` unless the repo policy opts into merge. |
| `project-knowledge` | Build or update the cited project knowledge pack. | Load `project-knowledge`; cite every claim to its source. |
| `ralph` | Run a bounded Ralph iteration. | Load `ralph`; work on one item and honor the caps. |
| `clean-room` | Study a tool, capture an oracle, then replace it. | Load `clean-room`; keep study separate from the build. |
| `release-to-public` | Prepare a public release. | Use the existing `release-public` procedure. Do not publish a package. |
| `board-run` | Run work explicitly selected from the board. | Use the native `tasks` and `pulse` skills; do not route ordinary work through the board. |
| `harvest-lessons` | Review recorded corrections. | Use the native `harvest-lessons` skill. |
| `weekly-recap` | Prepare the weekly build recap. | Use the native `weekly-build-recap` skill; do not post it. |

## Shared method

For generic engineering steps inside a driver job, call `/skill:poteto-mode` and name the matching playbook or skill when it is installed. Do not copy its instructions into this package. If `pi-poteto-mode` or a required method is unavailable, report `skip: <name> unavailable`; continue only when the remaining work does not depend on it.

If the request does not match one of these jobs, do not start a board, lifecycle, release, or Ralph workflow. Ordinary work is the default (P16).
