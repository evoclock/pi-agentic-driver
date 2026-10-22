import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { recycleAllPools, TREEHOUSE_ROOT } from "../scripts/enforcement/treehouse_recycle_pi.js";

// Scans every pool under the Treehouse root after session start and
// periodically, so PR closure/merge is detected without touching the dispatch
// path. No activity occurs at extension load.
export function createTreehouseRecycleExtension(
  recycle = recycleAllPools,
  rootForSession = async () => TREEHOUSE_ROOT,
  schedule = setInterval,
  cancel = clearInterval,
) {
  return function (pi: ExtensionAPI) {
    let timer: ReturnType<typeof setInterval> | undefined;
    let busy = false;
    let active = false;
    let generation = 0;
    const check = async () => {
      if (busy || !active) return;
      busy = true;
      const started = generation;
      try {
        const root = await rootForSession();
        if (active && started === generation && root) await recycle({ treehouseRoot: root, shouldContinue: () => active && started === generation });
      } catch (error) {
        console.error("Treehouse recycling held:", error);
      } finally { busy = false; }
    };
    pi.on("session_start", () => {
      if (active) return;
      active = true;
      void check();
      const { pollIntervalMs } = JSON.parse(readFileSync(new URL("../config/treehouse.v1.json", import.meta.url), "utf8"));
      timer = schedule(() => { void check(); }, pollIntervalMs);
      timer.unref?.();
    });
    pi.on("session_shutdown", () => {
      active = false;
      generation++;
      if (timer) cancel(timer);
      timer = undefined;
    });
  };
}

export default createTreehouseRecycleExtension();
