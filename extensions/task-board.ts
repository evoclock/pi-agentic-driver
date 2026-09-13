// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 provider extension. Both tools register at startup; the board is
// resolved per tool call from the calling session's working directory. A
// workspace with no board file gets a structured board-unavailable result —
// nothing is created and nothing else changes.

import { existsSync } from "node:fs";
import { join } from "node:path";

const BOARD_FILENAMES = ["board.md", "TASKS.md"];

export function resolveBoardPath(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  for (const name of BOARD_FILENAMES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export default async function taskBoardPi(pi) {
  const module = await import(new URL("../scripts/enforcement/task_board_core_pi.js", import.meta.url).href);
  return module.registerKanbanBoardTools(pi, { resolveBoardPath });
}
