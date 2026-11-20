// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { executeHerdrSpawnWorker, executeHerdrSpawnWorkerAttendedElectron } from "../scripts/enforcement/herdr_lifecycle_pi.js";

// Small process-seam fixture: real repository identity, no live Herdr or asgrep.
// The larger worktree-spawn suite exceeds the host's per-file time cap here.
function fixture(t, mode = "ok") {
  const scratch = new URL("../.local/", import.meta.url);
  mkdirSync(scratch, { recursive: true });
  const root = realpathSync(mkdtempSync(join(scratch.pathname, "worker-asgrep-")));
  const worker = join(root, "worker");
  const profile = join(root, "profile");
  mkdirSync(worker);
  mkdirSync(join(profile, "config"), { recursive: true });
  execFileSync("git", ["init", "-q", worker]);
  execFileSync("git", ["-C", worker, "remote", "add", "origin", "https://github.com/evoclock/worker.git"]);
  writeFileSync(join(profile, "config/relay-authority.v1.json"), JSON.stringify({ schema: "relay-authority.v1", githubOwner: "evoclock", denyRepositories: [] }));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("PAD_WORKER_ASGREP") || key.startsWith("ASGREP_")) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = profile;
  process.env.HERDR_PANE_ID = "w7:p1";
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const binary = join(root, "fake-asgrep.mjs");
  const log = join(root, "index.json");
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
${mode === "hung" ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);' : `process.exit(${mode === "fail" ? 7 : 0});`}
`);
  chmodSync(binary, 0o755);
  const calls = [];
  const options = {
    testExecutablePath: binary,
    modelsPath: join(root, "absent"),
    listModels: "provider model\nfixture model-x\n",
    routePolicy: { schema: "agentic-driver.model-route-policy.v1", routes: [{ provider: "fixture", model: "model-x", family: "fixture", subscription: true, gateway: false, aliases: [] }], bannedPairs: [], budgets: {} },
    runProcess({ argv }) {
      calls.push([...argv]);
      const agent = { name: "worker", agent: "pi", pane_id: "w7:p10", cwd: worker };
      let result;
      if (argv[0] === "workspace") result = { workspaces: [{ workspace_id: "w7" }] };
      else if (argv[1] === "list") result = { [argv[0] === "agent" ? "agents" : "tabs"]: [] };
      else if (argv[1] === "current") result = { pane_id: "w7:p1", tab_id: "w7:t1" };
      else if (argv[1] === "create") result = { root_pane: { pane_id: "w7:p10" }, tab: { tab_id: "w7:t3" } };
      else if (argv[1] === "start") result = { type: "agent_started", argv, agent };
      else if (argv[0] === "agent") result = { type: "agent", agent };
      else result = { type: "pane", pane: { pane_id: "w7:p10", cwd: worker } };
      return { code: 0, stdout: JSON.stringify({ result }) };
    },
  };
  const params = { placement: "tab", role: "worker", model: "fixture/model-x", repository: "worker" };
  const context = { cwd: worker, mode: "electron-attended", hasUI: true };
  const tab = () => calls.filter((argv) => argv[1] === "create").at(-1);
  return { root, worker, binary, log, calls, tab, params, context, options };
}

// Why: the CLI switch must reach the new pane, not just the Herdr client process.
test("worker asgrep CLI defaults prewarm the target before returning", async (t) => {
  const f = fixture(t);
  const result = await executeHerdrSpawnWorker(f.params, f.context, { ...f.options, asgrep: { binary: f.binary } });
  assert.equal(result.status, "spawned", JSON.stringify(result));
  assert.ok(f.tab().includes("ASGREP_CODEMODE_BACKEND=cli"));
  assert.ok(f.tab().includes(`ASGREP_BIN=${f.binary}`));
  assert.ok(f.tab().includes("ASGREP_TIMEOUT_MS=30000"));
  assert.ok(existsSync(f.log), "index must finish before the receipt allows brief delivery");
  assert.deepEqual(JSON.parse(readFileSync(f.log)), { argv: ["index", f.worker], cwd: f.worker });
  assert.deepEqual(result.warnings, []);
});

// Why: a missing optional binary must neither force an unusable backend nor refuse a spawn.
test("worker asgrep missing binary warns and preserves the current backend", async (t) => {
  const f = fixture(t);
  const result = await executeHerdrSpawnWorker(f.params, f.context, { ...f.options, asgrep: { binary: join(f.root, "absent") } });
  assert.equal(result.status, "spawned", JSON.stringify(result));
  assert.ok(result.warnings?.some(({ code }) => code === "asgrep_binary_unavailable"));
  assert.equal(f.tab().some((arg) => arg.startsWith("ASGREP_")), false);
});

// Why: callers and host environment can override defaults without editing the launcher.
test("worker asgrep options override environment and support independent opt-outs", async (t) => {
  const f = fixture(t);
  process.env.PAD_WORKER_ASGREP = "off";
  process.env.PAD_WORKER_ASGREP_BIN = f.binary;
  process.env.PAD_WORKER_ASGREP_TIMEOUT_MS = "1234";
  process.env.PAD_WORKER_ASGREP_PREWARM = "0";
  const disabled = await executeHerdrSpawnWorker(f.params, f.context, f.options);
  assert.equal(disabled.status, "spawned");
  assert.equal(f.tab().some((arg) => arg.startsWith("ASGREP_")), false);
  process.env.PAD_WORKER_ASGREP = "on";
  const enabled = await executeHerdrSpawnWorker(f.params, f.context, f.options);
  assert.equal(enabled.status, "spawned");
  assert.ok(f.tab().includes("ASGREP_TIMEOUT_MS=1234"));
  const overridden = await executeHerdrSpawnWorker(f.params, f.context, { ...f.options, asgrep: { backend: "napi", timeoutMs: 4567, prewarm: false } });
  assert.equal(overridden.status, "spawned");
  assert.ok(f.tab().includes("ASGREP_CODEMODE_BACKEND=napi"));
  assert.ok(f.tab().includes("ASGREP_TIMEOUT_MS=4567"));
  const optedOut = await executeHerdrSpawnWorker(f.params, f.context, { ...f.options, asgrep: false });
  assert.equal(optedOut.status, "spawned");
  assert.equal(f.tab().some((arg) => arg.startsWith("ASGREP_")), false);
  assert.equal(existsSync(f.log), false);
});

// Why: a deadline must kill a hung child, not merely stop awaiting its result.
test("worker asgrep hung indexer is killed at the configured deadline and spawn succeeds", async (t) => {
  const f = fixture(t, "hung");
  const original = childProcess.execFile;
  let observed;
  childProcess.execFile = (...args) => {
    const child = original(...args);
    observed = { args, child };
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  const result = await executeHerdrSpawnWorker(f.params, f.context, { ...f.options, asgrep: { binary: f.binary, indexTimeoutMs: 300 } });
  assert.equal(result.status, "spawned", JSON.stringify(result));
  assert.ok(result.warnings?.some(({ code }) => code === "asgrep_index_timeout"));
  assert.equal(observed?.args[2].timeout, 300);
  assert.equal(observed?.args[2].shell, false);
  assert.equal(observed?.child.signalCode, "SIGKILL");
});

// Why: index errors are advisory for both hosts, never an alternate spawn failure path.
test("worker asgrep failed prewarm warns on the attended boundary too", async (t) => {
  const f = fixture(t, "fail");
  const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, { ...f.options, asgrep: { binary: f.binary } });
  assert.equal(result.status, "spawned", JSON.stringify(result));
  assert.ok(result.warnings?.some(({ code }) => code === "asgrep_index_failed"));
  assert.ok(f.tab().includes("ASGREP_CODEMODE_BACKEND=cli"));
});

// Why: invalid timeout input must not silently disable either hard bound.
test("worker asgrep invalid timeout falls back to bounded defaults", async (t) => {
  const f = fixture(t);
  process.env.PAD_WORKER_ASGREP_INDEX_TIMEOUT_MS = "0";
  const original = childProcess.execFile;
  let timeout;
  childProcess.execFile = (...args) => { timeout = args[2].timeout; return original(...args); };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  const result = await executeHerdrSpawnWorker(f.params, f.context, { ...f.options, asgrep: { binary: f.binary, timeoutMs: Infinity } });
  assert.equal(result.status, "spawned");
  assert.ok(f.tab().includes("ASGREP_TIMEOUT_MS=30000"));
  assert.equal(timeout, 120000);
});
