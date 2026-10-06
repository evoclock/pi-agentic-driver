// SPDX-License-Identifier: AGPL-3.0-only
// Deliberately exits without closing the fixture at a named durable/effect boundary.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDurableAssignmentFixture, openDurableSeamStore } from "../../scripts/enforcement/durable_assignment_pi.js";
import { submitAsyncDispatch } from "../../scripts/enforcement/herdr_async_seam_pi.js";
const [directory, crashAt] = process.argv.slice(2);
if (crashAt.startsWith("after-submission-") || crashAt.startsWith("after-delivery-")) {
  const store = await openDurableSeamStore({ directory });
  const runProcess = async ({ argv }) => {
    const action = argv[1];
    if (action === "read") return { code: 0, stdout: "offline history" };
    if (action === "prompt") appendFileSync(join(directory, "sent.log"), "sent\n");
    return { code: 0, stdout: JSON.stringify({ type: action === "prompt" ? "agent_prompted" : "agent_info",
      agent: { name: argv[2], agent: "pi", status: action === "prompt" ? "working" : "idle", repository: process.cwd() } }) };
  };
  await submitAsyncDispatch({ role: "worker", prompt: "offline crash seam" }, { cwd: process.cwd() }, {
    offlinePersistence: store, runProcess,
    offlineBoundary: async (name, value) => {
      if (name === "after-submission-intent") writeFileSync(join(directory, "receipt.json"), JSON.stringify(value));
      if (name === crashAt) process.exit(73);
    },
  });
  process.exit(74); // Missing boundary is a failed test, not implicit success.
}
const fixture = await openDurableAssignmentFixture({
  directory,
  transport: {
    schema: "fixture.fake-transport.v1",
    async send() { appendFileSync(join(directory, "sent.log"), "sent\n"); return { deliveryId: "delivery-1" }; },
    async observe() { return { roleState: "idle" }; },
  },
  boundary: async (name, value) => {
    if (name === "after-admit") writeFileSync(join(directory, "receipt.json"), JSON.stringify(value));
    if (name === crashAt) process.exit(73);
  },
});
await fixture.admit({ requestId: "request-1", assignmentId: "assignment-1", envelopeRef: "fixture-envelope", artifact: "fixture-head", role: "worker", brief: "offline test", scope: ["fixture"] });
fixture.resume();
setTimeout(() => process.exit(74), 5000);
