// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 provider extension (§5 reversibility): the board surface registers
// only when a real board file is observed in the workspace. No board file,
// no behavior change and no new tool.

import { existsSync } from "node:fs";
import { join } from "node:path";

// Documented board locations (design §2): workspace-level Obsidian Kanban
// Markdown, or vogelkop's simpler TASKS.md shape.
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
  const boardPath = resolveBoardPath(pi?.ctx?.cwd);
  if (boardPath === null) {
    return { registered: [], observation: { present: false, boardPath: null } };
  }
  return module.registerKanbanBoardTools(pi, { boardPath });
}
