// Why: isolate pane-readiness regressions so fail-first does not run unrelated worktree tests.
// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { executeHerdrSpawnWorker } from "../scripts/enforcement/herdr_lifecycle_pi.js";

const WORKER_REPO = "agents-work";
const ROUTE_POLICY = Object.freeze({
  schema: "agentic-driver.model-route-policy.v1",
  routes: [{ provider: "fixture", model: "model-x", family: "family-x", subscription: true, gateway: false, aliases: ["Model X"] }],
  bannedPairs: [],
  budgets: {},
});

// Why: exercise the real process boundary and read-backs without any live Herdr calls.
const FAKE_HERDR = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n", { flag: "a" });
const mode = process.env.FAKE_HERDR_MODE;
const emit = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const fail = (code, message) => {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
const command = argv.slice(0, 2).join(" ");
if (command === "workspace list") emit({ workspaces: [{ label: "agents-work", workspace_id: "w7" }] });
if (command === "agent list") emit({ agents: [] });
if (command === "tab list") emit({ tabs: [] });
if (command === "pane current") emit({ result: { pane_id: "w7:p1", tab_id: "w7:t1" } });
if (command === "tab create") {
  writeFileSync(process.env.FAKE_HERDR_PANE_STATE, argv[argv.indexOf("--cwd") + 1]);
  emit({ result: { root_pane: { pane_id: "w7:p10" }, tab: { tab_id: "w7:t3" } } });
}
if (command === "agent start") {
  const startCount = readFileSync(process.env.FAKE_HERDR_LOG, "utf8").split("\\n").filter((line) => line.includes('"start"')).length;
  if ((mode === "busy-five" && startCount <= 5) || mode === "busy-always")
    fail("agent_pane_busy", "pane shell is starting");
  if (mode === "start-fail") fail("start_failed", "the agent could not start");
}
if (command === "agent start" || command === "agent get") {
  emit({ result: { type: command === "agent start" ? "agent_started" : "agent", ...(command === "agent start" ? { argv } : {}), agent: { name: argv[2], agent: "pi", pane_id: "w7:p10",
    cwd: readFileSync(process.env.FAKE_HERDR_PANE_STATE, "utf8"), launch_pending: false, interactive_ready: true } } });
}
if (command === "pane get") emit({ result: { type: "pane", pane: { pane_id: argv[2], cwd: readFileSync(process.env.FAKE_HERDR_PANE_STATE, "utf8") } } });
fail("unknown_command", JSON.stringify(argv));
`;

function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "fixture");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return git;
}

function fixture(mode) {
  const scratch = new URL("../.local/", import.meta.url);
  mkdirSync(scratch, { recursive: true });
  const root = realpathSync(mkdtempSync(join(scratch.pathname, "pane-readiness-")));
  const coordinator = join(root, "coordinator");
  gitRepo(coordinator);
  gitRepo(join(root, WORKER_REPO))("remote", "add", "origin", `git@github.com:evoclock/${WORKER_REPO}.git`);
  const policyDir = join(root, "profile", "config");
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, "relay-authority.v1.json"), JSON.stringify({
    schema: "relay-authority.v1", githubOwner: "evoclock", denyRepositories: [],
  }));
  const log = join(root, "herdr-log.jsonl");
  const fake = join(root, "fake-herdr.mjs");
  writeFileSync(fake, FAKE_HERDR);
  chmodSync(fake, 0o755);
  const environment = {
    PI_CODING_AGENT_DIR: join(root, "profile"),
    HERDR_PANE_ID: "w7:p1",
    FAKE_HERDR_LOG: log,
    FAKE_HERDR_MODE: mode,
    FAKE_HERDR_PANE_STATE: join(root, "pane-state"),
  };
  const saved = Object.fromEntries([
    ...Object.keys(environment), "PAD_HERDR_PANE_READY_TIMEOUT_MS", "PAD_HERDR_PANE_READY_POLL_MS",
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  return {
    root, log, saved,
    params: { placement: "tab", role: "worker", model: "fixture/model-x", repository: WORKER_REPO },
    context: { mode: "tui", hasUI: true, ui: { confirm: async () => true }, cwd: coordinator },
    herdrOptions: {
      testExecutablePath: fake,
      listModels: "provider model\nfixture model-x\n",
      modelsPath: join(root, "absent-models.json"),
      routePolicy: ROUTE_POLICY,
    },
  };
}

function readLog(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function cleanup(f) {
  for (const [key, value] of Object.entries(f.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(f.root, { recursive: true, force: true });
}

// Why: synthetic time proves slow-shell recovery, bounded timeout, short overrides and immediate non-busy failure.
for (const scenario of [
  { mode: "busy-five", timeoutMs: 2000, expected: "spawned", count: 6 },
  { mode: "busy-always", timeoutMs: 1000, expected: "partial", count: 4 },
  { mode: "busy-five", timeoutMs: 500, expected: "partial", count: 2 },
  { mode: "start-fail", timeoutMs: 2000, expected: "partial", count: 1 },
]) {
  // Why: each deadline must bound retries on the original pane and reject non-busy failures immediately.
  test(`pane readiness ${scenario.mode} with ${scenario.timeoutMs}ms deadline`, async () => {
    const f = fixture(scenario.mode);
    let elapsed = 0;
    try {
      process.env.PAD_HERDR_PANE_READY_TIMEOUT_MS = String(scenario.timeoutMs);
      process.env.PAD_HERDR_PANE_READY_POLL_MS = "250";
      const result = await executeHerdrSpawnWorker(f.params, f.context, {
        ...f.herdrOptions,
        paneReadyNow: () => elapsed,
        paneReadySleep: async (ms) => { elapsed += ms; },
      });
      assert.equal(result.status, scenario.expected, JSON.stringify(result));
      if (scenario.expected === "partial") assert.equal(result.code, "start_failed");
      const calls = readLog(f.log).map(({ argv }) => argv);
      const starts = calls.filter(([a, b]) => a === "agent" && b === "start");
      assert.equal(starts.length, scenario.count);
      assert.ok(starts.every((argv) => JSON.stringify(argv) === JSON.stringify(starts[0])));
      assert.equal(calls.filter(([a, b]) => a === "tab" && b === "create").length, 1);
      assert.equal(elapsed, scenario.mode === "start-fail" ? 0 : Math.min(scenario.timeoutMs, 1250));
    } finally { cleanup(f); }
  });
}
