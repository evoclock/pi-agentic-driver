# Agent guidance for pi-agentic-driver

This file is the fleet source of truth for how bots and Pi workers must control Herdr. Fleet assistant skills mirror it; they do not replace it.

## Herdr / Pi tab spawn (HARD)

- **Only path:** spawn Pi tabs and panes through this driver's `agentic_herdr_spawn_worker` tool (Pi **herdr** spawn — spelling **herdr**, never "herder").
- **Forbidden:** all raw Herdr CLI from a bot shell, including agent start, prompt, read, wait and pane send-keys; ad-hoc shell control bypasses the driver.
- **Enforcement:** the attended-authority bash guard refuses raw Herdr CLI fail-closed with no confirmation path. Use `agentic_herdr_spawn_worker` for spawns and `agentic_herdr_communication` for bounded exchanges.
- **Default model:** the operator-named default Pi model until the operator names another model for that run.
- **Placement:** new tab or right/below pane in a trusted-registry repo root (not an unmanaged worktree). The worker creates its own Treehouse worktree from inside that root when needed.
- **Confirmation:** use the driver's native confirmation / ledger grant path; do not invent a parallel spawn surface.

## Unattended spawns need a ledger grant (HARD)

Without `authority.ledgerId`, `agentic_herdr_spawn_worker` always opens the native "Spawn Herdr worker" Yes/No dialog in the calling Pi pane (`scripts/enforcement/herdr_lifecycle_pi.js`, the `context.ui.confirm` branch). The dialog has no timeout, so an unattended request waits on the operator indefinitely. The operator does not want these dialogs.

- **Never** prompt an existing Pi pane to call `agentic_herdr_spawn_worker` without a covering `authority.ledgerId`. That surfaces an operator dialog; it is not an automatic spawn.
- **Never** fake the confirmation: no synthetic `ui.confirm` that returns true, no hand-built TUI or attended-Electron context, no hand-written approval record.
- **Never** send `agentic_herdr_communication` prompt or submit to a pane whose tool call is waiting on a dialog. The delivered text ends with Enter, and the highlighted option is Yes, so the prompt would accept the spawn on the operator's behalf. Leave the pane alone and report it.
- **Automatic path:** a Tier 1 standing spawn approval in the active profile ledger (see [docs/relay-authority.md](./docs/relay-authority.md)), recorded by a configured relayer with the writer CLI outside a guarded Pi session, then passed as `authority: { ledgerId }`. This needs `config/relay-authority.v1.json` in the active profile. Only the operator creates that file. If it is missing, stop and report a needs-owner setup step. Do not spawn.
- Before any unattended spawn, check coverage read-only with `agentic_relay_check_request`. If it is not covered, report needs-owner and do not call spawn.

| Rule | Enforced by |
|---|---|
| Never escalate the "Spawn Herdr worker" confirmation into a chat or tracker Decision, Accept card or Accept widget, and never ask the owner to Accept a spawn. | `scripts/enforcement/spawn_ceremony_check.mjs` (rules `owner-accept-spawn`, `spawn-decision-card`); `tests/test_spawn_ceremony_check.mjs` |
| Never answer, accept or dismiss a spawn confirmation with raw herdr `send-keys` (including `cli:agent:send-keys`). Raw herdr is banned; driver tools only. | Check rule `send-keys-spawn-confirm`; attended-authority bash guard for raw herdr |
| Leave a stuck Yes/No spawn confirmation alone. Only the owner answers it (No is the safe answer); agents never send it Enter or a prompt. | Check rule `accept-spawn-dialog`; this file |
| An unattended spawn passes `authority: { ledgerId }` covering repository, model and role. Without one, report needs-owner. Never forge approvals or relay config mid-flight. | Check rule `unattended-spawn-without-ledger`; `approval_ledger_pi.js` refuses uncovered grants |
| A brief that asks a pane to call `agentic_herdr_spawn_worker` carries the covering `authority.ledgerId`; a bare spawn-call brief opens the owner dialog. | Check rule `brief-spawn-without-ledger` (replay fixture `tests/fixtures/spawn-ceremony/spawn-request-replay.txt`) |
| Spawn only into the target repository's own registered root, never through another repository's pane. | Registry check in `herdr_lifecycle_pi.js`; this file |

Spawns that looked automatic in the past were not ledger-backed. They were TUI Yes clicks (about 30–60 s after the call) or raw `send-keys` answers (under a second). No spawn has passed `authority.ledgerId` so far. Treat a fast spawn as evidence of a banned path, not as a working automatic path.

Run the check with `node scripts/enforcement/spawn_ceremony_check.mjs [paths...]`. The default paths are AGENTS.md, skills, templates and docs. Run it on any brief before you deliver it.

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
