# Fleet Herdr spawn rule

**HARD (fleet-wide):** anything that controls bots encodes this in git here, not only in assistant skills.

- Pi tabs/panes: **only** `agentic_herdr_spawn_worker` / Pi **herdr** spawn (spelling **herdr**).
- Never raw Herdr CLI from a bot shell, including agent start, prompt, read, wait, and pane send-keys. The attended-authority guard refuses those bash forms fail-closed. Use `agentic_herdr_communication` for bounded exchanges.
- Repository pre-registration is disabled: start a guarded worker directly in a canonical owner-eligible sibling checkout. The registration tool is a no-op and never asks for confirmation or writes the worker registry. Spawn still verifies Git identity, owner eligibility, model and pane readbacks. Ordinary Pi spawns in a fresh installed process require no individual grant; draft Codex spawns require an account- and kind-scoped grant. Start a fresh Pi process after installation to load the updated tool.
- Default Pi model: the operator-named default until the operator names another.
- Agent guidance template: [templates/AGENTS.md](../templates/AGENTS.md).

The guarded Pi spawn tool also accepts an explicit existing Herdr workspace ID or label when called without a coordinator pane; with a coordinator pane it uses that pane's workspace. The spawn path verifies the target checkout, workspace and resulting pane/agent; a partial result is not a successful spawn. Prompts hand a brief to a queue; `delivery` observes whether a correlated answer has settled, and delivery alone is not completed work. The [evidence-first delivery workflow skill](../skills/evidence-first-delivery-workflow/SKILL.md) contains inactive plans and a static validator, **not** a scheduler, runtime guard or authority to act. No native cross-framework execution hook is claimed here.
