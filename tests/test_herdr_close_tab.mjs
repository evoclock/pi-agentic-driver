import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import * as lifecycle from "../scripts/enforcement/herdr_lifecycle_pi.js";

const request = { tabId: "w1:t2", reason: "finished" };
const root = process.cwd();
function fixture() {
  mkdirSync(join(root, "scratch"), { recursive: true });
  const home = realpathSync(mkdtempSync(join(root, "scratch/close-tab-")));
  const binary = join(home, ".local/share/herdr/0.9.1/herdr");
  mkdirSync(join(binary, ".."), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  symlinkSync(binary, join(home, ".local/bin/herdr"));
  const socket = join(home, ".config/herdr/herdr.sock");
  const host = { host: hostname(), socket, pid: 1234, uid: process.getuid(), binary,
    startedAt: "Fri Nov 13 23:00:00 2026", socketIdentity: "1:2", local: true };
  const state = {
    host, status: { running: true, status: "running", socket, session: null, version: "0.9.1", protocol: 13, compatible: true, restart_needed: false },
    caller: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
    workspaces: [{ workspace_id: "w1", label: "workers", tab_count: 3 }],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "worker", pane_count: 1 },
      { tab_id: "w1:t2", workspace_id: "w1", label: "worker", pane_count: 1 },
      { tab_id: "w1:t3", workspace_id: "w1", label: "other", pane_count: 1 },
    ],
    panes: [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent: "pi", agent_status: "working", name: "worker" }],
    close: { type: "ok" },
  };
  const calls = [];
  const options = { testHomeDir: home, testPlatform: "darwin", testHomebrewExecutablePath: join(home, "absent"),
    testObserveCloseHost: () => structuredClone(state.host),
    testCloseCallerPaneId: "w1:p1",
    runProcess: async (spec) => {
      calls.push(spec);
      const argv = spec.argv;
      let value;
      if (argv[0] === "status") value = state.status;
      else if (argv[0] === "workspace") value = { workspaces: state.workspaces };
      else if (argv[0] === "tab" && argv[1] === "list") value = { tabs: state.tabs };
      else if (argv[0] === "pane" && argv[1] === "current") value = { pane: state.caller };
      else if (argv[0] === "pane" && argv[1] === "list") value = { panes: state.panes };
      else if (argv[0] === "pane" && argv[1] === "get") value = { pane: state.panes.find(p => p.pane_id === argv[2]) };
      else if (argv[0] === "tab" && argv[1] === "close") {
        if (state.closeFailure) return { code: 1, stderr: "secret operator diagnostic" };
        if (state.closeMalformed) return { code: 0, stdout: "{" };
        state.tabs = state.tabs.filter(t => t.tab_id !== argv[2]);
        value = state.close;
      } else throw new Error(`unexpected fixture argv ${JSON.stringify(argv)}`);
      await state.onCall?.(argv);
      return { code: 0, stdout: JSON.stringify({ id: "fixture", result: value }) };
    } };
  const run = async (params = request, signal) => {
    assert.equal(typeof lifecycle.executeHerdrCloseTab, "function", "close entry point must exist");
    return lifecycle.executeHerdrCloseTab(params, { cwd: root }, options, signal);
  };
  const records = () => readFileSync(join(home, ".pi/agentic-driver-herdr/close-attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const closes = () => calls.filter(c => c.argv[0] === "tab" && c.argv[1] === "close");
  return { home, binary, socket, state, options, calls, run, records, closes };
}
async function refused(f, code, params = request) {
  const r = await f.run(params);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, code, JSON.stringify(r));
  assert.equal(f.closes().length, 0);
  return r;
}

// Why: lifecycle registration must expose one narrow tool, not raw management.
test("close tool has a closed schema and follows lifecycle registration", async () => {
  const tools = [];
  lifecycle.registerHerdrLifecycleInterface({ registerTool: t => tools.push(t) });
  const tool = tools.find(t => t.name === "agentic_herdr_close_tab");
  assert.ok(tool);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["reason", "tabId"]);
  const f = fixture();
  const registered = [];
  lifecycle.registerHerdrLifecycleInterface({ registerTool: t => registered.push(t) }, f.options);
  const r = await registered.find(t => t.name === "agentic_herdr_close_tab").execute("id", request, undefined, undefined, { cwd: root });
  assert.equal(r.details.status, "closed");
});

// Why: a caller-owned busy tab can close without affecting its caller or server.
test("owned close is single-shot local tab-close and appends one bounded audit record", async () => {
  const f = fixture();
  const r = await f.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, "closed");
  assert.equal(f.closes().length, 1);
  assert.deepEqual(f.closes()[0].argv, ["tab", "close", "w1:t2"]);
  for (const c of f.calls) {
    assert.equal(c.executable, join(f.home, ".local/bin/herdr"));
    assert.equal(c.spawnOptions.env.HERDR_SOCKET_PATH, f.socket);
    assert.equal(c.shell, false);
  }
  const [record] = f.records();
  assert.equal(f.records().length, 1);
  assert.equal(record.callerRole, "worker");
  assert.equal(record.tabId, "w1:t2");
  assert.equal(record.paneId, "w1:p2");
  assert.equal(record.host, hostname());
  assert.equal(record.server.pid, 1234);
  assert.equal(record.reason, "finished");
  assert.equal(record.result, "closed");
  assert.match(record.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 4096);
});

// Why: finished tabs need not belong to the caller, but unknown status is not idle.
test("non-owned done and idle targets close", async () => {
  for (const status of ["done", "idle"]) {
    const f = fixture(); f.state.tabs[1].label = "other"; f.state.panes[0].name = "other";
    f.state.panes[0].agent_status = status;
    assert.equal((await f.run()).ok, true);
    assert.equal(f.closes().length, 1);
  }
});

// Why: the MacBook must never receive a mutation even under malicious routing inputs.
test("MacBook target and adversarial input never route outside the local socket", async () => {
  const f = fixture(); f.state.host.host = "MacBook-Pro";
  await refused(f, "cross_host");
  for (const extra of [{ host: "MacBook-Pro" }, { socket: "/macbook/herdr.sock" }, { executable: "/evil/herdr" }, { argv: ["server", "stop"] }]) {
    await refused(f, "invalid_close_parameters", { ...request, ...extra });
  }
  assert.equal(f.records()[0].result, "refused:cross_host");
  for (const c of f.calls) {
    assert.equal(c.spawnOptions.env.HERDR_SOCKET_PATH, f.socket);
    assert.ok(!c.argv.some(a => ["server", "stop", "kill", "restart", "quit", "detach", "--machine", "--remote"].includes(a)));
  }
});

// Why: local socket names can be forwarded by SSH and do not establish server ownership.
test("forwarded attached foreign and missing listener identities refuse", async () => {
  for (const change of [{ local: false }, { socket: "/foreign/herdr.sock" }, { binary: "/usr/bin/ssh" }, { uid: process.getuid() + 1 }, { pid: 0 }]) {
    const f = fixture(); Object.assign(f.state.host, change);
    await refused(f, "cross_host");
  }
  const f = fixture(); f.options.testObserveCloseHost = () => { throw new Error("no listener"); };
  await refused(f, "local_server_unverified");
});

// Why: stale server compatibility and socket evidence cannot authorize close.
test("server socket session and restart guards fail closed", async () => {
  for (const change of [{ socket: "machine:macbook/default" }, { session: "other" }, { running: false }, { compatible: false }, { restart_needed: true }]) {
    const f = fixture(); Object.assign(f.state.status, change);
    await refused(f, "server_identity_unverified");
  }
});

// Why: closing a workspace's last tab has wider effects than closing a tab.
test("last tab in any workspace and protected workspace refuse", async () => {
  const last = fixture(); last.state.tabs = [last.state.tabs[1]]; last.state.workspaces[0].tab_count = 1;
  await refused(last, "last_workspace_tab");
  for (const label of ["protected", "protected-production", "coordinator", "coordinator-main"]) {
    const f = fixture(); f.state.workspaces[0].label = label;
    await refused(f, "protected_workspace");
  }
});

// Why: removing the caller or coordinator must not be permitted by idle status.
test("caller and coordinator tabs refuse", async () => {
  const own = fixture(); await refused(own, "caller_tab", { ...request, tabId: "w1:t1" });
  const f = fixture(); f.state.tabs[1].label = "coordinator-main"; f.state.panes[0].agent_status = "idle";
  await refused(f, "coordinator_tab");
});

// Why: an unrelated working or ambiguous pane cannot borrow role ownership.
test("not-owned busy unknown or conflicting role refuses", async () => {
  for (const status of ["working", "blocked", "unknown"]) {
    const f = fixture(); f.state.tabs[1].label = "other"; f.state.panes[0].name = "other"; f.state.panes[0].agent_status = status;
    await refused(f, "not_owned_and_busy");
  }
  const conflict = fixture(); conflict.state.panes[0].name = "different";
  await refused(conflict, "target_identity_unverified");
});

// Why: unknown panes and split tabs can conceal another active agent.
test("missing duplicate split and mismatched topology refuses", async () => {
  const absent = fixture(); await refused(absent, "target_not_local", { ...request, tabId: "w9:t99" });
  const split = fixture(); split.state.tabs[1].pane_count = 2; await refused(split, "single_pane_required");
  const duplicate = fixture(); duplicate.state.tabs.push({ ...duplicate.state.tabs[1] }); await refused(duplicate, "target_identity_unverified");
  const mismatch = fixture(); mismatch.state.panes[0].workspace_id = "w9"; await refused(mismatch, "target_identity_unverified");
});

// Why: malformed identifiers and server-stopping argv must be structurally impossible.
test("bad parameters and every non-tab-close argv shape refuse", async () => {
  const f = fixture();
  for (const params of [null, [], {}, { ...request, reason: "" }, { ...request, reason: "x".repeat(513) }, { ...request, reason: "secret\nvalue" }, { ...request, tabId: "--machine=macbook" }, { ...request, tabId: "w1:t2;server stop" }]) {
    await refused(f, "invalid_close_parameters", params);
  }
  assert.equal(typeof lifecycle.assertTabCloseArgv, "function");
  for (const argv of [["server", "stop"], ["tab", "close", "w1:t2", "--force"], ["pane", "close", "w1:p2"], ["--machine", "macbook", "tab", "close", "w1:t2"], ["tab", "quit", "w1:t2"]]) {
    assert.throws(() => lifecycle.assertTabCloseArgv(argv), { code: "unsafe_close_argv" });
  }
});

// Why: parent environment must not select a MacBook socket, session, config or executable.
test("PATH HERDR_BIN_PATH and inherited routing are ignored", async () => {
  const names = ["PATH", "HERDR_BIN_PATH", "HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION", "XDG_CONFIG_HOME", "HOME"];
  const previous = Object.fromEntries(names.map(k => [k, process.env[k]]));
  const f = fixture();
  try {
    for (const k of names) process.env[k] = "/macbook/evil";
    assert.equal((await f.run()).ok, true);
    for (const c of f.calls) {
      assert.equal(c.spawnOptions.env.HERDR_SOCKET_PATH, f.socket);
      assert.equal(c.spawnOptions.env.HERDR_SESSION, undefined);
      assert.equal(c.spawnOptions.env.HERDR_BIN_PATH, undefined);
      assert.equal(c.spawnOptions.env.HOME, f.home);
      assert.equal(c.spawnOptions.env.XDG_CONFIG_HOME, join(f.home, ".config"));
    }
    const missing = fixture(); missing.options.testHomeDir = join(missing.home, "absent");
    await refused(missing, "trusted_executable_unavailable");
  } finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// Why: asynchronous observations can race with a new host or a busy target.
test("revalidation refuses server and target drift before close", async () => {
  for (const drift of ["host", "busy", "last"]) {
    const f = fixture(); f.state.tabs[1].label = "other"; f.state.panes[0].name = "other"; f.state.panes[0].agent_status = "idle";
    let lists = 0;
    f.state.onCall = argv => {
      if (argv[0] === "tab" && argv[1] === "list" && ++lists === 1) {
        if (drift === "host") f.state.host.pid += 1;
        if (drift === "busy") f.state.panes[0].agent_status = "working";
        if (drift === "last") f.state.workspaces[0].tab_count = 1;
      }
    };
    const r = await f.run(); assert.equal(r.ok, false); assert.equal(f.closes().length, 0);
  }
});

// Why: failures after dispatch are never retried, and audit never copies diagnostics.
test("failed and uncertain close outcomes append one result without retries", async () => {
  for (const failure of ["closeFailure", "closeMalformed"]) {
    const f = fixture(); f.state[failure] = true;
    const r = await f.run(); assert.equal(r.ok, false); assert.equal(r.status, "failed");
    assert.equal(f.closes().length, 1);
    assert.match(f.records()[0].result, /^failed:/);
    assert.doesNotMatch(JSON.stringify(f.records()), /secret operator diagnostic/);
  }
});

// Why: append-only means prior records survive and an unwritable log blocks mutation.
test("audit appends without overwriting and unavailable audit refuses before close", async () => {
  const f = fixture(); await refused(f, "target_not_local", { ...request, tabId: "w9:t99" });
  assert.equal((await f.run()).ok, true);
  assert.equal(f.records().length, 2);
  assert.equal(f.records()[0].result, "refused:target_not_local");
  const bad = fixture(); mkdirSync(join(bad.home, ".pi")); writeFileSync(join(bad.home, ".pi/agentic-driver-herdr"), "not a directory");
  await refused(bad, "audit_unavailable");
});

// Why: aborted calls must never dispatch a close.
test("abort refuses before mutation", async () => {
  const f = fixture(); const c = new AbortController(); c.abort();
  const r = await f.run(request, c.signal);
  assert.equal(r.ok, false); assert.equal(f.closes().length, 0);
});
