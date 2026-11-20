# Codex skill bridge

PAD exports locally installed pack skills as Codex-discoverable wrappers. It never installs packages, starts agents, or writes Codex authentication or configuration. Run from this repository:

```sh
node scripts/codex_skills.mjs --codex-home /absolute/fixture-or-approved-home
node scripts/codex_skills.mjs --codex-home /absolute/fixture-or-approved-home --apply
```

The first command previews only. `--pack poteto-mode|agent-skill-vault|statechart|bowerbird` selects one pack; by default all four are selected. The sources are `~/repos/pi-poteto-mode-agents/skills`, `~/repos/agent-skill-vault-agents/skills`, `~/repos/pi-poteto-mode-agents/skills/statechart-pi`, and `~/repos/pi-bowerbird/skills/bowerbird`. These must remain available: wrappers link to source instructions and references rather than copying them. No pack repository is modified. Each wrapper is at `$CODEX_HOME/skills/pad-<source-name>/SKILL.md`; existing differing skill files are backed up before replacement. The exporter refuses symlinked destination directories/files and home paths containing `.` or `..`; repeated or trailing separators are normalized. Source skills with `disable-model-invocation: true` also produce `agents/openai.yaml` with `policy.allow_implicit_invocation: false`. Duplicate references to the same source skill are deduplicated; distinct sources with the same skill name are rejected. Apply writes through temporary files and atomic rename, makes collision-safe backups for differing files, and reports completed and failed paths on partial failure. No operation on the operator's real `~/.codex` was performed for this change.

**Format evidence (local Codex CLI):** `codex skills --help` shows no `skills` command (prints top-level help). The installed Codex `.system/skill-installer/SKILL.md` says installs land at `$CODEX_HOME/skills/<skill-name>`, with an `SKILL.md` in each directory. The installed `.system/skill-installer/SKILL.md` has YAML frontmatter with `name` and `description`. The local `~/.codex/skills` contains `.system/skill-installer/SKILL.md` and other `.system` skill folders. Only directory names and that non-secret installer documentation were inspected; auth/history/config contents were not read.

Treehouse is invoked through `~/.local/bin/treehouse`. Bowerbird is invoked via `node ~/repos/pi-bowerbird/bin/bowerbird.mjs <action> <file>` or its npm bin; `--help` gives CLI options. Pi-only tools in the original skills are not assumed to exist in Codex. If a step needs a Pi tool (including Herdr spawn or communication), mark it blocked; never substitute raw Herdr CLI, send-keys or a cloud agent. The statechart wrapper points to the installed Pi adaptation and its installed-only TLC checker, not the upstream auto-install flow. The wrappers do not grant permission for their source skills' external effects. For packs with deeply Pi-specific instructions, a separate Codex-native rewrite would require pack-owner review; this bridge preserves the source instructions and explicitly disclaims Pi tools.

## Deferred

A PAD MCP server may later expose PAD capabilities to Codex-driver users. It is not part of this PR: this exporter only prepares skill files and returns a list of planned or applied file actions, so a future adapter can call it without coupling installation to an MCP transport. No MCP server, registration, or configuration is installed here.
