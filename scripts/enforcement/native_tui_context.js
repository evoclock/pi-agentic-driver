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

// Electron main-process context predicate. This is a SEPARATE, explicit
// context class for the trusted non-TUI host. Spawn needs no UI callback;
// the mode token remains disjoint from the native Pi TUI predicate.
// Restriction-gated TUI actions continue to deny this context.
export const ATTENDED_ELECTRON_CONTEXT_MODE = "electron-attended";

export function isAttendedElectronContext(context) {
  return context?.mode === ATTENDED_ELECTRON_CONTEXT_MODE;
}
