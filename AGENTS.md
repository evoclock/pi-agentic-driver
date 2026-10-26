# Agent guidance for pi-agentic-driver

This file is the fleet source of truth for how bots and Pi workers must control Herdr. Fleet assistant skills mirror it; they do not replace it.

## Herdr / Pi tab spawn (HARD)

- **Only path:** spawn Pi tabs and panes through this driver's `agentic_herdr_spawn_worker` tool (Pi **herdr** spawn — spelling **herdr**, never "herder").
- **Forbidden:** raw `herdr agent start`, other bare Herdr CLI that starts agents, ad-hoc Mac Shell that bypasses the driver, Cursor cloud VMs, or assistant-box compute for this work.
- **Enforcement:** the attended-authority bash guard refuses `herdr agent start` fail-closed with no confirmation path. Use `agentic_herdr_spawn_worker` only.
- **Default model:** the operator-named default Pi model until the operator names another model for that run.
- **Placement:** new tab or right/below pane in a trusted-registry repo root (not an unmanaged worktree). The worker creates its own Treehouse worktree from inside that root when needed.
- **Confirmation:** use the driver's native confirmation / ledger grant path; do not invent a parallel spawn surface.

See the shipped-features table and the herdr-lifecycle section in [README.md](./README.md) for tool behavior and constraints.

## Related

- Treehouse: create leases from the repo root with `treehouse get --lease --base main --branch <name>`; recycle when the PR merges or closes.
- Stuck-chase / stall recovery for Pi runs lands alongside this guidance when present on the branch.
