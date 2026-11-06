// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";

export default async function attendedAuthorityGuard(pi) {
  const module = await import(new URL("../scripts/enforcement/attended_authority_guard.js", import.meta.url).href);
  return module.registerAttendedAuthorityGuard(pi, { existsSync });
}
