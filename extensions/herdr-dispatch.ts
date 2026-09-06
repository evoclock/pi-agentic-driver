// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export default async function herdrDispatchPi(pi) {
  const module = await import(new URL("../scripts/enforcement/herdr_async_dispatch_pi.js", import.meta.url).href);
  return module.registerWorkerDispatchInterface(pi);
}
