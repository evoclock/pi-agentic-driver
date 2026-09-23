// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerAsyncDispatchInterface,
  submitAsyncDispatch,
  pollAsyncDispatch,
  observeAsyncDispatch,
  readAsyncDispatch,
  resetAsyncDispatchStoreForTests,
  ASYNC_DISPATCH_SCHEMA,
  ASYNC_RECEIPT_SCHEMA,
  ASYNC_TERMINAL_STATES,
} from "../scripts/enforcement/herdr_async_seam_pi.js";
import { registerHerdrCommunicationInterface } from "../scripts/enforcement/herdr_communication_pi.js";

const root = process.cwd();

function fixture({ status = "idle", report = "step report", failPrompt = false, failRead = false } = {}) {
  const calls = [];
  let prompted = false;
  let agentStatus = status;
  const runProcess = async ({ argv }) => {
    const [action, role] = [argv[1], argv[2]];
    calls.push({ action, role, argv: [...argv] });
    if (action === "get") {
      return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: role, agent: "pi", status: agentStatus, repository: root } }) };
    }
    if (action === "prompt") {
      if (failPrompt) return { code: 2, stdout: "", stderr: "agent hung up" };
      prompted = true;
      return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: role, agent: "pi", status: "working", repository: root } }) };
    }
    if (action === "read") {
      if (failRead) return { code: 0, stdout: "terminal text with no report markers" };
      const echoed = calls.filter((call) => call.action === "prompt").length
        ? "echo"
        : "";
      return {
        code: 0,
        stdout: `${echoed ? `${echoed}\n` : ""}[WORKER_REPORT_BEGIN]\n${report}\n[WORKER_REPORT_END]`,
      };
    }
    throw new Error(`unexpected action: ${action}`);
  };
  return { calls, runProcess, prompted: () => prompted, set status(value) { agentStatus = value; } };
}

function context() {
  return { cwd: root };
}

test.beforeEach(() => resetAsyncDispatchStoreForTests());

test("the async seam registers exactly one new tool", () => {
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool.name) };
  registerAsyncDispatchInterface(pi);
  registerHerdrCommunicationInterface(pi);
  assert.deepEqual(registered, ["agentic_worker_dispatch_async", "agentic_herdr_communication"]);
});

test("the herdr-dispatch extension default export registers both dispatch tools", async () => {
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool.name) };
  const extension = await import("../extensions/herdr-dispatch.ts");
  await extension.default(pi);
  assert.ok(registered.includes("agentic_worker_dispatch"));
  assert.ok(registered.includes("agentic_worker_dispatch_async"));
});

test("submit returns a receipt immediately without waiting for settlement", async () => {
  const f = fixture();
  const submitted = await submitAsyncDispatch({ role: "worker", prompt: "progress the sequence" }, context(), { runProcess: f.runProcess });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.promptSent, true);
  assert.equal(submitted.duplicate, false);
  const receipt = submitted.receipt;
  assert.equal(receipt.schema, ASYNC_RECEIPT_SCHEMA);
  assert.equal(receipt.driverSchema, ASYNC_DISPATCH_SCHEMA);
  assert.equal(receipt.role, "worker");
  assert.equal(receipt.state, "submitted");
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.returnedWithoutWaiting, true);
  assert.equal(typeof receipt.acceptedAt, "string");
  assert.equal(submitted.nonAuthorizing, true);
  assert.equal(submitted.authorityCreated, false);
  assert.equal(submitted.persisted, false);
  // No wait command, no read: the receipt precedes settlement observation.
  assert.ok(f.calls.every((call) => call.action !== "wait"));
  assert.ok(f.calls.every((call) => call.action !== "read"));
  // One prompt argv without --wait.
  const promptCall = f.calls.find((call) => call.action === "prompt");
  assert.ok(promptCall);
  assert.ok(!promptCall.argv.includes("--wait"));
  assert.deepEqual(promptCall.argv.slice(-2), ["--timeout", "15000"]);
});

test("an identical submit returns the original receipt without a duplicate prompt", async () => {
  const f = fixture();
  const first = await submitAsyncDispatch({ role: "worker", prompt: "same brief" }, context(), { runProcess: f.runProcess });
  assert.equal(first.duplicate, false);
  assert.equal(first.promptSent, true);
  const second = await submitAsyncDispatch({ role: "worker", prompt: "same brief" }, context(), { runProcess: f.runProcess });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.promptSent, false);
  assert.equal(second.receipt.submissionId, first.receipt.submissionId);
  assert.equal(second.receipt.acceptedAt, first.receipt.acceptedAt);
  assert.equal(f.calls.filter((call) => call.action === "prompt").length, 1, "no duplicate prompt may be sent");
});

test("concurrent identical submits reserve before the await and prompt once", async () => {
  let releasePrompt;
  const promptGate = new Promise((resolve) => { releasePrompt = resolve; });
  const f = fixture();
  const runProcess = async (request) => {
    if (request.argv[1] === "prompt") await promptGate;
    return f.runProcess(request);
  };
  const firstPromise = submitAsyncDispatch({ role: "worker", prompt: "same concurrent brief" }, context(), { runProcess });
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await submitAsyncDispatch({ role: "worker", prompt: "same concurrent brief" }, context(), { runProcess });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.status, "in-flight");
  assert.equal(duplicate.inFlight, true);
  assert.equal(duplicate.receipt.accepted, false);
  assert.equal(duplicate.promptSent, false);
  releasePrompt();
  const first = await firstPromise;
  assert.equal(first.receipt.submissionId, duplicate.receipt.submissionId);
  assert.equal(f.calls.filter((call) => call.action === "prompt").length, 1);
});

test("poll observes state as a separate operation and never prompts or reads", async () => {
  const f = fixture();
  const submitted = await submitAsyncDispatch({ role: "worker", prompt: "x" }, context(), { runProcess: f.runProcess });
  f.status = "working";
  f.calls.length = 0;
  const polled = await pollAsyncDispatch({ submissionId: submitted.receipt.submissionId }, context(), { runProcess: f.runProcess });
  assert.equal(polled.ok, true);
  assert.equal(polled.state, "working");
  assert.equal(polled.terminal, false);
  assert.deepEqual(f.calls.map((call) => call.action), ["get"], "poll is a single get observation");
});

test("observe is a separate get-only operation", async () => {
  const f = fixture({ status: "idle" });
  const submitted = await submitAsyncDispatch({ role: "worker", prompt: "x" }, context(), { runProcess: f.runProcess });
  f.calls.length = 0;
  const observed = await observeAsyncDispatch({ submissionId: submitted.receipt.submissionId }, context(), { runProcess: f.runProcess });
  assert.equal(observed.ok, true);
  assert.equal(observed.state, "completed");
  assert.equal(observed.terminal, true);
  assert.deepEqual(f.calls.map((call) => call.action), ["get"]);
});

test("read returns the latest marked report and normalizes terminal states", async () => {
  const f = fixture({ status: "idle", report: "final journey report" });
  const submitted = await submitAsyncDispatch({ role: "worker", prompt: "x" }, context(), { runProcess: f.runProcess });
  f.calls.length = 0;
  const read = await readAsyncDispatch({ submissionId: submitted.receipt.submissionId }, context(), { runProcess: f.runProcess });
  assert.equal(read.ok, true);
  assert.equal(read.report, "final journey report");
  assert.equal(read.reportMarkers.open, "[WORKER_REPORT_BEGIN]");
  assert.equal(read.reportMarkers.close, "[WORKER_REPORT_END]");
  assert.deepEqual(f.calls.map((call) => call.action), ["read"]);
});

test("read fails closed as report-not-ready when no complete report exists", async () => {
  const f = fixture({ failRead: true });
  const submitted = await submitAsyncDispatch({ role: "worker", prompt: "x" }, context(), { runProcess: f.runProcess });
  f.calls.length = 0;
  const read = await readAsyncDispatch({ submissionId: submitted.receipt.submissionId }, context(), { runProcess: f.runProcess });
  assert.equal(read.ok, false);
  assert.equal(read.code, "report-not-ready");
  assert.deepEqual(f.calls.map((call) => call.action), ["read"], "exactly one read attempt, no retry");
});

test("terminal failure: a failed submission is explicit and stores nothing", async () => {
  const f = fixture({ failPrompt: true });
  const submitted = await submitAsyncDispatch({ role: "worker", prompt: "x" }, context(), { runProcess: f.runProcess });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.status, "blocked");
  assert.equal(submitted.receipt, undefined);
  // A later poll cannot observe a submission that was never accepted.
  const polled = await pollAsyncDispatch({ submissionId: "sub-nonexistent" }, context(), { runProcess: f.runProcess });
  assert.equal(polled.ok, false);
  assert.equal(polled.code, "unknown-submission");
  assert.equal(f.calls.filter((call) => call.action === "prompt").length, 1, "one failed submission is never retried or resent");
});

test("the in-memory store retains 64 submissions rather than 32 map entries", async () => {
  const f = fixture();
  const receipts = [];
  for (let index = 0; index < 65; index += 1) {
    const submitted = await submitAsyncDispatch({ role: "worker", prompt: `brief-${index}` }, context(), { runProcess: f.runProcess });
    receipts.push(submitted.receipt);
  }
  const oldest = await pollAsyncDispatch({ submissionId: receipts[0].submissionId }, context(), { runProcess: f.runProcess });
  assert.equal(oldest.ok, false);
  assert.equal(oldest.code, "unknown-submission");
  const second = await pollAsyncDispatch({ submissionId: receipts[1].submissionId }, context(), { runProcess: f.runProcess });
  assert.equal(second.ok, true);
});

test("poll and read reject unknown submission ids without any Herdr call", async () => {
  const f = fixture();
  for (const operation of [pollAsyncDispatch, observeAsyncDispatch, readAsyncDispatch]) {
    const result = await operation({ submissionId: "" }, context(), { runProcess: f.runProcess });
    assert.equal(result.ok, false);
    assert.equal(result.code, "submission-id-required");
    const unknown = await operation({ submissionId: "sub-unknown" }, context(), { runProcess: f.runProcess });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "unknown-submission");
  }
  assert.deepEqual(f.calls, [], "no Herdr traffic may occur for unknown submissions");
});

test("normalized lifecycle states cover terminal and non-terminal sets", () => {
  assert.deepEqual([...ASYNC_TERMINAL_STATES], ["completed", "exhausted", "review_requested", "failed", "cancelled"]);
});

test("a brief exceeding the bounded prompt size fails closed without any Herdr call", async () => {
  // The transport enforces MAX_PROMPT_BYTES (32 KiB) including the mandatory
  // report contract; the seam must surface that as a typed fail-closed result
  // with no process spawn and no submission stored.
  const f = fixture();
  const oversizedBrief = "x".repeat(33 * 1024);
  const submitted = await submitAsyncDispatch({ role: "worker", prompt: oversizedBrief }, context(), { runProcess: f.runProcess });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.code, "prompt_oversized");
  assert.equal(submitted.status, "denied");
  assert.equal(submitted.receipt, undefined);
  assert.equal(submitted.nonAuthorizing, true);
  assert.equal(submitted.authorityCreated, false);
  assert.deepEqual(f.calls, [], "no Herdr traffic may occur for an oversized brief");
  // Nothing was stored: a later poll on any id finds no live submission.
  const polled = await pollAsyncDispatch({ submissionId: "sub-anything" }, context(), { runProcess: f.runProcess });
  assert.equal(polled.ok, false);
  assert.equal(polled.code, "unknown-submission");
});

test("the registered tool executes the full submit-then-poll-then-read flow", async () => {
  const f = fixture();
  const tools = [];
  const pi = { registerTool: (tool) => tools.push(tool) };
  registerAsyncDispatchInterface(pi, { runProcess: f.runProcess });
  const tool = tools[0];
  const submitted = await tool.execute("id", { action: "submit", role: "worker", prompt: "x" }, undefined, undefined, context());
  assert.equal(submitted.details.ok, true);
  f.status = "working";
  const polled = await tool.execute("id", { action: "poll", submissionId: submitted.details.receipt.submissionId }, undefined, undefined, context());
  assert.equal(polled.details.state, "working");
});
