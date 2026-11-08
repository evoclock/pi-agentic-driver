# Interactive command confirmations

The generic attended-authority confirmation is off by default. Agents turn it on or off with `agentic_interactive_safeguards_toggle`, passing `enabled: true` or `enabled: false`. The optional TUI **Alt+Shift+S** shortcut flips the same setting and displays its state in the status bar. It does not pause the session with a settings confirmation dialog.

Both controls write the same user-profile file: `$PI_CODING_AGENT_DIR/config/interactive-safeguards.v1.json`. By default, this file lives in the Pi agent config directory. Manual file editing is optional, not the interface. The schema remains `pi-agentic-driver.interactive-safeguards.v1`. Turning the toggle off also clears any saved per-command selections, so all generic prompts return to off.

The package loads `extensions/attended-authority-guard.ts` from `./extensions`. A package resource filter containing `!extensions/attended-authority-guard.ts` excludes the extension and hides both toggle controls and the generic guard. Restart or reload Pi after changing which package extensions load.

The toggle affects only generic confirmations for destructive operations such as Git pushes and file overwrites. It does not turn off merge policy, spawn or approval controls, the raw Herdr shell ban, or other extensions. When enabled, destructive calls in headless sessions refuse to proceed without a native confirmation surface. Chat text and arguments to unrelated tools do not change the toggle. Invalid or unknown profile settings leave confirmations off and produce a warning without exposing file contents. Agent `write`/`edit` calls to the profile config directory are blocked; this is not an operating-system sandbox for arbitrary shell commands.
