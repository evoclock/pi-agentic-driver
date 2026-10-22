// SPDX-License-Identifier: AGPL-3.0-only
// Deliberately exits without closing the fixture at a named durable/effect boundary.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDurableAssignmentFixture, openDurableSeamStore } from "../../../scripts/enforcement/durable_assignment_pi.js";
import { submitAsyncDispatch } from "../../../scripts/enforcement/herdr_async_seam_pi.js";
import { runWorkerJourney } from "../../../scripts/enforcement/herdr_async_dispatch_pi.js";
const [directory, crashAt] = process.argv.slice(2);
if (crashAt === "extension-sessions") {
  process.env.HOME = directory;
  const extension = (await import("../../../extensions/herdr-dispatch.ts")).default;
  const setup = async () => {
    const tools = [], shutdown = [];
    await extension({ registerTool: (tool) => tools.push(tool), on: (name, handler) => { if (name === "session_shutdown") shutdown.push(handler); } });
    return { dispatch: tools.find((tool) => tool.name === "agentic_worker_dispatch"), shutdown };
  };
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const first = await setup();
  const second = await setup();
  const one = SessionManager.inMemory(process.cwd());
  const two = SessionManager.inMemory(process.cwd());
  const ctx = (manager) => ({ cwd: process.cwd(), sessionManager: manager });
  const list = (tool, manager) => tool.execute("fixture", { action: "journeys" }, undefined, undefined, ctx(manager));
  const a = await list(first.dispatch, one);
  const b = await list(second.dispatch, two);
  if (!a.details.ok || !b.details.ok || one.getSessionId() === two.getSessionId()) process.exit(70);
  const conflict = await list(second.dispatch, one);
  if (conflict.details.ok || conflict.details.code !== "journey-store-unavailable") process.exit(71);
  for (const close of first.shutdown) await close();
  const retried = await list(second.dispatch, one);
  if (!retried.details.ok) process.exit(72);
  for (const close of second.shutdown) await close();
  process.stdout.write(JSON.stringify([one.getSessionId(), two.getSessionId()]));
  process.exit(0);
}
if (crashAt.startsWith("journey-")) {
  const store = await openDurableSeamStore({ directory });
  let history = "fixture history";
  const runProcess = async ({ argv }) => {
    const [action, role] = [argv[1], argv[2]];
    if (action === "get") return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: role, agent: "pi", status: "idle", repository: process.cwd() } }) };
    if (action === "prompt") {
      appendFileSync(join(directory, "sent.log"), "sent\n");
      history += `\n${argv[3]}\n[WORKER_REPORT_BEGIN]\nresult\n[WORKER_REPORT_END]`;
      writeFileSync(join(directory, "pane-history.txt"), history);
      return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: role, agent: "pi", status: "done", repository: process.cwd() } }) };
    }
    if (action === "read") return { code: 0, stdout: history };
    throw new Error("unexpected fixture action");
  };
  await runWorkerJourney({ action: "dispatch", role: "worker", stepPrompt: "fixture", journeyId: "fixture-run", maxSteps: 1 },
    { cwd: process.cwd(), mode: "tui", hasUI: true, ui: { confirm: async () => true } },
    { journeyStore: store, runProcess, taskStore: { list: () => [{ id: "fixture-task", status: "pending" }] },
      journeyBoundary: async (name) => { if (`journey-${name}` === crashAt) process.exit(73); } });
  process.exit(74);
}
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
