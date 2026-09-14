// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerHerdrLifecycleInterface } from "../scripts/enforcement/herdr_lifecycle_pi.js";

export default function herdrLifecyclePi(pi) {
  return registerHerdrLifecycleInterface(pi);
}
