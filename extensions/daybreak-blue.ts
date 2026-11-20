// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { registerDaybreakBlue } from "../scripts/enforcement/daybreak_blue_pi.js";

export default function daybreakBlueExtension(pi: any) {
  registerDaybreakBlue(pi);
}
