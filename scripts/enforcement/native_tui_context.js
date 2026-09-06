// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Public native-TUI context predicate shared by the shipped enforcement
// interfaces. Restriction-gated actions stay fail-closed: anything that is
// not an interactive native Pi TUI with a native confirm callback is denied.
export function isNativeTuiContext(context) {
  return context?.mode === "tui"
    && context?.hasUI === true
    && typeof context?.ui?.confirm === "function";
}
