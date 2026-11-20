// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default async function herdrCommunicationPi(pi) {
  const moduleUrl = new URL("../scripts/enforcement/herdr_communication_pi.js", import.meta.url);
  // Native ESM retains transitive modules across Pi's Jiti extension reload.
  // Bind this import to the current file revision so /reload cannot reuse it.
  moduleUrl.searchParams.set("mtime", String(statSync(fileURLToPath(moduleUrl)).mtimeMs));
  const module = await import(moduleUrl.href);
  // The worker endpoint calls ctx.abort(), the same in-process handler as
  // Escape. No terminal input or Herdr abort verb is involved.
  const workerUrl = new URL("../scripts/enforcement/worker_abort_pi.js", import.meta.url);
  workerUrl.searchParams.set("mtime", String(statSync(fileURLToPath(workerUrl)).mtimeMs));
  const worker = await import(workerUrl.href);
  worker.registerWorkerAbortListener(pi);
  return module.registerHerdrCommunicationInterface(pi);
}
