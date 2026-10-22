import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { openDurableSeamStore } from "../../../scripts/enforcement/durable_assignment_pi.js";
import { registerOutwardEffectInterface } from "../../../scripts/enforcement/outward_effect_pi.js";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const store = await openDurableSeamStore({ directory: config.directory, orphanWaitMs: 100 });
const tools = new Map();
registerOutwardEffectInterface({ registerTool: (tool) => tools.set(tool.name, tool) }, {
  getJourneyStore: () => store,
  repositoryProof: () => true,
  ghExecutable: config.gh,
  boundary: (phase) => {
    if (phase === config.killAt) process.kill(process.pid, "SIGKILL");
    if (phase === "after-effect" && config.offlineAfterEffect) {
      if (config.request.action === "push") renameSync(config.remote, `${config.remote}.offline`);
      else {
        const state = JSON.parse(readFileSync(config.statePath, "utf8"));
        state.failGetOnce = true;
        writeFileSync(config.statePath, JSON.stringify(state));
      }
    }
  },
});
const tool = tools.get("agentic_journey_outward_effect");
const output = await tool.execute("outward-fixture", config.request, undefined, undefined, {
  cwd: config.cwd,
  mode: "tui", hasUI: true,
  ui: { confirm: async () => true },
});
console.log(JSON.stringify(output.details));
await store.close();
