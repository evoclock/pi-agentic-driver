// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 provider extension (§5 reversibility): both board tools register
// unconditionally at startup; board resolution happens per tool call from
// the calling workspace's cwd. No board file for the calling workspace
// yields a structured board-unavailable result — no behavior change, nothing
// created.

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
  // The ExtensionAPI carries no ctx at registration time (ctx is
  // per-tool-call), so registration is unconditional and each execute()
  // resolves the board from its own ctx.cwd, falling back to process.cwd().
  return module.registerKanbanBoardTools(pi, {
    resolveBoardPath: (ctx) => resolveBoardPath(ctx?.cwd || process.cwd()),
  });
}
