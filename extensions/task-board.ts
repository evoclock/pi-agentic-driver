// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 provider extension. Both tools register at startup; the board is
// resolved per tool call from the calling session's working directory. A
// workspace with no board file gets a structured board-unavailable result —
// nothing is created and nothing else changes.

import { existsSync } from "node:fs";
import { join } from "node:path";

// The canonical file comes first: the projection (board.md) is a derived
// view and must never be the board the tools operate on.
const BOARD_FILENAMES = ["TASKS.md", "board.md"];

// Returns the board path for the workspace: an existing board file if one is
// present, otherwise the canonical TASKS.md candidate (the write tool
// bootstraps a fresh board there). Null only when the workspace is unknown.
export function resolveBoardPath(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  for (const name of BOARD_FILENAMES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(cwd, "TASKS.md");
}

export default async function taskBoardPi(pi) {
  const module = await import(new URL("../scripts/enforcement/task_board_core_pi.js", import.meta.url).href);
  return module.registerKanbanBoardTools(pi, {
    resolveBoardPath: (ctx) => resolveBoardPath(typeof ctx === "string" ? ctx : ctx?.cwd || process.cwd()),
  });
}
