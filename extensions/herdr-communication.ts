// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default async function herdrCommunicationPi(pi) {
  const moduleUrl = new URL("../scripts/enforcement/herdr_communication_pi.js", import.meta.url);
  // Native ESM retains transitive modules across Pi's Jiti extension reload.
  // Bind this import to the current file revision so /reload cannot reuse it.
  moduleUrl.searchParams.set("mtime", String(statSync(fileURLToPath(moduleUrl)).mtimeMs));
  const module = await import(moduleUrl.href);
  return module.registerHerdrCommunicationInterface(pi);
}
