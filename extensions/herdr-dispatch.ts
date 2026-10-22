// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { createTaskStore } from "../lib/task-store-adapter.ts";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

async function herdrDispatchCore(pi) {
  const stores = new Map();
  const getJourneyStore = (context) => {
    const sessionId = context?.sessionManager?.getSessionId?.();
    if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error("stable Pi session ID required for durable dispatch");
    }
    if (!stores.has(sessionId)) {
      const pending = (async () => {
        const directory = join(realpathSync(homedir()), ".pi", "agentic-driver-dispatch", "sessions", sessionId);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (realpathSync(directory) !== directory) throw new Error("canonical dispatch store required");
        const { openDurableSeamStore } = await import(new URL("../scripts/enforcement/durable_assignment_pi.js", import.meta.url).href);
        return openDurableSeamStore({ directory });
      })();
      stores.set(sessionId, pending);
      pending.catch(() => { if (stores.get(sessionId) === pending) stores.delete(sessionId); });
    }
    return stores.get(sessionId);
  };
  pi.on?.("session_shutdown", async () => {
    const opened = [...stores.values()];
    stores.clear();
    await Promise.all(opened.map(async (pending) => { try { await (await pending).close(); } catch { /* Open may already have failed. */ } }));
  });
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

  // A fresh read-only session view per journey; registration remains keyed
  // on the real Pi API identity for the enforcement module's dedupe guard.
  const outward = await import(new URL("../scripts/enforcement/outward_effect_pi.js", import.meta.url).href);
  outward.registerOutwardEffectInterface(pi, { getJourneyStore });
  return dispatch.registerWorkerDispatchInterface(pi, { spawnReplacement, taskStoreFactory: createTaskStore, getJourneyStore });
}

// Async transport seam: submit returns a versioned,
// non-authorizing receipt immediately; poll/observe/read are separate
// single-attempt operations. No retries, no resends, no authority.
export default async function herdrDispatchPi(pi) {
  await herdrDispatchCore(pi);
  const asyncSeam = await import(new URL("../scripts/enforcement/herdr_async_seam_pi.js", import.meta.url).href);
  return asyncSeam.registerAsyncDispatchInterface(pi);
}
