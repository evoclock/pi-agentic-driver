// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export default async function taskBoardPi(pi) {
  const module = await import(new URL("../scripts/enforcement/task_board_projection_pi.js", import.meta.url).href);
  return module.registerTaskBoardInterface(pi);
}
