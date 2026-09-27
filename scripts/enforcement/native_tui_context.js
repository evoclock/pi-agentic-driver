// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Public native-TUI context predicate shared by the shipped enforcement
// interfaces. Restriction-gated actions stay fail-closed: anything that is
// not an interactive native Pi TUI with a native confirm callback is denied.
export function isNativeTuiContext(context) {
  return context?.mode === "tui"
    && context?.hasUI === true
    && typeof context?.ui?.confirm === "function";
}

// Attended Electron main-process context predicate. This is a SEPARATE,
// explicit context class for a trusted non-TUI host (the Electron main
// process) that owns a native owner-confirmation capability of its own. It
// is deliberately not a Pi TUI representation: the mode token differs, so an
// attended-Electron context NEVER satisfies isNativeTuiContext and a TUI
// context NEVER satisfies this predicate. Restriction-gated TUI actions
// continue to deny it; only the explicit attended-Electron driver boundary
// accepts it.
export const ATTENDED_ELECTRON_CONTEXT_MODE = "electron-attended";

export function isAttendedElectronContext(context) {
  return context?.mode === ATTENDED_ELECTRON_CONTEXT_MODE
    && context?.hasUI === true
    && typeof context?.ui?.confirm === "function";
}
