# Interactive command confirmations

The generic attended-authority confirmation is off by default. Agents turn it on or off with `agentic_interactive_safeguards_toggle`, passing `enabled: true` or `enabled: false`. The optional TUI **Alt+Shift+S** shortcut flips the same setting and displays its state in the status bar. It does not pause the session with a settings confirmation dialog.

Both controls write the same user-profile file: `$PI_CODING_AGENT_DIR/config/interactive-safeguards.v1.json`. Manual file editing is optional, not the interface. The schema remains `pi-agentic-driver.interactive-safeguards.v1`. Turning the toggle off also clears any saved per-command selections, so all generic prompts return to off.

The package loads `extensions/attended-authority-guard.ts` from `./extensions`. A package resource filter containing `!extensions/attended-authority-guard.ts` excludes the extension and hides both toggle controls and the generic guard. Restart or reload Pi after changing which package extensions load.

The toggle affects only generic confirmations for destructive operations such as Git pushes and file overwrites. It does not turn off merge policy, spawn or approval controls, the raw Herdr shell ban, or other extensions. When enabled, destructive calls in headless sessions refuse to proceed without a native confirmation surface. Chat text and arguments to unrelated tools do not change the toggle. Invalid or unknown profile settings leave confirmations off and produce a warning without exposing file contents. Agent `write`/`edit` calls to the profile config directory are blocked; this is not an operating-system sandbox for arbitrary shell commands.

## Profile configuration and boundaries

exclude it when you need interactive confirmations. See
[interactive safeguards](docs/interactive-safeguards.md) for use and limits.

Turning the toggle off clears any saved per-command selections as well as the
package-wide switch. The stored profile also supports two levels:

- To enable this package's generic interactive confirmation for every destructive
  tool call, set `enableAllInteractiveConfirmations` to `true`.
- To enable it only for selected commands, leave that value `false` and list
  simple shell command prefixes in `enabledCommands`, for example `"git push"`.
  A `git push` entry includes its flags and arguments, including forced pushes;
  other commands do not ask. Chained commands, pipelines, redirects, and shell
  substitutions never match a per-command entry. `"write"` and `"edit"` can
  enable confirmations for those Pi tools separately.

```json
{
  "schema": "pi-agentic-driver.interactive-safeguards.v1",
  "enableAllInteractiveConfirmations": false,
  "enabledCommands": ["git push"]
}
```

Both settings are optional; `false` and an empty list are the defaults. The
profile must have the exact schema, a boolean for the package-wide switch, and
an array of at most 32 unique, lower-case, simple command names (up to four
words each). Unknown keys, bad types, unreadable files, and malformed JSON
leave confirmations off; the guard shows a warning without printing profile
contents. A missing file uses the default without a warning.

This setting changes **only** the generic attended-authority confirmation. It
does not disable the merge policy, approval-ledger restrictions, the raw Herdr
shell ban, other extension safeguards, or CI/merge gates. When confirmations
are enabled, headless destructive calls still fail closed. Agent `write` and
`edit` calls to the user profile's `config/` directory are always blocked to
protect the opt-in settings. Keep the final checks and review gates in CI.
Only the dedicated toggle tool, the TUI shortcut, or direct user profile
editing changes the setting. Ordinary chat text and unrelated tool arguments
cannot opt in. This guard blocks agent `write` and `edit` calls to profile
config, but is not a shell sandbox.
