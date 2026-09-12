import test from "node:test";
import assert from "node:assert/strict";
import {
  executeHerdrCommunication,
  extractLatestHerdrReport,
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
  const results = await Promise.all(roles.map((role) => executeHerdrCommunication(
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
    assert.match(prompt[3], /Remain strictly read-only; do not modify files, state, or Git\./);
    assert.equal(prompt[4], "--wait");
    assert.deepEqual(prompt.slice(5), [
      "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "1000",
    ]);
  }

  const deniedRole = await executeHerdrCommunication(
    { action: "get", role: "coordinator" },
    { cwd: root },
    { runProcess: fixture.runProcess },
  );
  assert.equal(deniedRole.ok, false);
  assert.equal(deniedRole.code, "target_role_denied");

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

test("stalled-before-delivery", async () => {
  const f = exchangeFixture({ promptFailure: { code: 2, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }) } });
  const r = await executeHerdrCommunication({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess });
});

test("exact-once-invocation", async () => {
  for (const failure of [{ code: 2, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }) }, { code: 2, stderr: "bad" }, { code: 0, stdout: "{" }]) { const f = exchangeFixture({ promptFailure: failure }); await executeHerdrCommunication({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess }); assert.equal(f.calls.filter(c => c.action === "prompt").length, 1); }
});

test("stalled-tocou-unknown", async () => {
  const f = exchangeFixture({ promptFailure: { code: 2, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }) }, recovery: info("reviewer", "idle", undefined) });
  const r = await executeHerdrCommunication({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(r.code, "prompt_delivery_unknown"); assert.doesNotMatch(r.reason, /undelivered/);
});

test("snapshot-fail-closed-and-revalidation", async () => {
  let calls = [];
  let r = await executeHerdrCommunication({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: async ({ argv }) => { calls.push(argv[1]); return argv[1] === "get" ? info("reviewer") : { code: 2, stderr: "read failed" }; } });
  assert.equal(r.code, "report_scope_unavailable"); assert.equal(calls.filter(x => x === "prompt").length, 0);
  const f = exchangeFixture({ statuses: ["idle", "working"] }); r = await executeHerdrCommunication({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess }); assert.equal(r.code, "role_not_promptable"); assert.equal(f.calls.filter(c => c.action === "prompt").length, 0);
});

test("two-read-latency-contract", async () => {
  const f = exchangeFixture(); const r = await executeHerdrCommunication({ action: "prompt", role: "reviewer", prompt: "x", timeoutMs: 100 }, { cwd: root }, { runProcess: f.runProcess });
  assert.equal(r.ok, true); assert.deepEqual(f.calls.map(c => c.action), ["get", "read", "get", "prompt", "read"]);
});
