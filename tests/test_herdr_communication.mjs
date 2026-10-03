import test from "node:test";
import assert from "node:assert/strict";
import {
  executeHerdrCommunication,
  executeHerdrPromptExchange,
  extractLatestHerdrReport,
  findUnconfirmedDelivery,
  resetHerdrDeliveriesForTests,
  TRUSTED_HERDR_EXECUTABLE,
} from "../scripts/enforcement/herdr_communication_pi.js";

function info(role, status = "idle", seq = 1, type = "agent_info") {
  return { code: 0, stdout: JSON.stringify({ type, agent: { name: role, agent: "pi", status, state_change_seq: seq, repository: root } }) };
}
function exchangeFixture({ role = "reviewer", pre = "history", report = "report-reviewer", statuses = ["idle", "idle"], promptFailure, recovery } = {}) {
  const calls = []; let sent; let reads = 0; let gets = 0;
  const runProcess = async ({ executable, argv, shell, spawnOptions }) => {
    const action = argv[1]; calls.push({ action, argv: [...argv] });
    if (action === "get") { const status = statuses[Math.min(gets++, statuses.length - 1)]; return recovery && gets > 2 ? recovery : info(role, status, 1); }
    if (action === "prompt") { sent = argv[3]; return promptFailure || info(role, "done", 2, "agent_prompted"); }
    if (action === "read") { reads += 1; return { code: 0, stdout: reads === 1 ? pre : `${pre}\n${sent}\n${markerPair(role)[0]}\n${report}\n${markerPair(role)[1]}` }; }
    throw new Error(action);
  };
  return { calls, runProcess };
}


const root = process.cwd();
const roles = ["reviewer", "reviewer-foo", "foo-reviewer"];

test.beforeEach(() => resetHerdrDeliveriesForTests());

function markerPair(role) {
  if (role === "reviewer") return ["[REVIEW_REPORT_BEGIN]", "[REVIEW_REPORT_END]"];
  const label = role.toUpperCase().replaceAll("-", "_");
  return [`[${label}_REPORT_BEGIN]`, `[${label}_REPORT_END]`];
}

function concurrentFixture() {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const readsByRole = new Map();
  const runProcess = async ({ executable, argv, shell, spawnOptions }) => {
    assert.equal(executable, TRUSTED_HERDR_EXECUTABLE);
    assert.equal(shell, false);
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.cwd, root);
    assert.ok(Object.isFrozen(argv));
    assert.ok(Object.isFrozen(spawnOptions));
    assert.ok(Object.isFrozen(spawnOptions.env));
    const [action, role] = [argv[1], argv[2]];
    calls.push({ action, role, argv: [...argv] });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, role === "reviewer" ? 12 : role === "reviewer-foo" ? 4 : 8));
    try {
      if (action === "get") {
        return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: role, agent: "pi", status: "idle", repository: root } }) };
      }
      if (action === "prompt") {
        return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: role, agent: "pi", status: "done", repository: root } }) };
      }
      if (action === "read") {
        const promptCount = calls.filter((call) => call.action === "prompt" && call.role === role).length;
        const [open, close] = markerPair(role);
        if (promptCount === 0) return { code: 0, stdout: "history" };
        const lastPrompt = calls.filter((call) => call.action === "prompt" && call.role === role).at(-1);
        const echoed = String(lastPrompt.argv?.[3] ?? "");
        return { code: 0, stdout: `history\n${echoed}\n${open}\nfresh-${role}\n${close}` };
      }
      throw new Error(`unexpected action: ${action}`);
    } finally {
      active -= 1;
    }
  };
  return { calls, runProcess, get maximumActive() { return maximumActive; } };
}

test("Herdr communication isolates concurrent marked exchanges", async () => {
  const fixture = concurrentFixture();
  const results = await Promise.all(roles.map((role) => executeHerdrPromptExchange(
    { action: "prompt", role, prompt: "perform one bounded exchange", timeoutMs: 1000 },
    { cwd: root },
    { runProcess: fixture.runProcess },
  )));

  assert.ok(fixture.maximumActive > 1);
  assert.equal(fixture.calls.length, roles.length * 5);
  for (const [index, role] of roles.entries()) {
    const result = results[index];
    assert.equal(result.ok, true);
    assert.equal(result.invocationCount, 1);
    assert.equal(result.waitCount, 1);
    assert.equal(result.readCount, 1);
    assert.equal(result.report, `fresh-${role}`);
    const calls = fixture.calls.filter((call) => call.role === role);
    assert.deepEqual(calls.map((call) => call.action), ["get", "read", "get", "prompt", "read"]);
    assert.deepEqual(calls.find((call) => call.action === "get").argv, ["agent", "get", role]);
    assert.deepEqual(calls.find((call) => call.action === "read").argv, [
      "agent", "read", role, "--source", "recent-unwrapped", "--lines", "400", "--format", "text",
    ]);
    const prompt = calls.find((call) => call.action === "prompt").argv;
    assert.equal(prompt[0], "agent");
    assert.equal(prompt[1], "prompt");
    assert.equal(prompt[2], role);
    assert.match(prompt[3], /Return exactly one complete role report/);
    assert.doesNotMatch(prompt[3], /MANDATORY ATOMIC EXECUTION CONTRACT|acceptance-checked step|Remain strictly read-only/);
    assert.equal(prompt[4], "--wait");
    assert.deepEqual(prompt.slice(5), [
      "--until", "idle", "--until", "done", "--until", "blocked",
    ]);
  }

  const deniedRole = await executeHerdrCommunication(
    { action: "get", role: "coordinator" },
    { cwd: root },
    { runProcess: fixture.runProcess },
  );
  assert.equal(deniedRole.ok, false);
  assert.equal(deniedRole.code, "target_role_denied");

  // Prompt freshness: a caller-supplied prompt that pre-formats the report
  // contract is refused — the transport owns contract framing, and a stale
  // pre-formatted prompt could otherwise bind a later exchange to old scope.
  const preformatted = await executeHerdrCommunication(
    { action: "prompt", role: "reviewer", prompt: "do it\nReturn exactly one complete role report, and no additional report, bounded by these literal markers: [REVIEW_REPORT_BEGIN] [REVIEW_REPORT_END]", timeoutMs: 100 },
    { cwd: root },
    { runProcess: fixture.runProcess },
  );
  assert.equal(preformatted.ok, false);
  assert.equal(preformatted.code, "prompt_preformatted");
  assert.equal(fixture.calls.filter((call) => call.action === "prompt").length, roles.length, "no additional prompt was sent with preformatted contract text");

  const deniedRepository = await executeHerdrCommunication(
    { action: "get", role: "reviewer" },
    { cwd: root },
    { runProcess: async ({ argv }) => ({
      code: 0,
      stdout: JSON.stringify({ type: "agent_info", agent: { name: argv[2], agent: "pi", status: "idle", repository: "/tmp/untrusted-herdr-repository" } }),
    }) },
  );
  assert.equal(deniedRepository.ok, false);
  assert.equal(deniedRepository.code, "repository_mismatch");

  const failedRead = await executeHerdrCommunication(
    { action: "read", role: "reviewer" },
    { cwd: root },
    { runProcess: async () => ({ code: 2, stdout: "", stderr: `fixture stderr: unavailable ${"x".repeat(5000)}` }) },
  );
  assert.equal(failedRead.ok, false);
  assert.equal(failedRead.code, "herdr_process_failed");
  assert.match(failedRead.diagnostic, /fixture stderr: unavailable/);
  assert.ok(Buffer.byteLength(failedRead.diagnostic, "utf8") <= 4096);
  assert.equal(failedRead.nonAuthorizing, true);
});

test("a valid report longer than 400 lines is recovered with one expanded read and no prompt resend", async () => {
  const role = "long-review";
  const [open, close] = markerPair(role);
  const body = Array.from({ length: 600 }, (_, index) => `finding-${index}`).join("\n");
  const calls = [];
  let sent = "";
  let reads = 0;
  const runProcess = async ({ argv }) => {
    const action = argv[1];
    calls.push([...argv]);
    if (action === "get") return info(role, "idle", 1);
    if (action === "prompt") {
      sent = argv[3];
      return info(role, "done", 2, "agent_prompted");
    }
    if (action === "read") {
      reads += 1;
      if (reads === 1) return { code: 0, stdout: "history" };
      if (reads === 2) return { code: 0, stdout: `${close}\n` }; // ordinary 400-line tail lost the opening boundary
      return { code: 0, stdout: `history\n${sent}\n${open}\n${body}\n${close}\n` };
    }
    throw new Error(action);
  };
  const result = await executeHerdrPromptExchange(
    { action: "prompt", role, prompt: "review every finding", timeoutMs: 1000 },
    { cwd: root },
    { runProcess },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.report, body);
  assert.equal(result.readCount, 2);
  assert.equal(calls.filter((argv) => argv[1] === "prompt").length, 1, "the prompt is never resent");
  assert.ok(Number(calls.at(-1)[calls.at(-1).indexOf("--lines") + 1]) > 400);
});

test("plain read expands once when the 400-line tail starts inside the latest report", async () => {
  const role = "long-review";
  const [open, close] = markerPair(role);
  const body = Array.from({ length: 600 }, (_, index) => `line-${index}`).join("\n");
  const calls = [];
  const result = await executeHerdrCommunication(
    { action: "read", role },
    { cwd: root },
    { runProcess: async ({ argv }) => {
      calls.push([...argv]);
      const lines = Number(argv[argv.indexOf("--lines") + 1]);
      return { code: 0, stdout: lines === 400 ? `${close}\n` : `${open}\n${body}\n${close}\n` };
    } },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.report, body);
  assert.equal(calls.length, 2);
});

test("Herdr extraction ignores echoed contract markers but rejects nested markers", () => {
  const earlier = "[REVIEW_REPORT_BEGIN]\nold report\n[REVIEW_REPORT_END]";
  const echoedContract = "Return exactly one complete role report, and no additional report, bounded by these literal markers: [REVIEW_REPORT_BEGIN] [REVIEW_REPORT_END]";
  const newer = `[REVIEW_REPORT_BEGIN]\n${echoedContract}\nfresh report\n[REVIEW_REPORT_END]`;
  assert.equal(extractLatestHerdrReport(`${earlier}\n${newer}`, "reviewer"), "fresh report");

  const nested = "[REVIEW_REPORT_BEGIN]\nfresh [REVIEW_REPORT_BEGIN] inner [REVIEW_REPORT_END]\n[REVIEW_REPORT_END]";
  assert.throws(
    () => extractLatestHerdrReport(nested, "reviewer"),
    (error) => error.code === "report_nested",
  );
});

test("Herdr boxed terminal padding does not hide a complete marked report", () => {
  const box = (line) => ` ${line}${" ".repeat(240 - line.length - 2)}│`;
  const echo = [
    box("Return exactly one complete role report, and no additional report, bounded by these literal markers:"),
    box("[REVIEW_REPORT_BEGIN]"),
    box("[REVIEW_REPORT_END]"),
  ].join("\n");
  const transcript = `${echo}\n${box("[REVIEW_REPORT_BEGIN]")}\nDelivery: dlv-1234567890abcdef-abc\nVerdict: reviewed\n[REVIEW_REPORT_END]`;
  const body = extractLatestHerdrReport(transcript, "reviewer");
  assert.match(body, /Verdict: reviewed/);
  assert.match(body, /Delivery: dlv-1234567890abcdef-abc/);
  assert.throws(
    () => extractLatestHerdrReport(`${box("[REVIEW_REPORT_BEGIN]")} malicious\n[REVIEW_REPORT_END]`, "reviewer"),
    (error) => error.code === "report_reversed",
  );
});

test("stalled-before-delivery", async () => {
  const f = exchangeFixture({ promptFailure: { code: 2, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }) } });
  const r = await executeHerdrPromptExchange({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess });
});

test("exact-once-invocation", async () => {
  for (const failure of [{ code: 2, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }) }, { code: 2, stderr: "bad" }, { code: 0, stdout: "{" }]) { const f = exchangeFixture({ promptFailure: failure }); await executeHerdrPromptExchange({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess }); assert.equal(f.calls.filter(c => c.action === "prompt").length, 1); }
});

test("stalled-tocou-unknown", async () => {
  const f = exchangeFixture({ promptFailure: { code: 2, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }) }, recovery: info("reviewer", "idle", undefined) });
  const r = await executeHerdrPromptExchange({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(r.code, "prompt_delivery_unknown"); assert.doesNotMatch(r.reason, /undelivered/);
});

test("snapshot-fail-closed-and-revalidation", async () => {
  let calls = [];
  let r = await executeHerdrPromptExchange({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: async ({ argv }) => { calls.push(argv[1]); return argv[1] === "get" ? info("reviewer") : { code: 2, stderr: "read failed" }; } });
  assert.equal(r.code, "report_scope_unavailable"); assert.equal(calls.filter(x => x === "prompt").length, 0);
  const f = exchangeFixture({ statuses: ["idle", "working"] }); r = await executeHerdrPromptExchange({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess }); assert.equal(r.code, "role_not_promptable"); assert.equal(f.calls.filter(c => c.action === "prompt").length, 0);
});

test("two-read-latency-contract", async () => {
  const f = exchangeFixture(); const r = await executeHerdrPromptExchange({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(r.ok, true); assert.deepEqual(f.calls.map(c => c.action), ["get", "read", "get", "prompt", "read"]);
});

// ---------------------------------------------------------------------------
// Async delivery contract: prompt/submit return an immediate, non-authorizing
// delivery receipt; delivery state is queried read-only; a delivered prompt is
// never resent.
// ---------------------------------------------------------------------------

const COMMUNICATION_SCHEMA = "agentic-driver.herdr-communication.v1";

function deliveryFixture({ status = "idle", report = "fresh worker findings", failPreRead = false } = {}) {
  const calls = [];
  let answered = false;
  let promptCount = 0;
  let reads = 0;
  const runProcess = async ({ argv }) => {
    const [action, role] = [argv[1], argv[2]];
    calls.push({ action, role, argv: [...argv] });
    if (action === "get") {
      // The role's activity sequence advances once the answer is written.
      return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: role, agent: "pi", status, state_change_seq: answered ? 2 : 1, repository: root } }) };
    }
    if (action === "prompt") {
      promptCount += 1;
      assert.ok(!argv.includes("--wait"), "delivery must not block on --wait");
      if (argv.includes("--timeout")) return { code: 2, stdout: "", stderr: "--timeout requires --wait" };
      return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: role, agent: "pi", status: "working", repository: root } }) };
    }
    if (action === "read") {
      reads += 1;
      if (failPreRead && reads === 1) return { code: 2, stdout: "", stderr: "read failed" };
      const lines = Number(argv[argv.indexOf("--lines") + 1]);
      if (lines > 400 || !answered) return { code: 0, stdout: "history" };
      const sent = calls.filter((call) => call.action === "prompt" && call.role === role).at(-1).argv[3];
      const [open, close] = markerPair(role);
      const correlation = sent.split("\n").at(-2); // the framing's Delivery line
      return { code: 0, stdout: `history\n${sent}\n${open}\n${correlation}\n${report}\n${close}` };
    }
    throw new Error(`unexpected action: ${action}`);
  };
  return { calls, runProcess, markAnswered: () => { answered = true; }, get promptCount() { return promptCount; } };
}

test("prompt returns an immediate delivery receipt with no model round-trip", async () => {
  const f = deliveryFixture();
  const started = Date.now();
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "progress the bounded step", timeoutMs: 120000 },
    { cwd: root },
    { runProcess: f.runProcess },
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.schema, COMMUNICATION_SCHEMA);
  assert.equal(receipt.status, "accepted");
  assert.match(receipt.deliveryId, /^dlv-/);
  assert.equal(receipt.role, "worker");
  assert.equal(receipt.deliveryState, "delivered");
  assert.equal(receipt.nonAuthorizing, true);
  assert.equal(receipt.authorityCreated, false);
  assert.equal(typeof receipt.acceptedAt, "string");
  assert.ok(Date.now() - started < 5000, "the receipt must not wait for the model");
  // One preflight get, one pre-snapshot read, one handoff. No wait, no post
  // read: no settlement observation happens on the delivery path.
  assert.deepEqual(f.calls.map((call) => call.action), ["get", "read", "prompt"]);
  const promptCall = f.calls.find((call) => call.action === "prompt");
  assert.ok(!promptCall.argv.includes("--wait"));
  assert.equal(promptCall.argv.includes("--timeout"), false);
  assert.match(promptCall.argv[3], /Return exactly one complete role report/);
  // timeoutMs is validated but never forwarded as a blocking wait bound.
  assert.ok(!promptCall.argv.includes("120000"));
});

test("submit returns the same immediate receipt contract", async () => {
  const f = deliveryFixture();
  const receipt = await executeHerdrCommunication(
    { action: "submit", role: "worker", prompt: "submit-only brief", timeoutMs: 15000 },
    { cwd: root },
    { runProcess: f.runProcess },
  );
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.operation, "submit");
  assert.match(receipt.deliveryId, /^dlv-/);
  assert.equal(receipt.nonAuthorizing, true);
  assert.equal(receipt.authorityCreated, false);
  assert.equal(typeof receipt.submittedAt, "string");
  assert.deepEqual(f.calls.map((call) => call.action), ["get", "read", "prompt"]);
});

test("delivery query walks delivered to answered with report markers", async () => {
  const f = deliveryFixture();
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "step brief", timeoutMs: 1000 },
    { cwd: root },
    { runProcess: f.runProcess },
  );
  const before = f.calls.length;
  const pending = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root },
    { runProcess: f.runProcess },
  );
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.status, "observed");
  assert.equal(pending.deliveryState, "delivered");
  assert.equal(pending.nonAuthorizing, true);
  assert.equal(pending.authorityCreated, false);
  // The sequence gate observes no activity since the handoff, so the query
  // is a single read-only get observation with no read and no attribution.
  assert.deepEqual(f.calls.slice(before).map((call) => call.action), ["get"]);
  f.markAnswered();
  const beforeAnswered = f.calls.length;
  const answered = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root },
    { runProcess: f.runProcess },
  );
  assert.equal(answered.deliveryState, "answered");
  assert.equal(answered.report, "fresh worker findings");
  assert.equal(answered.reportMarkers.open, "[WORKER_REPORT_BEGIN]");
  assert.equal(answered.reportMarkers.close, "[WORKER_REPORT_END]");
  assert.deepEqual(f.calls.slice(beforeAnswered).map((call) => call.action), ["get", "read"]);
  // The answered observation is cached: a repeat query performs no reads and
  // never re-prompts.
  const after = f.calls.length;
  const again = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root },
    { runProcess: f.runProcess },
  );
  assert.equal(again.report, "fresh worker findings");
  assert.equal(f.calls.length, after);
  assert.equal(f.promptCount, 1);
});

test("prompt refusals are structured and never throw", async () => {
  const noTraffic = async () => { throw new Error("no Herdr traffic expected"); };
  const denied = await executeHerdrCommunication(
    { action: "prompt", role: "coordinator", prompt: "x", timeoutMs: 100 },
    { cwd: root }, { runProcess: noTraffic },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.status, "denied");
  assert.equal(denied.code, "target_role_denied");
  assert.equal(denied.nonAuthorizing, true);
  assert.equal(denied.authorityCreated, false);

  const oversized = await executeHerdrCommunication(
    { action: "submit", role: "worker", prompt: "x".repeat(33 * 1024), timeoutMs: 100 },
    { cwd: root }, { runProcess: noTraffic },
  );
  assert.equal(oversized.ok, false);
  assert.equal(oversized.status, "denied");
  assert.equal(oversized.code, "prompt_oversized");

  const busy = deliveryFixture({ status: "working" });
  const notPromptable = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "x", timeoutMs: 100 },
    { cwd: root }, { runProcess: busy.runProcess },
  );
  assert.equal(notPromptable.ok, false);
  assert.equal(notPromptable.status, "refused");
  assert.equal(notPromptable.code, "role_not_promptable");
  assert.equal(busy.calls.filter((call) => call.action === "prompt").length, 0);

  const goneRunProcess = async ({ argv }) => {
    if (argv[1] === "get") return { code: 2, stdout: "", stderr: "agent_name_not_found" };
    throw new Error("no traffic expected after a stale role");
  };
  const gone = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "x", timeoutMs: 100 },
    { cwd: root }, { runProcess: goneRunProcess },
  );
  assert.equal(gone.ok, false);
  assert.equal(gone.status, "refused");
  assert.equal(gone.code, "stale_role_mapping");

  const failing = deliveryFixture();
  const failingRunProcess = async (request) => {
    if (request.argv[1] === "prompt") return { code: 2, stdout: "", stderr: "agent hung up" };
    return failing.runProcess(request);
  };
  const failed = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "x", timeoutMs: 100 },
    { cwd: root }, { runProcess: failingRunProcess },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "refused");
  assert.equal(failed.code, "herdr_process_failed");
  const failedState = await executeHerdrCommunication(
    { action: "delivery", deliveryId: failed.deliveryId },
    { cwd: root }, { runProcess: failing.runProcess },
  );
  assert.equal(failedState.ok, true);
  assert.equal(failedState.deliveryState, "failed");
});

test("an unconfirmed handoff is explicit and never ambiguous or resent", async () => {
  const f = deliveryFixture();
  let handoffs = 0;
  const runProcess = async (request) => {
    if (request.argv[1] === "prompt") { handoffs += 1; return { internalFailure: "timeout" }; }
    return f.runProcess(request);
  };
  const refused = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "x", timeoutMs: 100 },
    { cwd: root }, { runProcess },
  );
  // process_timeout and aborted no longer appear on the prompt path: an
  // unconfirmed handoff is one explicit refused state instead.
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "refused");
  assert.equal(refused.code, "delivery_unconfirmed");
  assert.equal(refused.deliveryState, "unknown");
  assert.equal(handoffs, 1, "the adapter never resends");
  const state = await executeHerdrCommunication(
    { action: "delivery", deliveryId: refused.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(state.ok, true);
  assert.equal(state.deliveryState, "unknown");
});

test("an unknown deliveryId is refused without any Herdr traffic", async () => {
  const f = deliveryFixture();
  const unknown = await executeHerdrCommunication(
    { action: "delivery", deliveryId: "dlv-nonexistent" },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, "refused");
  assert.equal(unknown.code, "delivery_unknown");
  assert.deepEqual(f.calls, []);
});

test("a delivered prompt is never resent by the adapter", async () => {
  const f = deliveryFixture();
  const first = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "same brief", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  const second = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "same brief", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  // Two explicit caller prompts are two distinct deliveries; the receipt ids
  // differ so the caller can track each one separately.
  assert.notEqual(first.deliveryId, second.deliveryId);
  assert.equal(f.promptCount, 2);
  for (const receipt of [first, second]) {
    await executeHerdrCommunication(
      { action: "delivery", deliveryId: receipt.deliveryId },
      { cwd: root }, { runProcess: f.runProcess },
    );
  }
  assert.equal(f.promptCount, 2, "delivery queries never re-prompt");
});

test("the checklist-guard supply path stays compatible with the async contract", async () => {
  // The host guard appends the first TaskCreate checklist action to
  // input.prompt before this tool executes; the input shape
  // {action, role, prompt, timeoutMs} must keep validating and delivering
  // that appended text as one brief.
  const f = deliveryFixture();
  const appended = "do the step\n\nBefore implementation, TaskCreate a short checklist and keep it current.";
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: appended, timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const sent = f.calls.find((call) => call.action === "prompt").argv[3];
  assert.ok(sent.startsWith(appended), "the delivered brief carries the caller's guard-appended text");
  assert.match(sent, /Return exactly one complete role report/);
  // A guard-appended prompt that breaches the bounded size is still refused
  // closed before any traffic.
  const oversizedAppended = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "x".repeat(33 * 1024), timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(oversizedAppended.ok, false);
  assert.equal(oversizedAppended.code, "prompt_oversized");
  assert.equal(f.promptCount, 1);
});

test("wait and read keep their existing contracts", async () => {
  const result = await executeHerdrCommunication(
    { action: "wait", role: "worker", timeoutMs: 1000 },
    { cwd: root },
    { runProcess: async ({ argv }) => {
      assert.equal(argv[1], "wait");
      assert.ok(!argv.includes("--timeout"));
      return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: "worker", agent: "pi", status: "idle", repository: root } }) };
    } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "idle");
  assert.equal(result.nonAuthorizing, true);
  assert.equal(result.authorityCreated, false);
});

// ---------------------------------------------------------------------------
// Adversarial attribution and deduplication cases.
// ---------------------------------------------------------------------------

const REPORT_CONTRACT_LINE = "Return exactly one complete role report, and no additional report, bounded by these literal markers:";

// Bounded wait until a gated handoff has started (the wrapper marks the
// fixture before awaiting the gate), so tests never spin indefinitely.
async function waitForHandoffStart(f, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!f.handoffStarted) {
    if (Date.now() > deadline) throw new Error("handoff never started");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// A terminal whose content grows as the test directs: handoffs append their
// framed echo; the test appends answers and bumps the role activity sequence.
function partitionFixture() {
  const calls = [];
  const entries = [];
  let seq = 1;
  const runProcess = async ({ argv }) => {
    const [action, role] = [argv[1], argv[2]];
    calls.push({ action, role, argv: [...argv] });
    if (action === "get") {
      return { code: 0, stdout: JSON.stringify({ type: "agent_info", agent: { name: role, agent: "pi", status: "idle", state_change_seq: seq, repository: root } }) };
    }
    if (action === "prompt") {
      entries.push({ kind: "echo", text: argv[3] });
      return { code: 0, stdout: JSON.stringify({ type: "agent_prompted", agent: { name: role, agent: "pi", status: "working", repository: root } }) };
    }
    if (action === "read") {
      const [open, close] = markerPair("worker");
      const parts = entries.map((entry) => {
        if (entry.kind === "echo") return entry.text;
        if (entry.kind === "raw") return entry.text;
        return `${open}\n${entry.prefix ?? `Delivery: ${entry.deliveryId}`}\n${entry.body}\n${close}`;
      });
      return { code: 0, stdout: ["history", ...parts].join("\n") };
    }
    throw new Error(`unexpected action: ${action}`);
  };
  return {
    calls,
    runProcess,
    entries,
    handoffStarted: false,
    addReport: (deliveryId, body, prefix) => { entries.push({ kind: "report", deliveryId, body, prefix }); seq += 1; },
    get handoffs() { return calls.filter((call) => call.action === "prompt").length; },
  };
}

test("two rapid identical prompts each attribute to their own answer", async () => {
  const f = partitionFixture();
  const brief = "identical bounded brief";
  const a = await executeHerdrCommunication({ action: "prompt", role: "worker", prompt: brief, timeoutMs: 1000 }, { cwd: root }, { runProcess: f.runProcess });
  const b = await executeHerdrCommunication({ action: "prompt", role: "worker", prompt: brief, timeoutMs: 1000 }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.deliveryId, b.deliveryId);
  assert.equal(f.handoffs, 2);
  // The framed echoes differ by delivery id even though the caller text is
  // identical, so each handoff has its own terminal boundary.
  const [echoA, echoB] = f.entries;
  assert.notEqual(echoA.text, echoB.text);
  assert.match(echoA.text, /Delivery: dlv-/);
  assert.match(echoB.text, /Delivery: dlv-/);

  // No answers yet: both queries stay delivered without mislabeling.
  const qaNone = await executeHerdrCommunication({ action: "delivery", deliveryId: a.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  const qbNone = await executeHerdrCommunication({ action: "delivery", deliveryId: b.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qaNone.deliveryState, "delivered");
  assert.equal(qbNone.deliveryState, "delivered");

  // First answer lands: only delivery A may claim it.
  f.addReport(a.deliveryId, "answer one");
  const qa = await executeHerdrCommunication({ action: "delivery", deliveryId: a.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qa.deliveryState, "answered");
  assert.equal(qa.report, "answer one");
  const qbEarly = await executeHerdrCommunication({ action: "delivery", deliveryId: b.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qbEarly.deliveryState, "delivered", "delivery B must not claim delivery A's answer");

  // Second answer lands: delivery B attributes to its own answer.
  f.addReport(b.deliveryId, "answer two");
  const qb = await executeHerdrCommunication({ action: "delivery", deliveryId: b.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qb.deliveryState, "answered");
  assert.equal(qb.report, "answer two");
  const qaAgain = await executeHerdrCommunication({ action: "delivery", deliveryId: a.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qaAgain.report, "answer one", "delivery A keeps its own answer");
});

test("out-of-order answers never cross-claim: B reports first, A keeps waiting for its own", async () => {
  const f = partitionFixture();
  const brief = "same brief for both";
  const a = await executeHerdrCommunication({ action: "prompt", role: "worker", prompt: brief, timeoutMs: 1000 }, { cwd: root }, { runProcess: f.runProcess });
  const b = await executeHerdrCommunication({ action: "prompt", role: "worker", prompt: brief, timeoutMs: 1000 }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // B answers FIRST, before A's answer exists.
  f.addReport(b.deliveryId, "b was faster");
  const qb = await executeHerdrCommunication({ action: "delivery", deliveryId: b.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qb.deliveryState, "answered");
  assert.equal(qb.report, "b was faster");
  const qa = await executeHerdrCommunication({ action: "delivery", deliveryId: a.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qa.deliveryState, "delivered", "A must not claim B's earlier-completed report");
  assert.equal(qa.report, undefined);
  // A's own answer arrives later; it attributes to A, and B's cache is
  // untouched.
  f.addReport(a.deliveryId, "a was slower");
  const qa2 = await executeHerdrCommunication({ action: "delivery", deliveryId: a.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qa2.deliveryState, "answered");
  assert.equal(qa2.report, "a was slower");
  const qb2 = await executeHerdrCommunication({ action: "delivery", deliveryId: b.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qb2.report, "b was faster");
});

test("a report arriving between handoff and first query attributes by its own correlation line", async () => {
  const f = partitionFixture();
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "solo brief", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(receipt.ok, true);
  f.addReport(receipt.deliveryId, "already there");
  const query = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(query.deliveryState, "answered");
  assert.equal(query.report, "already there");
});

test("a delivery with no report yet stays delivered across repeated queries", async () => {
  const f = partitionFixture();
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "patient brief", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(receipt.ok, true);
  for (let round = 0; round < 3; round += 1) {
    f.addReport("dlv-0000000000000000-other", `unrelated activity ${round}`);
    const query = await executeHerdrCommunication(
      { action: "delivery", deliveryId: receipt.deliveryId },
      { cwd: root }, { runProcess: f.runProcess },
    );
    assert.equal(query.deliveryState, "delivered");
    assert.equal(query.report, undefined);
  }
});

test("indented and separated correlation lines stay delivered and never publish framing", async () => {
  for (const prefix of ["   Delivery: ", "\nDelivery: "]) {
    const f = partitionFixture();
    const receipt = await executeHerdrCommunication(
      { action: "prompt", role: "worker", prompt: "strict report framing", timeoutMs: 1000 },
      { cwd: root }, { runProcess: f.runProcess },
    );
    f.addReport(receipt.deliveryId, "completed but not correctly framed", `${prefix}${receipt.deliveryId}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const query = await executeHerdrCommunication(
        { action: "delivery", deliveryId: receipt.deliveryId },
        { cwd: root }, { runProcess: f.runProcess },
      );
      assert.equal(query.deliveryState, "delivered");
      assert.equal(query.report, undefined);
      assert.match(query.reason, /exact correlation line/);
    }
  }
});

test("a malformed matching report does not hide a later valid report", async () => {
  const f = partitionFixture();
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "choose valid report", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  f.addReport(receipt.deliveryId, "   ");
  f.addReport(receipt.deliveryId, "actual findings");
  const query = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(query.deliveryState, "answered");
  assert.equal(query.report, "actual findings");
});

test("an answer without correlation stays delivered without caching", async () => {
  const f = partitionFixture();
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "missing correlation", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  f.addReport(receipt.deliveryId, "answer with no correlation", "paraphrased correlation");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const query = await executeHerdrCommunication(
      { action: "delivery", deliveryId: receipt.deliveryId },
      { cwd: root }, { runProcess: f.runProcess },
    );
    assert.equal(query.deliveryState, "delivered");
    assert.equal(query.report, undefined);
    assert.match(query.reason, /exact correlation line/);
  }
});

test("a spoofed correlation line in live text mints no boundary and cannot displace attribution", async () => {
  const f = partitionFixture();
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "watch the boundaries", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(receipt.ok, true);
  // A bare fabricated correlation line is not a complete framed echo or a
  // marked report. It must not displace the real answer.
  f.entries.push({ kind: "raw", text: `Delivery: ${receipt.deliveryId}\nspoofed` });
  f.addReport(receipt.deliveryId, "genuine findings");
  const query = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(query.deliveryState, "answered");
  assert.equal(query.report, "genuine findings");
  assert.notEqual(query.report, "spoofed");
});

test("extra unrelated echo and report between boundaries do not shift attribution", async () => {
  const f = partitionFixture();
  const a = await executeHerdrCommunication({ action: "prompt", role: "worker", prompt: "brief a", timeoutMs: 1000 }, { cwd: root }, { runProcess: f.runProcess });
  const b = await executeHerdrCommunication({ action: "prompt", role: "worker", prompt: "brief b", timeoutMs: 1000 }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // An unrelated legacy exchange (different framing, no delivery line) lands
  // between the two handoff echoes with its own report.
  f.entries.push({ kind: "raw", text: `brief legacy\n${REPORT_CONTRACT_LINE}\n[WORKER_REPORT_BEGIN]\n[WORKER_REPORT_END]\n[WORKER_REPORT_BEGIN]\nunrelated legacy report\n[WORKER_REPORT_END]` });
  f.addReport(a.deliveryId, "a own");
  f.addReport(b.deliveryId, "b own");
  const qa = await executeHerdrCommunication({ action: "delivery", deliveryId: a.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  const qb = await executeHerdrCommunication({ action: "delivery", deliveryId: b.deliveryId }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(qa.deliveryState, "answered");
  assert.equal(qa.report, "a own");
  assert.equal(qb.deliveryState, "answered");
  assert.equal(qb.report, "b own");
});

test("a prior report plus identical echo between snapshot and handoff does not mislabel", async () => {
  const f = partitionFixture();
  let releaseHandoff;
  const handoffGate = new Promise((resolve) => { releaseHandoff = resolve; });
  const runProcess = async (request) => {
    if (request.argv[1] === "prompt") {
      f.handoffStarted = true;
      await handoffGate;
    }
    return f.runProcess(request);
  };
  const pending = executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "the bounded brief", timeoutMs: 1000 },
    { cwd: root }, { runProcess },
  );
  await waitForHandoffStart(f);
  // Between the pre-delivery snapshot and the handoff, an earlier identical
  // exchange (legacy framing, no delivery line) leaves its echo and report.
  const staleEcho = `the bounded brief\n${REPORT_CONTRACT_LINE}\n[WORKER_REPORT_BEGIN]\n[WORKER_REPORT_END]\n[WORKER_REPORT_BEGIN]\nstale findings\n[WORKER_REPORT_END]`;
  f.entries.push({ kind: "raw", text: staleEcho });
  releaseHandoff();
  const receipt = await pending;
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  f.addReport(receipt.deliveryId, "fresh findings");
  const query = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(query.deliveryState, "answered");
  assert.equal(query.report, "fresh findings");
  assert.notEqual(query.report, "stale findings");
});

test("no pre-delivery snapshot means unattributed, never answered, nothing cached", async () => {
  const f = deliveryFixture({ failPreRead: true });
  const receipt = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "x", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(receipt.ok, true, "the handoff itself still succeeds");
  const before = f.calls.length;
  const query = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(query.ok, true);
  assert.equal(query.deliveryState, "unattributed");
  assert.match(query.reason, /snapshot-backed attribution is the only answered path/);
  assert.equal(query.report, undefined);
  assert.equal(f.calls.length, before, "the unattributed transition performs no Herdr traffic");
  // Even with an answer available, no report is ever cached as this
  // delivery's answer.
  f.markAnswered();
  const again = await executeHerdrCommunication(
    { action: "delivery", deliveryId: receipt.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(again.deliveryState, "unattributed");
  assert.equal(again.report, undefined);
});

test("a repeat call inside the deduplication window returns the in-flight delivery without a second handoff", async () => {
  const f = deliveryFixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runProcess = async (request) => {
    if (request.argv[1] === "prompt") {
      f.handoffStarted = true;
      await gate;
    }
    return f.runProcess(request);
  };
  const first = executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "same brief", timeoutMs: 1000 },
    { cwd: root }, { runProcess },
  );
  await waitForHandoffStart(f);
  const repeat = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "same brief", timeoutMs: 1000 },
    { cwd: root }, { runProcess },
  );
  assert.equal(repeat.ok, true, JSON.stringify(repeat));
  assert.equal(repeat.status, "accepted");
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.promptSent, false);
  assert.equal(repeat.deliveryState, "queued");
  release();
  const firstReceipt = await first;
  assert.equal(repeat.deliveryId, firstReceipt.deliveryId);
  assert.equal(f.promptCount, 1, "no second handoff for the identical repeat");
});

test("a repeat call after an unconfirmed handoff is refused with the same deliveryId", async () => {
  const f = deliveryFixture();
  let handoffs = 0;
  const runProcess = async (request) => {
    if (request.argv[1] === "prompt") { handoffs += 1; return { internalFailure: "timeout" }; }
    return f.runProcess(request);
  };
  const first = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "retry me", timeoutMs: 1000 },
    { cwd: root }, { runProcess },
  );
  assert.equal(first.ok, false);
  assert.equal(first.code, "delivery_unconfirmed");
  assert.equal(first.deliveryState, "unknown");
  const repeat = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "retry me", timeoutMs: 1000 },
    { cwd: root }, { runProcess },
  );
  assert.equal(repeat.ok, false);
  assert.equal(repeat.status, "refused");
  assert.equal(repeat.code, "duplicate_unconfirmed");
  assert.equal(repeat.deliveryId, first.deliveryId);
  assert.equal(repeat.deliveryState, "unknown");
  assert.equal(handoffs, 1, "the unconfirmed repeat is never re-handed off");
  // Window expiry: after the bounded window the same lookup finds nothing,
  // so a further repeat would be a genuinely new delivery.
  const live = findUnconfirmedDelivery("worker", "retry me");
  assert.equal(live.deliveryId, first.deliveryId);
  assert.equal(findUnconfirmedDelivery("worker", "retry me", Date.now() + 121_000), undefined);
});

test("a repeat call after the prior delivery is confirmed answered is a new delivery", async () => {
  const f = deliveryFixture();
  const first = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "twice", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(first.ok, true);
  f.markAnswered();
  const settled = await executeHerdrCommunication(
    { action: "delivery", deliveryId: first.deliveryId },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(settled.deliveryState, "answered");
  const second = await executeHerdrCommunication(
    { action: "prompt", role: "worker", prompt: "twice", timeoutMs: 1000 },
    { cwd: root }, { runProcess: f.runProcess },
  );
  assert.equal(second.ok, true);
  assert.notEqual(second.deliveryId, first.deliveryId);
  assert.equal(f.promptCount, 2);
});

test("a handoff that fails after a zero exit is unknown, not failed", async () => {
  for (const [index, promptResult] of [
    { code: 0, stdout: "{" },
    { code: 0, stdout: JSON.stringify({ type: "unexpected_type" }) },
  ].entries()) {
    const f = deliveryFixture();
    const brief = `uncertain handoff ${index}`;
    const runProcess = async (request) => {
      if (request.argv[1] === "prompt") return promptResult;
      return f.runProcess(request);
    };
    const refused = await executeHerdrCommunication(
      { action: "prompt", role: "worker", prompt: brief, timeoutMs: 1000 },
      { cwd: root }, { runProcess },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.status, "refused");
    assert.equal(refused.code, "delivery_unconfirmed", JSON.stringify(refused));
    assert.equal(refused.deliveryState, "unknown");
    const state = await executeHerdrCommunication(
      { action: "delivery", deliveryId: refused.deliveryId },
      { cwd: root }, { runProcess: f.runProcess },
    );
    assert.equal(state.deliveryState, "unknown", "post-handoff uncertainty is not recorded as failed");
  }
});
