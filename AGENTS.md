# Agent guidance for pi-agentic-driver

This file is the fleet source of truth for how bots and Pi workers must control Herdr. Fleet assistant skills mirror it; they do not replace it.

## Herdr / Pi tab spawn (HARD)

- **Only path:** spawn Pi tabs and panes through this driver's `agentic_herdr_spawn_worker` tool (Pi **herdr** spawn — spelling **herdr**, never "herder").
- **Forbidden:** all raw Herdr CLI from a bot shell, including agent start, prompt, read, wait and pane send-keys; ad-hoc shell control bypasses the driver.
- **Enforcement:** the attended-authority bash guard refuses raw Herdr CLI fail-closed with no confirmation path. Use `agentic_herdr_spawn_worker` for spawns and `agentic_herdr_communication` for bounded exchanges.
- **Default model:** the operator-named default Pi model until the operator names another model for that run.
- **Placement:** new tab in a trusted-registry repo root, or an exact Git worktree target with an active Treehouse lease. Coordinator pane splits are not worker tabs.
- **Spawn boundary:** after this change is installed in a fresh Pi process, ordinary spawns need no grant or dialog. Repository, model, role, workspace, lease and read-back checks still apply. Never infer permission from a task list, chat role or claimed identity.

## Spawn outcomes and rollout (HARD)

- Use the guarded tool and check its observed result. `spawned` means the adapter verified agent and pane read-backs. `partial` means a layout or agent may exist; do not retry or close it automatically. A prompt delivery is not a finished worker report.
- Keep merge owner-held. Feature-branch pushes and review PRs require the existing outward-effect checks; a successful spawn does not authorize them.
- The separately attended Electron boundary still has its native confirmation. Do not fake that host context or send keys to answer any existing dialog.
- This source change does not update an already-running Pi process or the installed driver. Until the reviewed replacement is installed and verified in a fresh process, the old unattended-spawn grant requirement remains in force. Never send a prompt to a pane waiting on an old spawn dialog.

See the shipped-features table and the herdr-lifecycle section in [README.md](./README.md) for tool behavior and constraints.

## Fleet coordination (opt-in)

Coordinator bots that adopt this guidance can use these practices. They are not HARD rules or hook-enforced checks.

- When asking for a decision, recommend one option and explain the tradeoff in plain language. Do not send bare options.
- Store any coordinator-created bot-control rule, assignment template, or automation in an approved Git repository. A skill or session memory alone is not a durable control record. Keep private configuration out of commits.
- If a status report is hard to follow, rewrite it in plain human voice with a writing-review tool when available (for example, `/bro` or `agentic_aidr`). Shortening jargon is not a substitute for explaining the result.

These are semantic writing and provenance checks, not reliable command-pattern checks. A hook cannot determine whether a recommendation is useful, prose is understandable, or a control artifact exists only in memory.

## Related

- Treehouse: create leases from the repo root with `treehouse get --lease --base main --branch <name>`; recycle when the PR merges or closes.
- Stuck-chase / stall recovery for Pi runs lands alongside this guidance when present on the branch.
