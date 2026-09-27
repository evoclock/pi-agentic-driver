// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Attended Electron-specific driver boundary tests: the explicit
// electron-attended context class (never a Pi-TUI representation), the
// read-only preflight stage (context, closed parameters, trusted repository,
// installed model roll, executable availability, duplicate-role observation),
// and the single-attempt commit stage (one native confirmation, tab-only
// topology, exact argv/read-back, no retry). All Herdr interaction goes
// through a REAL fake Herdr process (testExecutablePath with shell:false
// spawn), never a recorder replacing the guarded lifecycle. No live Herdr,
// no live workers, no provider calls.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ATTENDED_ELECTRON_BOUNDARY,
  executeHerdrSpawnWorkerAttendedElectron,
  preflightAttendedElectronSpawn,
} from "../scripts/enforcement/herdr_lifecycle_pi.js";
import { pulseWorkerSpawnSeam } from "../scripts/enforcement/pulse_scheduler_pi.js";
import {
  ATTENDED_ELECTRON_CONTEXT_MODE,
  isAttendedElectronContext,
  isNativeTuiContext,
} from "../scripts/enforcement/native_tui_context.js";

const WORKER_REPO = "agents-work";
const MODEL = "glm53flash/glm-5.3-flash";
const MODEL_ROLL = "provider model\nzai glm-5.3\nglm53flash glm-5.3-flash\n";

// A real fake Herdr process: invoked exactly as production invokes Herdr
// (direct argv, no shell), it records every argv it receives and answers the
// documented layout/start/read-back sequence. Modes exercise failure shapes.
const FAKE_HERDR = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ argv }) + "\\n");
const mode = process.env.FAKE_HERDR_MODE ?? "";
const emit = (value) => { process.stdout.write(JSON.stringify(value)); };
const fail = (code, message) => {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
const command = argv[0];
if (command === "agent" && argv[1] === "list") {
  if (mode === "duplicate") emit({ agents: [{ name: argv[2] || "worker" }] });
  else emit({ agents: [] });
  process.exit(0);
}
if (command === "tab" && argv[1] === "create") {
  if (mode === "tab-fail") fail("layout_failed", "the layout could not be created");
  emit({ id: 41, result: { root_pane: { pane_id: "w7:p10" }, tab: { tab_id: "w7:t3" } } });
  process.exit(0);
}
if (command === "agent" && argv[1] === "start") {
  if (mode === "start-fail") fail("start_failed", "the agent could not start");
  if (mode === "wrong-model") {
    emit({ result: { type: "agent_started", argv: ["agent", "start", ...argv.slice(2, -2), "--model", "other/model"],
      agent: { name: argv[2], agent: "pi", pane_id: "w7:p10", cwd: process.cwd(), launch_pending: false, interactive_ready: true } } });
    process.exit(0);
  }
  emit({ result: { type: "agent_started", argv,
    agent: { name: argv[2], agent: "pi", pane_id: "w7:p10", cwd: process.cwd(), launch_pending: false, interactive_ready: true } } });
  process.exit(0);
}
if (command === "agent" && argv[1] === "get") {
  emit({ result: { type: "agent", agent: { name: argv[2], agent: "pi", pane_id: "w7:p10", cwd: process.cwd(), launch_pending: false, interactive_ready: true } } });
  process.exit(0);
}
if (command === "pane" && argv[1] === "get") {
  emit({ result: { type: "pane", pane: { pane_id: argv[2], cwd: process.cwd() } } });
  process.exit(0);
}
fail("unknown_command", JSON.stringify(argv));
`;

function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "attended-electron-"));
  const coordinator = gitRepo(join(root, "coordinator"));
  const workerRoot = gitRepo(join(root, WORKER_REPO));
  const registryDir = join(coordinator, "config");
  mkdirSync(registryDir, { recursive: true });
  if (!options.noRegistry) {
    writeFileSync(
      join(registryDir, "herdr-worker-repositories.v1.json"),
      JSON.stringify({
        schema: "agentic-driver.herdr-worker-repositories.v1",
        repositories: options.registryNames ?? [WORKER_REPO],
      }),
    );
  }
  // Isolate the profile-level registry fallback: point PI_CODING_AGENT_DIR at
  // an empty per-fixture profile so the shared config on the host machine can
  // never leak into the offline test decision.
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");
  const log = join(root, "herdr-log.jsonl");
  const fake = join(root, "fake-herdr.mjs");
  writeFileSync(fake, FAKE_HERDR);
  chmodSync(fake, 0o755);
  process.env.FAKE_HERDR_LOG = log;
  process.env.FAKE_HERDR_MODE = options.mode ?? "";
  const herdrOptions = {
    testExecutablePath: fake,
    listModels: MODEL_ROLL,
    modelsPath: join(root, "absent-models.json"),
  };
  if (options.missingExecutable) {
    // An injected path that does not exist: exercises the executable
    // verification branch locally with no process spawn, independent of
    // whether the host machine has a real trusted Herdr installed.
    herdrOptions.testExecutablePath = join(root, "absent-herdr");
  }
  const context = {
    mode: ATTENDED_ELECTRON_CONTEXT_MODE,
    hasUI: true,
    ui: { confirm: options.confirm ?? (async () => true) },
    cwd: options.cwd ?? coordinator,
  };
  const params = {
    placement: options.placement ?? "tab",
    role: options.role ?? "worker",
    model: options.model ?? MODEL,
    repository: options.repository ?? WORKER_REPO,
  };
  return { root, coordinator, workerRoot, log, herdrOptions, context, params };
}

function readLog(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).argv);
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
}

test("the attended Electron context class is explicit and disjoint from the Pi TUI", () => {
  const electron = { mode: "electron-attended", hasUI: true, ui: { confirm: () => true }, cwd: "/tmp" };
  const tui = { mode: "tui", hasUI: true, ui: { confirm: () => true }, cwd: "/tmp" };
  assert.equal(isAttendedElectronContext(electron), true);
  assert.equal(isNativeTuiContext(electron), false, "an Electron context must never satisfy the TUI predicate");
  assert.equal(isAttendedElectronContext(tui), false, "a TUI context must never satisfy the Electron predicate");
  assert.equal(isNativeTuiContext(tui), true);
  assert.equal(isAttendedElectronContext(null), false);
  assert.equal(isAttendedElectronContext({ mode: "electron-attended", hasUI: true, ui: null, cwd: "/tmp" }), false);
  assert.equal(isAttendedElectronContext({ mode: "electron-attended", hasUI: true, ui: { confirm: 5 }, cwd: "/tmp" }), false);
});

test("preflight verifies every prerequisite read-only and observes duplicates once", async () => {
  const f = fixture();
  try {
    const result = await preflightAttendedElectronSpawn(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, true);
    assert.equal(result.status, "preflight-verified");
    assert.equal(result.boundary, ATTENDED_ELECTRON_BOUNDARY);
    assert.equal(result.placement, "tab");
    assert.deepEqual(result.modelArgv, ["--model", MODEL]);
    assert.equal(result.repository, realpathSync(f.workerRoot));
    assert.equal(result.nonAuthorizing, true);
    assert.equal(result.authorityCreated, false);
    assert.deepEqual(readLog(f.log), [["agent", "list"]], "preflight only observes");
  } finally {
    cleanup(f.root);
  }
});

test("preflight refuses an untrusted repository before any Herdr call", async () => {
  const f = fixture({ registryNames: ["other-repo"] });
  try {
    const result = await preflightAttendedElectronSpawn(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "repository_untrusted");
    assert.equal(result.status, "denied");
    assert.deepEqual(readLog(f.log), [], "no Herdr invocation happens for an untrusted repository");
  } finally {
    cleanup(f.root);
  }
});

test("preflight refuses a missing registry without fallback assumptions", async () => {
  const f = fixture({ noRegistry: true });
  try {
    const result = await preflightAttendedElectronSpawn(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "worker_registry_invalid");
    assert.deepEqual(readLog(f.log), []);
  } finally {
    cleanup(f.root);
  }
});

test("preflight refuses a model outside the installed roll", async () => {
  const f = fixture({ model: "glm53flash/no-such-model" });
  try {
    const result = await preflightAttendedElectronSpawn(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "model_unknown");
    assert.deepEqual(readLog(f.log), []);
  } finally {
    cleanup(f.root);
  }
});

test("preflight refuses when the trusted executable is missing", async () => {
  const f = fixture({ missingExecutable: true });
  try {
    const result = await preflightAttendedElectronSpawn(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "herdr_unavailable");
    assert.deepEqual(readLog(f.log), [], "no process spawn is attempted for a missing executable");
  } finally {
    cleanup(f.root);
  }
});

test("preflight refuses wrong context classes and missing host cwd", async () => {
  const f = fixture();
  try {
    const nullContext = await preflightAttendedElectronSpawn(f.params, null, f.herdrOptions);
    assert.equal(nullContext.code, "attended_electron_context_required");
    const tuiContext = await preflightAttendedElectronSpawn(f.params, { ...f.context, mode: "tui" }, f.herdrOptions);
    assert.equal(tuiContext.code, "attended_electron_context_required");
    const noCwd = await preflightAttendedElectronSpawn(f.params, { ...f.context, cwd: " " }, f.herdrOptions);
    assert.equal(noCwd.code, "attended_electron_context_required");
    assert.deepEqual(readLog(f.log), []);
  } finally {
    cleanup(f.root);
  }
});

test("pane placements are refused: no pane identity is manufactured or inherited", async () => {
  for (const placement of ["right", "below"]) {
    const f = fixture({ placement });
    try {
      const pre = await preflightAttendedElectronSpawn(f.params, f.context, f.herdrOptions);
      assert.equal(pre.ok, false);
      assert.equal(pre.code, "pane_identity_unavailable");
      assert.equal(pre.status, "denied");
      const commit = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
      assert.equal(commit.ok, false);
      assert.equal(commit.code, "pane_identity_unavailable");
      assert.deepEqual(readLog(f.log), [], "no Herdr call is made for pane placements");
    } finally {
      cleanup(f.root);
    }
  }
});

test("the commit stage performs one guarded verified start with exact argv and read-back", async () => {
  const f = fixture();
  const confirmations = [];
  f.context.ui.confirm = async (title, message) => {
    confirmations.push({ title, message });
    return true;
  };
  try {
    process.env.HERDR_PANE_ID = "w9:p99"; // must never be used or inherited
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    delete process.env.HERDR_PANE_ID;
    assert.equal(result.ok, true);
    assert.equal(result.status, "spawned");
    assert.equal(result.boundary, ATTENDED_ELECTRON_BOUNDARY);
    assert.equal(result.placement, "tab");
    assert.equal(result.direction, null);
    assert.equal(result.paneId, "w7:p10");
    assert.equal(result.rootPaneId, "w7:p10");
    assert.equal(result.tabId, "w7:t3");
    assert.deepEqual(result.modelArgv, ["--model", MODEL]);
    assert.equal(result.repository, realpathSync(f.workerRoot));
    assert.equal(result.authorityCreated, false);
    assert.equal(confirmations.length, 1, "exactly one native confirmation");
    assert.ok(confirmations[0].message.includes("attended-Electron"));
    assert.ok(confirmations[0].message.includes(MODEL));
    assert.deepEqual(readLog(f.log), [
      ["agent", "list"],
      ["tab", "create", "--cwd", realpathSync(f.workerRoot), "--no-focus", "--label", "worker"],
      ["agent", "start", "worker", "--kind", "pi", "--pane", "w7:p10", "--timeout", "120000", "--", "--model", MODEL],
      ["agent", "get", "worker"],
      ["pane", "get", "w7:p10"],
    ], "the exact guarded argv sequence, shell-free, with the exact nested provider/model");
    const argvText = JSON.stringify(readLog(f.log));
    assert.ok(!argvText.includes("pane current") && !argvText.includes("pane split"));
    assert.ok(!argvText.includes("w9:p99"), "an inherited HERDR_PANE_ID value never reaches the boundary");
  } finally {
    delete process.env.HERDR_PANE_ID;
    cleanup(f.root);
  }
});

test("a denied confirmation stops before any mutation and is never re-asked", async () => {
  const f = fixture({ confirm: async () => false });
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "confirmation_denied");
    assert.equal(result.status, "stopped");
    assert.deepEqual(readLog(f.log), [["agent", "list"]], "only the read-only duplicate observation ran");
  } finally {
    cleanup(f.root);
  }
});

test("a throwing confirmation is a structured refusal with no mutation", async () => {
  const f = fixture({ confirm: async () => { throw new Error("dialog crashed"); } });
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "confirmation_failed");
    assert.equal(result.status, "blocked");
    assert.deepEqual(readLog(f.log), [["agent", "list"]]);
  } finally {
    cleanup(f.root);
  }
});

test("a duplicate live role is denied before the confirmation ask", async () => {
  const asked = [];
  const f = fixture({ mode: "duplicate", confirm: async () => { asked.push(1); return true; } });
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "duplicate_worker_name");
    assert.equal(asked.length, 0, "no confirmation was requested");
    assert.deepEqual(readLog(f.log), [["agent", "list"]]);
  } finally {
    cleanup(f.root);
  }
});

test("a post-confirmation registry race refuses before any mutation", async () => {
  const f = fixture();
  const registryPath = join(f.coordinator, "config", "herdr-worker-repositories.v1.json");
  f.context.ui.confirm = async () => {
    rmSync(registryPath);
    return true;
  };
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "worker_registry_invalid");
    assert.deepEqual(readLog(f.log), [["agent", "list"]], "no tab was created for a raced-away registry");
  } finally {
    cleanup(f.root);
  }
});

test("a failed start is one attempt only and reports a partial with cleanup guidance", async () => {
  const f = fixture({ mode: "start-fail" });
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.status, "partial");
    assert.equal(result.partial, "tab_created");
    assert.equal(result.code, "start_failed");
    assert.equal(result.tabId, "w7:t3");
    assert.ok(typeof result.cleanup === "string" && result.cleanup.length > 0);
    const starts = readLog(f.log).filter((argv) => argv[0] === "agent" && argv[1] === "start");
    assert.equal(starts.length, 1, "exactly one start attempt: no retry");
  } finally {
    cleanup(f.root);
  }
});

test("a tab-creation failure is one attempt only and reports a partial", async () => {
  const f = fixture({ mode: "tab-fail" });
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.status, "partial");
    assert.equal(result.partial, "tab_created");
    assert.equal(result.code, "herdr_process_failed");
    const tabs = readLog(f.log).filter((argv) => argv[0] === "tab");
    assert.equal(tabs.length, 1, "exactly one tab-creation attempt");
  } finally {
    cleanup(f.root);
  }
});

test("a read-back model-argv mismatch fails closed after the one start", async () => {
  const f = fixture({ mode: "wrong-model" });
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "model_argv_mismatch");
    assert.equal(result.status, "partial");
    assert.equal(result.partial, "agent_started", "the start mutation is never erased or retried");
    const starts = readLog(f.log).filter((argv) => argv[0] === "agent" && argv[1] === "start");
    assert.equal(starts.length, 1);
  } finally {
    cleanup(f.root);
  }
});

test("the pulse seam dispatches by explicit context class and fails closed when unbound", async () => {
  const f = fixture();
  const canonicalRepository = join(dirname(f.coordinator), WORKER_REPO);
  const tuiContext = { mode: "tui", hasUI: true, ui: { confirm: async () => true }, cwd: f.coordinator };
  try {
    const calls = { tui: [], attended: [] };
    const spawnOptions = { testExecutablePath: f.herdrOptions.testExecutablePath };
    const seam = pulseWorkerSpawnSeam({
      executeHerdrSpawnWorker: async (params, context, options) => {
        calls.tui.push({ params, context, options });
        return { ok: true, boundary: "tui-stub" };
      },
      executeHerdrSpawnWorkerAttendedElectron: async (params, context, options) => {
        calls.attended.push({ params, context, options });
        return { ok: true, boundary: ATTENDED_ELECTRON_BOUNDARY };
      },
      spawnOptions,
    });
    const envelope = { seatId: "seat-1", model: MODEL, provider: "glm53flash" };
    const seamInput = { role: "worker", repository: canonicalRepository, model: MODEL, placement: "host", context: f.context, envelope, provider: "glm53flash", seatId: "seat-1", endpointRef: "seat-1" };

    const attended = await seam(seamInput);
    assert.equal(attended.ok, true);
    assert.equal(calls.attended.length, 1);
    assert.deepEqual(calls.attended[0].params, { placement: "tab", role: "worker", model: MODEL, repository: WORKER_REPO });
    assert.equal(calls.attended[0].context, f.context);
    assert.equal(calls.attended[0].options, spawnOptions, "spawnOptions are forwarded to the attended executor");

    const tui = await seam({ ...seamInput, context: tuiContext });
    assert.equal(tui.ok, true);
    assert.equal(calls.tui.length, 1, "the TUI path still reaches executeHerdrSpawnWorker");
    assert.deepEqual(calls.tui[0].params, { placement: "tab", role: "worker", model: MODEL, repository: WORKER_REPO });
    assert.equal(calls.tui[0].options, spawnOptions);
    assert.equal(calls.attended.length, 1, "the TUI context never reaches the attended executor");

    const unbound = pulseWorkerSpawnSeam({
      executeHerdrSpawnWorker: async () => ({ ok: true }),
    });
    const refused = await unbound(seamInput);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "attended-electron-seam-required");

    const nonSibling = await seam({ ...seamInput, repository: join(f.root, "elsewhere", WORKER_REPO) });
    assert.equal(nonSibling.ok, false);
    assert.equal(nonSibling.code, "repository-mismatch");
    assert.equal(calls.attended.length, 1, "non-sibling repositories are refused before any executor");
  } finally {
    cleanup(f.root);
  }
});

test("a native TUI lifecycle still refuses a missing HERDR_PANE_ID (never manufactured)", async () => {
  const f = fixture();
  try {
    const hadPaneId = process.env.HERDR_PANE_ID;
    delete process.env.HERDR_PANE_ID;
    const tuiContext = { mode: "tui", hasUI: true, ui: { confirm: async () => true }, cwd: f.coordinator };
    const { executeHerdrSpawnWorker } = await import("../scripts/enforcement/herdr_lifecycle_pi.js");
    const result = await executeHerdrSpawnWorker(
      { placement: "below", role: "worker", model: MODEL, repository: WORKER_REPO },
      tuiContext,
      f.herdrOptions,
    );
    if (hadPaneId !== undefined) process.env.HERDR_PANE_ID = hadPaneId;
    assert.equal(result.ok, false);
    assert.equal(result.code, "current_pane_unavailable");
    assert.deepEqual(readLog(f.log), [], "the TUI path does not manufacture a pane identity either");
  } finally {
    cleanup(f.root);
  }
});
