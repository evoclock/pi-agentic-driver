import test from "node:test";
import assert from "node:assert/strict";
import { WORKER_DISPATCH_PARAMETERS, registerWorkerDispatchInterface, runWorkerJourney } from "../scripts/enforcement/herdr_async_dispatch_pi.js";

// Why: private journey modes must not appear in the model-callable contract.
test("worker dispatch publishes no autonomous parameters or guidance", () => {
  const tools = [];
  registerWorkerDispatchInterface({ registerTool: (tool) => tools.push(tool) });
  const tool = tools[0];
  assert.equal(WORKER_DISPATCH_PARAMETERS.properties.autonomy, undefined);
  assert.equal(WORKER_DISPATCH_PARAMETERS.properties.cast, undefined);
  assert.doesNotMatch([tool.description, tool.promptSnippet, ...tool.promptGuidelines].join(" "), /autonom|overnight|cast/i);
});

// Why: bypassing the published schema must still fail before any worker starts.
test("autonomous arguments are refused unless the non-model option enables them", async () => {
  let starts = 0;
  const options = { spawnReplacement: () => { starts++; } };
  for (const input of [{ autonomy: "autonomous" }, { cast: { roles: ["worker"] } }]) {
    const result = await runWorkerJourney({ action: "dispatch", role: "worker", stepPrompt: "x", ...input }, {}, options);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /not available yet/);
  }
  assert.equal(starts, 0);
});
