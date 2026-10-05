// SPDX-License-Identifier: AGPL-3.0-only
// Deliberately exits without closing the fixture at a named durable/effect boundary.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDurableAssignmentFixture } from "../../scripts/enforcement/durable_assignment_pi.js";
const [directory, crashAt] = process.argv.slice(2);
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
