// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

export default async function loopUntilDonePi(pi) {
  const module = await import(new URL("../scripts/enforcement/loop_until_done_pi.js", import.meta.url).href);
  return module.registerLoopUntilDone(pi);
}
