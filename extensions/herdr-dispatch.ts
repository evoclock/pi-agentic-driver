// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

async function herdrDispatchCore(pi) {
  const dispatch = await import(new URL("../scripts/enforcement/herdr_async_dispatch_pi.js", import.meta.url).href);
  const lifecycle = await import(new URL("../scripts/enforcement/herdr_lifecycle_pi.js", import.meta.url).href);

  // Production replacement seam: an unresponsive-session handoff spawns through the
  // existing guarded herdr-lifecycle boundary only — executeHerdrSpawnWorker
  // performs native confirmation, trusted-repository resolution, installed
  // model-roll resolution, fixed argv, and shell:false. No raw pane/agent
  // management is added; the receipt is observed state, never authority.
  const spawnReplacement = ({ role, repository, model, context, signal }) =>
    lifecycle.executeHerdrSpawnWorker(
      {
        placement: "tab",
        role,
        model,
        repository,
      },
      context,
      {},
      signal,
    );

  return dispatch.registerWorkerDispatchInterface(pi, { spawnReplacement });
}

// Async transport seam (vogelkop phase #47): submit returns a versioned,
// non-authorizing receipt immediately; poll/observe/read are separate
// single-attempt operations. No retries, no resends, no authority.
export default async function herdrDispatchPi(pi) {
  await herdrDispatchCore(pi);
  const asyncSeam = await import(new URL("../scripts/enforcement/herdr_async_seam_pi.js", import.meta.url).href);
  return asyncSeam.registerAsyncDispatchInterface(pi);
}
