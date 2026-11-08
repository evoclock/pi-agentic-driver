// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Optional worktree target for the guarded spawn. A model-supplied path is
// NEVER authority: it must be the absolute canonical Git worktree root of the
// registry-authorized repository, and it must carry an active Treehouse lease
// observed read-only. These tests use real synthetic Git worktrees plus a real
// fake Herdr process (testExecutablePath, shell:false) and synthetic Treehouse
// status JSON through the injected evidence seam. No live Herdr, no live
// workers, no lease acquire/return, no tab spawn.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  executeHerdrSpawnWorker,
  executeHerdrSpawnWorkerAttendedElectron,
  preflightAttendedElectronSpawn,
  resolveTrustedSpawnRepository,
  resolveWorktreeSpawnTarget as resolveWorktreeSpawnTargetPublic,
  validateSpawnParams,
} from "../scripts/enforcement/herdr_lifecycle_pi.js";

const WORKER_REPO = "agents-work";
const MODEL = "fixture/model-x";
const MODEL_ROLL = "provider model\nfixture model-x\n";
// Synthetic fixture policy only: the private resolver requires a route policy
// through the existing internal seam. Never a personal policy file.
const ROUTE_POLICY = Object.freeze({
  schema: "agentic-driver.model-route-policy.v1",
  routes: [{ provider: "fixture", model: "model-x", family: "family-x", subscription: true, gateway: false, aliases: ["Model X"] }],
  bannedPairs: [],
  budgets: {},
});
// Synthetic fixture identity only: never a real session lease id or timestamp.
const LEASE_ID = "0123456789abcdef0123456789abcdef";
const LEASE_TIMESTAMP = "2020-01-01T00:00:00.000000+00:00";

// The fake persists the pane cwd it was asked to create (from `--cwd`) and
// reports THAT state on agent/pane read-back. It never echoes the adapter's own
// process cwd, so a wrong target cwd cannot pass unnoticed.
const FAKE_HERDR = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n", { flag: "a" });
const mode = process.env.FAKE_HERDR_MODE ?? "";
const emit = (value) => { process.stdout.write(JSON.stringify(value)); };
const fail = (code, message) => {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
const readPaneState = () => {
  try { return JSON.parse(readFileSync(process.env.FAKE_HERDR_PANE_STATE, "utf8")); } catch { return {}; }
};
const writePaneState = (paneId, cwd) => {
  const state = readPaneState();
  state[paneId] = cwd;
  writeFileSync(process.env.FAKE_HERDR_PANE_STATE, JSON.stringify(state));
};
const paneCwd = (paneId) => readPaneState()[paneId] ?? "<unknown-pane>";
const cwdArg = () => {
  const index = argv.indexOf("--cwd");
  return index >= 0 ? argv[index + 1] : process.cwd();
};
const command = argv[0];
if (command === "workspace" && argv[1] === "list") {
  emit({ workspaces: [{ label: mode === "foreign-workspace" ? "other-repo" : "agents-work", workspace_id: "w7" }] }); process.exit(0);
}
if (command === "pane" && argv[1] === "list") {
  emit({ panes: [{ workspace_id: "w7", cwd: mode === "foreign-pane" ? "/not/the/repository" : process.env.FAKE_HERDR_WORKER_ROOT }] }); process.exit(0);
}
if (command === "agent" && argv[1] === "list") {
  if (mode === "duplicate") emit({ agents: [{ name: argv[2] || "worker" }] });
  else emit({ agents: [] });
  process.exit(0);
}
if (command === "tab" && argv[1] === "create") {
  if (mode === "mutate-lease") {
    const state = JSON.parse(readFileSync(process.env.FAKE_HERDR_STATE, "utf8"));
    state[0].lease_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(process.env.FAKE_HERDR_STATE, JSON.stringify(state));
  }
  if (mode === "tab-fail") fail("layout_failed", "the layout could not be created");
  if (mode === "tab-wrong-cwd") {
    writePaneState("w7:p10", "/definitely/not/the/target");
  } else {
    writePaneState("w7:p10", cwdArg());
  }
  emit({ id: 41, result: { root_pane: { pane_id: "w7:p10" }, tab: { tab_id: "w7:t3" } } });
  process.exit(0);
}
if (command === "pane" && argv[1] === "split") {
  writePaneState("w7:p10", mode === "split-wrong-cwd" ? "/definitely/not/the/target" : cwdArg());
  emit({ id: 42, result: { pane: { pane_id: "w7:p10", tab_id: "w1:t1" } } });
  process.exit(0);
}
if (command === "agent" && argv[1] === "start") {
  if (mode === "start-fail") fail("start_failed", "the agent could not start");
  emit({ result: { type: "agent_started", argv,
    agent: { name: argv[2], agent: "pi", pane_id: "w7:p10", cwd: paneCwd("w7:p10"), launch_pending: false, interactive_ready: true } } });
  process.exit(0);
}
if (command === "agent" && argv[1] === "get") {
  emit({ result: { type: "agent", agent: { name: argv[2], agent: "pi", pane_id: "w7:p10", cwd: paneCwd("w7:p10"), launch_pending: false, interactive_ready: true } } });
  process.exit(0);
}
if (command === "pane" && argv[1] === "get") {
  emit({ result: { type: "pane", pane: { pane_id: argv[2], cwd: paneCwd(argv[2]) } } });
  process.exit(0);
}
if (command === "pane" && argv[1] === "current") {
  emit({ result: { pane_id: "w7:p1", tab_id: "w7:t1" } });
  process.exit(0);
}
fail("unknown_command", JSON.stringify(argv));
`;

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

function makeWorktree(repo, path, branch = "lease-slot") {
  git(repo, ["worktree", "add", "-q", "-b", branch, path]);
  return path;
}

function fixture(options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-spawn-")));
  const coordinator = gitRepo(join(root, "coordinator"));
  const workerRoot = gitRepo(join(root, options.workerDirectory ?? WORKER_REPO));
  git(workerRoot, ["remote", "add", "origin", `git@github.com:evoclock/${WORKER_REPO}.git`]);
  const policyDir = join(root, "profile", "config");
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, "relay-authority.v1.json"), JSON.stringify({
    schema: "relay-authority.v1", githubOwner: "evoclock", denyRepositories: [],
  }));
  const registryDir = join(coordinator, "config");
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    join(registryDir, "herdr-worker-repositories.v1.json"),
    JSON.stringify({
      schema: "agentic-driver.herdr-worker-repositories.v1",
      repositories: options.registryNames ?? [WORKER_REPO],
    }),
  );
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");

  const pool = join(root, "pool", "slot6", WORKER_REPO);
  const worktree = options.noWorktree ? null : makeWorktree(workerRoot, pool, "fix/lease-slot");
  const branch = worktree ? git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
  const lease = {
    name: "1",
    path: worktree ?? pool,
    status: "leased",
    branch,
    lease_id: LEASE_ID,
    lease_holder: "worktree-spawn-test",
    leased_at: LEASE_TIMESTAMP,
    processes: [],
  };
  const leaseState = options.leaseStatus === "unleased"
    ? [{ ...lease, status: "available", lease_id: undefined, lease_holder: undefined }]
    : options.leaseStatus === "missing" ? [] : [lease];
  const statePath = join(root, "treehouse-status.json");
  writeFileSync(statePath, JSON.stringify(options.leaseStateOverride ?? leaseState));

  const log = join(root, "herdr-log.jsonl");
  const fake = join(root, "fake-herdr.mjs");
  writeFileSync(fake, FAKE_HERDR);
  chmodSync(fake, 0o755);
  process.env.FAKE_HERDR_LOG = log;
  process.env.FAKE_HERDR_MODE = options.mode ?? "";
  process.env.FAKE_HERDR_STATE = statePath;
  process.env.FAKE_HERDR_PANE_STATE = join(root, "pane-state.json");
  process.env.FAKE_HERDR_WORKER_ROOT = workerRoot;

  const herdrOptions = {
    testExecutablePath: fake,
    listModels: MODEL_ROLL,
    modelsPath: join(root, "absent-models.json"),
    routePolicy: ROUTE_POLICY,
    treehouseStatus: () => readFileSync(statePath, "utf8"),
  };
  if (options.noTreehouseSeam) delete herdrOptions.treehouseStatus;

  const context = {
    mode: options.boundary === "attended" ? "electron-attended" : "tui",
    hasUI: true,
    ui: { confirm: options.confirm ?? (async () => true) },
    cwd: options.cwd ?? coordinator,
  };
  const params = {
    placement: options.placement ?? "tab",
    role: options.role ?? "worker",
    model: options.model ?? MODEL,
    repository: options.repository ?? WORKER_REPO,
    ...(options.omitTarget ? {} : { worktreePath: options.worktreePath ?? worktree }),
  };
  return { root, coordinator, workerRoot, worktree, pool, statePath, lease, log, herdrOptions, context, params };
}

function readLog(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter(({ argv }) => !["workspace", "pane"].includes(argv[0]) || argv[1] !== "list");
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.HERDR_PANE_ID;
  delete process.env.FAKE_HERDR_PANE_STATE;
  delete process.env.FAKE_HERDR_STATE;
}

// Why: Older callers remain valid while explicit targets reject relative paths.
test("a parameterized target is optional and bounded: old four-key calls stay valid", () => {
  const base = { placement: "tab", role: "worker", model: MODEL, repository: WORKER_REPO };
  assert.equal(validateSpawnParams(base).worktreePath, undefined);
  assert.equal(validateSpawnParams({ ...base, worktreePath: "/abs/slot" }).worktreePath, "/abs/slot");
  assert.throws(() => validateSpawnParams({ ...base, worktreePath: "relative/slot" }),
    (error) => error.code === "worktree_target_invalid");
  assert.throws(() => validateSpawnParams({ ...base, worktreePath: "" }),
    (error) => error.code === "worktree_target_invalid");
  assert.throws(() => validateSpawnParams({ ...base, worktreePath: "/abs", extra: 1 }),
    (error) => error.code === "closed_parameters");
});

// Why: A new owned checkout needs no prior registry entry or registration prompt.
test("guarded start accepts a verified sibling even when absent from the registry", async () => {
  const f = fixture({ registryNames: ["another-repo"], omitTarget: true });
  process.env.HERDR_PANE_ID = "synthetic-pane";
  try {
    assert.equal(resolveTrustedSpawnRepository(f.coordinator, WORKER_REPO), f.workerRoot);
    f.context.ui.confirm = () => { throw new Error("no registration or spawn prompt expected"); };
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.status, "spawned", JSON.stringify(result));
  } finally { cleanup(f.root); }
});

// Why: a public-named checkout may track the configured owner's private development repository.
test("guarded start accepts a private-first origin with a different repository name", async () => {
  const f = fixture({ registryNames: ["another-repo"], omitTarget: true });
  process.env.HERDR_PANE_ID = "synthetic-pane";
  try {
    git(f.workerRoot, ["remote", "set-url", "origin", "git@github.com:evoclock/agents-work-agents.git"]);
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.status, "spawned", JSON.stringify(result));
  } finally { cleanup(f.root); }
});

// Why: GitHub preserves repo-name case; matching origins stay eligible without weakening owner and name checks.
test("mixed-case SSH and HTTPS origin names are accepted; foreign and malformed origins remain denied", () => {
  const f = fixture({ omitTarget: true });
  try {
    for (const origin of [
      "git@github.com:evoclock/Agents-Work.git",
      "https://github.com/evoclock/Agents-Work.git",
    ]) {
      git(f.workerRoot, ["remote", "set-url", "origin", origin]);
      assert.equal(resolveTrustedSpawnRepository(f.coordinator, WORKER_REPO), f.workerRoot, origin);
    }
    for (const origin of [
      "git@github.com:elsewhere/Agents-Work.git",
      "https://github.com/elsewhere/Agents-Work.git",
      "git@github.com:evoclock/Agents_Work.git",
      "https://github.com/evoclock/Agents.Work.git",
    ]) {
      git(f.workerRoot, ["remote", "set-url", "origin", origin]);
      assert.throws(() => resolveTrustedSpawnRepository(f.coordinator, WORKER_REPO),
        (error) => error.code === "repository_origin_untrusted", origin);
    }
  } finally { cleanup(f.root); }
});

// Why: Git's alternate toplevel spelling is the same folder only when device and inode match, even on Linux.
test("Git root spelling with the same inode accepts a lowercase request", () => {
  const f = fixture({ noWorktree: true, omitTarget: true });
  const alternate = join(f.root, "git-toplevel-spelling");
  symlinkSync(f.workerRoot, alternate, "dir");
  const original = childProcess.spawnSync;
  try {
    assert.notEqual(alternate, f.workerRoot);
    assert.equal(statSync(alternate).dev, statSync(f.workerRoot).dev);
    assert.equal(statSync(alternate).ino, statSync(f.workerRoot).ino);
    childProcess.spawnSync = (command, args, options) =>
      command === "git" && args.includes("--show-toplevel")
        ? { status: 0, stdout: `${alternate}\n` }
        : original(command, args, options);
    syncBuiltinESMExports();
    assert.equal(resolveTrustedSpawnRepository(f.coordinator, WORKER_REPO), f.workerRoot);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    cleanup(f.root);
  }
});

// Why: equal case-folded names do not make two distinct Git roots the same folder.
test("Git root spelling with a different inode denies a lowercase request", () => {
  const f = fixture({ noWorktree: true, omitTarget: true });
  const alternate = gitRepo(join(f.root, "other", "Agents-Work"));
  const original = childProcess.spawnSync;
  try {
    assert.equal(alternate.split("/").at(-1).toLowerCase(), WORKER_REPO);
    assert.notEqual(`${statSync(alternate).dev}:${statSync(alternate).ino}`,
      `${statSync(f.workerRoot).dev}:${statSync(f.workerRoot).ino}`);
    childProcess.spawnSync = (command, args, options) =>
      command === "git" && args.includes("--show-toplevel")
        ? { status: 0, stdout: `${alternate}\n` }
        : original(command, args, options);
    syncBuiltinESMExports();
    assert.throws(() => resolveTrustedSpawnRepository(f.coordinator, WORKER_REPO),
      (error) => error.code === "repository_not_git_root");
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    cleanup(f.root);
  }
});

// Why: a foreign or excluded remote must fail before layout even if the checkout exists.
test("guarded start refuses a foreign origin or denied name before creating a tab", async () => {
  for (const denied of ["origin", "policy"]) {
    const f = fixture({ omitTarget: true });
    process.env.HERDR_PANE_ID = "synthetic-pane";
    try {
      if (denied === "origin") git(f.workerRoot, ["remote", "set-url", "origin", "git@github.com:elsewhere/agents-work.git"]);
      else writeFileSync(join(f.root, "profile", "config", "relay-authority.v1.json"), JSON.stringify({
        schema: "relay-authority.v1", githubOwner: "evoclock", denyRepositories: [WORKER_REPO],
      }));
      const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
      assert.equal(result.code, denied === "origin" ? "repository_origin_untrusted" : "repository_denied");
      assert.deepEqual(readLog(f.log), []);
    } finally { cleanup(f.root); }
  }
});

// Why: a trusted checkout can spawn in the coordinator workspace regardless of unrelated workspace labels or pane cwd.
test("worker spawn uses coordinator workspace without matching repository label", async () => {
  for (const mode of ["foreign-workspace", "foreign-pane"]) {
    const f = fixture({ mode });
    try {
      process.env.HERDR_PANE_ID = "w7:p1";
      const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
      assert.equal(result.status, "spawned", JSON.stringify(result));
      const rawCalls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(rawCalls.some(({ argv }) => argv[0] === "workspace"), false);
      assert.equal(readLog(f.log).some(({ argv }) => argv[0] === "tab" && argv.includes("w7")), true);
    } finally { cleanup(f.root); }
  }
});

// Why: A worker must not take over a coordinator pane.
test("a worker cannot split the coordinator pane", async () => {
  const f = fixture({ placement: "right" });
  try {
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.code, "worker_tab_required");
    assert.deepEqual(readLog(f.log), []);
  } finally { cleanup(f.root); }
});

// Why: An eligible worker must start with verified identity even when no UI or ledger grant is available.
test("registered repo + active exact lease spawns once without a UI or grant", async () => {
  const f = fixture();
  f.context.hasUI = false;
  f.context.ui = { confirm: () => { throw new Error("spawn must not ask for confirmation"); } };
  try {
    process.env.HERDR_PANE_ID = "w1:p1";
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "spawned");
    assert.equal(result.repository, realpathSync(f.workerRoot));
    assert.equal(result.worktreePath, realpathSync(f.worktree));
    assert.equal(result.leaseId, LEASE_ID);
    assert.equal(result.authorityCreated, false);
    const calls = readLog(f.log);
    assert.deepEqual(calls.map((entry) => entry.argv).filter((argv) => argv[0] === "tab" || argv[0] === "agent"), [
      ["agent", "list"],
      ["tab", "create", "--workspace", "w7", "--cwd", realpathSync(f.worktree), "--no-focus", "--label", "worker"],
      ["agent", "start", "worker", "--kind", "pi", "--pane", "w7:p10", "--timeout", "120000", "--", "--model", MODEL],
      ["agent", "get", "worker"],
    ]);
    const mutationCwds = calls.filter((entry) => entry.argv[0] === "tab" || entry.argv[1] === "start").map((entry) => entry.cwd);
    assert.ok(mutationCwds.every((cwd) => realpathSync(cwd) === realpathSync(f.worktree)), "Herdr runs in the target cwd");
  } finally {
    cleanup(f.root);
  }
});

// Why: the Electron boundary must preserve exact lease checks without relying on a dialog.
test("attended registered lease starts headless without a confirmation callback", async () => {
  const f = fixture({ boundary: "attended" });
  f.context.hasUI = false;
  f.context.ui = undefined;
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(f.params, f.context, f.herdrOptions);
    assert.equal(result.status, "spawned", JSON.stringify(result));
    assert.equal(result.worktreePath, realpathSync(f.worktree));
    assert.equal(result.leaseId, LEASE_ID);
  } finally { cleanup(f.root); }
});

// Observe the actual native dispatch, not a child's later log write. A queued
// revocation may run after spawn but before the child executes its fake body.
for (const boundary of ["tui", "attended"]) {
  for (const mutation of ["layout", "start"]) {
    // Why: Revocation must not race between the last trust check and native dispatch.
    test(`${boundary}: ${mutation} dispatch has no owned await after the authority fence`, async () => {
      const f = fixture({ boundary });
      const originalSpawn = childProcess.spawn;
      const dispatches = [];
      let observations = 0;
      let revoked = false;
      try {
        process.env.HERDR_PANE_ID = "w1:p1";
        f.herdrOptions.treehouseStatus = () => {
          const snapshot = readFileSync(f.statePath, "utf8");
          if (++observations === (mutation === "layout" ? 2 : 3)) {
            queueMicrotask(() => { writeFileSync(f.statePath, "[]"); revoked = true; });
          }
          return snapshot;
        };
        childProcess.spawn = (executable, argv, options) => {
          assert.equal(executable, f.herdrOptions.testExecutablePath);
          dispatches.push({ command: argv.slice(0, 2), revoked, leases: JSON.parse(readFileSync(f.statePath, "utf8")).length });
          return originalSpawn(executable, argv, options);
        };
        syncBuiltinESMExports();
        const execute = boundary === "tui" ? executeHerdrSpawnWorker : executeHerdrSpawnWorkerAttendedElectron;
        const result = await execute(f.params, f.context, f.herdrOptions);
        assert.equal(revoked, true);
        const commands = [["agent", "list"], ["tab", "create"], ...(mutation === "start" ? [["agent", "start"]] : [])];
        console.log("dispatch timing", JSON.stringify({ boundary, mutation, dispatches, result }));
        assert.deepEqual(dispatches.map((entry) => entry.command), [["agent", "list"], ...(boundary === "tui" ? [["pane", "current"]] : [["workspace", "list"]]), ...commands.slice(1)]);
        assert.ok(dispatches.every((entry) => !entry.revoked && entry.leases === 1), "every actual dispatch precedes revocation, without an owned yield");
        assert.deepEqual(readLog(f.log).map((entry) => entry.argv.slice(0, 2)),
          [["agent", "list"], ...(boundary === "tui" ? [["pane", "current"]] : []), ...commands.slice(1)],
          "one actual effect per dispatch, no retry");
        assert.equal(result.ok, false);
        assert.equal(result.code, "worktree_target_changed");
        assert.equal(result.partial, mutation === "layout" ? "tab_created" : "agent_started", "revocation AFTER dispatch must preserve the real partial effect");
        assert.equal(result.paneId, "w7:p10");
        assert.equal(result.tabId, "w7:t3");
      } finally {
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
        cleanup(f.root);
      }
    });
  }
}

// Why: A role collision must not create a layout or start a second worker.
test("duplicate role mutates nothing and never starts", async () => {
  const f = fixture({ mode: "duplicate", confirm: () => { throw new Error("no confirmation expected"); } });
  try {
    process.env.HERDR_PANE_ID = "w1:p1";
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.code, "duplicate_worker_name");
    assert.deepEqual(readLog(f.log).map((entry) => entry.argv), [["agent", "list"]]);
  } finally {
    cleanup(f.root);
  }
});

// Why: Ordinary root spawns must not require a Treehouse lease.
test("a missing target keeps the old behavior and never consults Treehouse", async () => {
  const f = fixture({ omitTarget: true });
  f.herdrOptions.treehouseStatus = () => { throw new Error("Treehouse must not be consulted without a target"); };
  try {
    process.env.HERDR_PANE_ID = "w1:p1";
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.worktreePath, undefined);
    assert.equal(result.leaseId, undefined);
    const tab = readLog(f.log).find((entry) => entry.argv[0] === "tab");
    assert.equal(tab.argv[5], realpathSync(f.workerRoot));
  } finally {
    cleanup(f.root);
  }
});

// Why: Supplied paths are untrusted and must not reach Herdr before Git identity checks.
test("malformed, relative, noncanonical, and symlinked targets fail closed before mutation", async () => {
  const cases = [
    ["relative", () => "relative/slot"],
    ["dotdot", (f) => `${f.worktree}/../${f.worktree.split("/").at(-1)}`],
    ["symlink", (f) => {
      const link = join(f.root, "link-slot");
      symlinkSync(f.worktree, link);
      return link;
    }],
    ["arbitrary-directory", (f) => {
      const plain = join(f.root, "plain-dir");
      mkdirSync(plain, { recursive: true });
      return plain;
    }],
    ["independent-copy", (f) => {
      const copy = join(f.root, "copied-repo");
      execFileSync("git", ["clone", "-q", f.workerRoot, copy]);
      return copy;
    }],
    ["other-repo-worktree", (f) => {
      const other = gitRepo(join(f.root, "other-repo"));
      return makeWorktree(other, join(f.root, "other-wt"));
    }],
  ];
  for (const [label, pathFor] of cases) {
    const f = fixture();
    try {
      process.env.HERDR_PANE_ID = "w1:p1";
      const result = await executeHerdrSpawnWorker(
        { ...f.params, worktreePath: pathFor(f) }, f.context, f.herdrOptions,
      );
      assert.equal(result.ok, false, label);
      assert.equal(result.status, "denied", `${label}: ${JSON.stringify(result)}`);
      assert.deepEqual(readLog(f.log), [], `${label}: no Herdr mutation or observation`);
    } finally {
      cleanup(f.root);
    }
  }
});

// Why: A worktree path alone cannot establish an active lease.
test("unleased and missing-lease worktrees are refused", async () => {
  for (const leaseStatus of ["unleased", "missing"]) {
    const f = fixture({ leaseStatus });
    try {
      process.env.HERDR_PANE_ID = "w1:p1";
      const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
      assert.equal(result.ok, false, leaseStatus);
      assert.equal(result.code, "worktree_lease_untrusted", `${leaseStatus}: ${JSON.stringify(result)}`);
      assert.equal(result.status, "denied");
      assert.deepEqual(readLog(f.log), []);
    } finally {
      cleanup(f.root);
    }
  }
});

// Why: Lease identity must remain stable after asynchronous observation.
test("a lease change across the observation boundary fails closed with no mutation", async () => {
  const f = fixture();
  f.herdrOptions.runProcess = (spec) => {
    const output = execFileSync(spec.executable, spec.argv, { ...spec.spawnOptions, encoding: "utf8" });
    if (spec.argv[0] === "agent" && spec.argv[1] === "list") {
      const state = JSON.parse(readFileSync(f.statePath, "utf8"));
      state[0].lease_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      writeFileSync(f.statePath, JSON.stringify(state));
    }
    return { code: 0, stdout: output, stderr: "" };
  };
  try {
    process.env.HERDR_PANE_ID = "w1:p1";
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.code, "worktree_target_changed");
    assert.deepEqual(readLog(f.log).map((entry) => entry.argv), [["agent", "list"], ["pane", "current", "--current"]]);
  } finally {
    cleanup(f.root);
  }
});

// Why: A created tab is reported even when a later lease check blocks start.
test("a lease change between mutations reports truthful partial tab state", async () => {
  const f = fixture({ mode: "mutate-lease" });
  try {
    process.env.HERDR_PANE_ID = "w1:p1";
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.equal(result.status, "partial");
    assert.equal(result.partial, "tab_created");
    assert.equal(result.code, "worktree_target_changed");
    assert.equal(result.tabId, "w7:t3");
    assert.equal(readLog(f.log).filter((entry) => entry.argv[0] === "agent" && entry.argv[1] === "start").length, 0);
  } finally {
    cleanup(f.root);
  }
});

// Why: The distinct attended boundary must retain its target checks.
test("the attended Electron boundary honors the same target and refusal rules", async () => {
  const ok = fixture({ boundary: "attended" });
  try {
    const result = await executeHerdrSpawnWorkerAttendedElectron(ok.params, ok.context, ok.herdrOptions);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.worktreePath, realpathSync(ok.worktree));
    assert.equal(result.leaseId, LEASE_ID);
    const tab = readLog(ok.log).find((entry) => entry.argv[0] === "tab");
    assert.equal(tab.argv[5], realpathSync(ok.worktree));
  } finally {
    cleanup(ok.root);
  }

  const bad = fixture({ boundary: "attended", leaseStatus: "unleased" });
  try {
    const pre = await preflightAttendedElectronSpawn(bad.params, bad.context, bad.herdrOptions);
    assert.equal(pre.ok, false);
    assert.equal(pre.code, "worktree_lease_untrusted");
    const commit = await executeHerdrSpawnWorkerAttendedElectron(bad.params, bad.context, bad.herdrOptions);
    assert.equal(commit.ok, false);
    assert.equal(commit.status, "denied");
    assert.deepEqual(readLog(bad.log), []);
  } finally {
    cleanup(bad.root);
  }
});

// Why: A matching name cannot substitute for Git administrative identity.
test("a copied independent repository with the same basename stays refused", async () => {
  const f = fixture();
  try {
    process.env.HERDR_PANE_ID = "w1:p1";
    const copy = join(f.root, "elsewhere", WORKER_REPO);
    execFileSync("git", ["clone", "-q", f.workerRoot, copy]);
    const result = await executeHerdrSpawnWorker({ ...f.params, worktreePath: copy }, f.context, f.herdrOptions);
    assert.equal(result.ok, false);
    assert.deepEqual(readLog(f.log), []);
  } finally {
    cleanup(f.root);
  }
});

// --- Correction round 1 regressions (WT-01..WT-07, PARENT-01) --------------

const { renameSync } = await import("node:fs");

function snapshotGit(dir) {
  return {
    head: git(dir, ["rev-parse", "HEAD"]),
    common: realpathSync(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    admin: realpathSync(git(dir, ["rev-parse", "--absolute-git-dir"])),
    adminInode: (() => { const st = statSync(git(dir, ["rev-parse", "--absolute-git-dir"])); return `${st.dev}:${st.ino}`; })(),
    toplevel: realpathSync(git(dir, ["rev-parse", "--show-toplevel"])),
  };
}

function replaceRepoAndWorktree(f) {
  // Same npm-visible paths, different repositories and administrative dirs.
  renameSync(f.workerRoot, join(f.root, "original-repo"));
  renameSync(f.worktree, join(f.root, "original-worktree"));
  gitRepo(f.workerRoot);
  git(f.workerRoot, ["remote", "add", "origin", `git@github.com:evoclock/${WORKER_REPO}.git`]);
  git(f.workerRoot, ["commit", "-q", "--allow-empty", "-m", "replacement-repository"]);
  makeWorktree(f.workerRoot, f.worktree, "fix/replaced");
}

// Why: A repository swap during asynchronous preflight must not authorize a tab in the replacement checkout.
test("WT-01/STD-01/SPEC-003: repository+worktree replacement before mutation is refused on both boundaries", async () => {
  for (const boundary of ["tui", "attended"]) {
    const f = fixture({ boundary });
    const before = { ...snapshotGit(f.workerRoot), ...snapshotGit(f.worktree) };
    if (boundary === "tui") process.env.HERDR_PANE_ID = "synthetic-pane";
    f.herdrOptions.runProcess = (spec) => {
      const stdout = execFileSync(spec.executable, spec.argv, { ...spec.spawnOptions, encoding: "utf8" });
      if (spec.argv[0] === "agent" && spec.argv[1] === "list") replaceRepoAndWorktree(f);
      return { code: 0, stdout, stderr: "" };
    };
    try {
      const execute = boundary === "tui" ? executeHerdrSpawnWorker : executeHerdrSpawnWorkerAttendedElectron;
      const result = await execute(f.params, f.context, f.herdrOptions);
      assert.equal(result.ok, false, `${boundary}: ${JSON.stringify(result)}`);
      assert.equal(result.code, "worktree_target_changed", boundary);
      assert.ok(result.status === "blocked" || result.status === "partial", boundary);
      const after = { ...snapshotGit(f.workerRoot), ...snapshotGit(f.worktree) };
      assert.notEqual(after.adminInode, before.adminInode, `${boundary}: the fixture really replaced Git administration`);
      assert.equal(readLog(f.log).filter((entry) => entry.argv[0] === "tab").length, 0, `${boundary}: no layout mutation`);
    } finally {
      cleanup(f.root);
    }
  }
});

// Why: Owner changes in an otherwise trusted lease must survive a spawn.
test("WT-01: an ordinary dirty legitimate target is still accepted (dirty state is not identity)", async () => {
  const f = fixture();
  writeFileSync(join(f.worktree, "owner-instructed-edits.txt"), "preserved owner work");
  process.env.HERDR_PANE_ID = "synthetic-pane";
  try {
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(join(f.worktree, "owner-instructed-edits.txt"), "utf8"), "preserved owner work");
  } finally {
    cleanup(f.root);
  }
});

// Why: A disallowed pane placement must fail before lease observation.
test("WT-02/STD-02: coordinator pane placements are denied before observing a lease", async () => {
  for (const placement of ["right", "below"]) {
    const f = fixture({ placement });
    process.env.HERDR_PANE_ID = "synthetic-pane";
    f.herdrOptions.runProcess = (spec) => {
      if (spec.argv[0] === "pane" && spec.argv[1] === "current") {
        const state = JSON.parse(readFileSync(f.statePath, "utf8"));
        state[0].status = "available";
        writeFileSync(f.statePath, JSON.stringify(state));
      }
      try {
        return {
          code: 0,
          stdout: execFileSync(f.herdrOptions.testExecutablePath, spec.argv, {
            ...spec.spawnOptions, encoding: "utf8",
          }),
          stderr: "",
        };
      } catch (error) {
        return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
      }
    };
    try {
      const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
      assert.equal(result.ok, false, placement);
      assert.equal(result.code, "worker_tab_required", placement);
      assert.equal(result.status, "denied", `${placement}: no mutation happened`);
      assert.equal(
        readLog(f.log).filter((entry) => entry.argv[0] === "pane" && entry.argv[1] === "split").length,
        0,
        `${placement}: the split is never attempted under a revoked lease`,
      );
    } finally {
      cleanup(f.root);
    }
  }
});

function revokeDuring(f, action, sub) {
  f.herdrOptions.runProcess = (spec) => {
    const stdout = execFileSync(f.herdrOptions.testExecutablePath, spec.argv, {
      ...spec.spawnOptions, encoding: "utf8",
    });
    if (spec.argv[0] === action && spec.argv[1] === sub) {
      const state = JSON.parse(readFileSync(f.statePath, "utf8"));
      state[0].status = "available";
      writeFileSync(f.statePath, JSON.stringify(state));
    }
    return { code: 0, stdout, stderr: "" };
  };
}

// Why: Revoked trust after start must not produce a false success receipt.
test("WT-03/STD-03/SPEC-001: a lease change during agent-get or pane-get is refused after the final read-back", async () => {
  for (const boundary of ["tui", "attended"]) {
    for (const [action, sub] of [["agent", "get"], ["pane", "get"]]) {
      const f = fixture({ boundary });
      if (boundary === "tui") process.env.HERDR_PANE_ID = "synthetic-pane";
      revokeDuring(f, action, sub);
      try {
        const execute = boundary === "tui" ? executeHerdrSpawnWorker : executeHerdrSpawnWorkerAttendedElectron;
        const result = await execute(f.params, f.context, f.herdrOptions);
        assert.equal(result.ok, false, `${boundary}/${action} ${sub}: ${JSON.stringify(result)}`);
        assert.equal(result.code, "worktree_target_changed", `${boundary}/${action}`);
        assert.equal(result.status, "partial", `${boundary}/${action}: the start mutation is not erased`);
        assert.equal(result.partial, "agent_started", `${boundary}/${action}`);
        assert.notEqual(result.leaseId, LEASE_ID, `${boundary}/${action}: no obsolete lease id is reported`);
      } finally {
        cleanup(f.root);
      }
    }
  }
});

for (const revokedAuthority of ["lease", "origin"]) {
  // Why: Git origin and lease changes during observation must precede any layout.
  test(`SPEC-02: preflight refuses ${revokedAuthority} revocation during agent-list`, async () => {
    const f = fixture({ boundary: "attended" });
    f.context.ui.confirm = () => { throw new Error("preflight must not request confirmation"); };
    const revoke = revokedAuthority === "lease" ? revokeDuring : revokeOriginDuring;
    revoke(f, "agent", "list");
    try {
      const result = await preflightAttendedElectronSpawn(f.params, f.context, f.herdrOptions);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.code, revokedAuthority === "lease" ? "worktree_target_changed" : "repository_origin_untrusted");
      assert.equal(result.status, revokedAuthority === "lease" ? "blocked" : "denied");
      assert.equal(result.leaseId, undefined, "no stale lease is certified");
      assert.equal(result.partial, undefined, "preflight has not mutated layout or started an agent");
      assert.deepEqual(readLog(f.log).map((entry) => entry.argv), [["agent", "list"]]);
    } finally {
      cleanup(f.root);
    }
  });
}

// Why: Inherited Git selectors cannot redirect primary-clone identity.
test("ST-01/SPEC-03: the mandatory primary-clone resolver ignores inherited Git selectors", () => {
  const f = fixture();
  const before = process.env.GIT_COMMON_DIR;
  process.env.GIT_COMMON_DIR = join(f.root, "foreign-common");
  try {
    assert.equal(resolveTrustedSpawnRepository(f.coordinator, WORKER_REPO), realpathSync(f.workerRoot));
  } finally {
    if (before === undefined) delete process.env.GIT_COMMON_DIR;
    else process.env.GIT_COMMON_DIR = before;
    cleanup(f.root);
  }
});

// Why: A stalled Git probe must fail within its bound.
test("ST-01/SPEC-03: the mandatory primary-clone common-dir probe is bounded", () => {
  const f = fixture();
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const fakeGit = join(f.root, "git");
  writeFileSync(fakeGit, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.slice(-2).join(" ") === "rev-parse --git-common-dir") {
  setTimeout(() => process.stdout.write(".git\\n"), 11000);
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: "utf8", env: process.env });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}
`);
  chmodSync(fakeGit, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${f.root}:${before}`;
  try {
    const started = Date.now();
    let failure;
    try { resolveTrustedSpawnRepository(f.coordinator, WORKER_REPO); }
    catch (error) { failure = error; }
    assert.ok(Date.now() - started < 10_750, "the primary-clone probe respects its ten-second bound");
    assert.equal(failure?.code, "repository_not_git_root", "a timed-out Git observation must refuse");
    assert.equal(failure?.status, "denied");
    assert.deepEqual(readLog(f.log), [], "the resolver never invokes Herdr");
  } finally {
    process.env.PATH = before;
    cleanup(f.root);
  }
});

// Why: Inherited Git environment cannot redirect a leased worktree.
test("WT-04/STD-04: inherited Git repository-selection variables cannot redirect the association", async () => {
  const f = fixture();
  const foreign = gitRepo(join(f.root, "foreign-repo"));
  const foreignTarget = makeWorktree(foreign, join(f.root, "foreign-worktree"));
  const before = process.env.GIT_COMMON_DIR;
  process.env.GIT_COMMON_DIR = join(f.workerRoot, ".git");
  try {
    const status = JSON.stringify([{ ...f.lease, path: foreignTarget }]);
    await assert.rejects(
      async () => resolveWorktreeSpawnTargetPublic(f.workerRoot, foreignTarget, { treehouseStatus: status }),
      (error) => error.code === "worktree_target_untrusted",
      "an inherited GIT_COMMON_DIR must not make a foreign worktree trusted",
    );
    for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) process.env[name] = join(f.workerRoot, ".git");
    const own = await resolveWorktreeSpawnTargetPublic(f.workerRoot, f.worktree, f.herdrOptions);
    assert.equal(own.worktreePath, realpathSync(f.worktree), "the legitimate target still resolves with a polluted env");
  } finally {
    for (const name of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_WORK_TREE"]) {
      if (name === "GIT_COMMON_DIR" && before !== undefined) process.env[name] = before;
      else delete process.env[name];
    }
    cleanup(f.root);
  }
});

// Why: The pane's observed cwd, not the requested path, decides success.
test("WT-05/STD-05: read-back reports independently persisted pane cwd; a wrong target fails closed", async () => {
  const ok = fixture();
  process.env.HERDR_PANE_ID = "synthetic-pane";
  try {
    const result = await executeHerdrSpawnWorker(ok.params, ok.context, ok.herdrOptions);
    assert.equal(result.ok, true, JSON.stringify(result));
    const state = JSON.parse(readFileSync(process.env.FAKE_HERDR_PANE_STATE, "utf8"));
    assert.deepEqual(state, { "w7:p10": realpathSync(ok.worktree) }, "the fake persisted the requested pane cwd");

    const wrong = fixture({ mode: "tab-wrong-cwd" });
    process.env.HERDR_PANE_ID = "synthetic-pane";
    const bad = await executeHerdrSpawnWorker(wrong.params, wrong.context, wrong.herdrOptions);
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.equal(bad.code, "repository_mismatch");
    assert.equal(bad.status, "partial");
    cleanup(wrong.root);
  } finally {
    cleanup(ok.root);
  }
});

// Why: A worktree target does not permit coordinator pane placement.
test("WT-05: a target-specific split is denied before creating a pane", async () => {
  const f = fixture({ placement: "right" });
  try {
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.code, "worker_tab_required");
    assert.deepEqual(readLog(f.log), []);
  } finally { cleanup(f.root); }
});

// Why: Blocking Git identity probes must not hang the worker start.
test("WT-06/STD-06: Git probes are bounded and fail with a structured error", async () => {
  const f = fixture();
  const fakeGit = join(f.root, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(fakeGit, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${f.root}:${before}`;
  try {
    // A hung `git` must time out into a structured lifecycle error, not hang.
    const started = Date.now();
    await assert.rejects(
      async () => resolveWorktreeSpawnTargetPublic(f.workerRoot, f.worktree, f.herdrOptions),
      (error) => typeof error.code === "string" && error.code.length > 0,
    );
    assert.ok(Date.now() - started < 25_000, "the probe returned without an unbounded hang");
  } finally {
    process.env.PATH = before;
    cleanup(f.root);
  }
});

// Why: A copied pointer is not an active lease for the requested worktree.
test("WT-07/SPEC-002: a copied .git pointer borrowing another slot's administration is refused", async () => {
  const f = fixture();
  const other = makeWorktree(f.workerRoot, join(f.root, "other-slot"), "fix/other-slot");
  // Recreate an ordinary directory at the original pool path with the other
  // slot's pointer, leaving the synthetic lease evidence unchanged.
  const otherPointer = readFileSync(join(other, ".git"), "utf8");
  const saved = join(f.root, "saved-worktree");
  renameSync(f.worktree, saved);
  mkdirSync(f.worktree, { recursive: true });
  writeFileSync(join(f.worktree, ".git"), otherPointer);
  try {
    process.env.HERDR_PANE_ID = "synthetic-pane";
    const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, "worktree_target_untrusted");
    assert.equal(result.status, "denied");
    assert.deepEqual(readLog(f.log), [], "no Herdr call for a borrowed administrative pointer");
  } finally {
    cleanup(f.root);
  }
});

// Why: Registry membership is required despite a borrowed Git pointer.
test("WT-07: an unregistered directory with a copied pointer to a valid slot is refused", async () => {
  const f = fixture();
  const pointer = readFileSync(join(f.worktree, ".git"), "utf8");
  const copyDir = join(f.root, "unregistered-copy");
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, ".git"), pointer);
  try {
    process.env.HERDR_PANE_ID = "synthetic-pane";
    const result = await executeHerdrSpawnWorker({ ...f.params, worktreePath: copyDir }, f.context, f.herdrOptions);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(["worktree_target_untrusted", "worktree_target_invalid"].includes(result.code), JSON.stringify(result));
    assert.deepEqual(readLog(f.log), []);
  } finally {
    cleanup(f.root);
  }
});

// WT-08: Verified Git origin is checked throughout the spawn. A remote change
// during an asynchronous observation must be seen before success or mutation.
function revokeOriginDuring(f, action, sub) {
  f.herdrOptions.runProcess = (spec) => {
    const stdout = execFileSync(f.herdrOptions.testExecutablePath, spec.argv, {
      ...spec.spawnOptions, encoding: "utf8",
    });
    if (spec.argv[0] === action && spec.argv[1] === sub) {
      git(f.workerRoot, ["remote", "set-url", "origin", "git@github.com:elsewhere/agents-work.git"]);
    }
    return { code: 0, stdout, stderr: "" };
  };
}

// Why: Invalid placement cannot trigger registry observation.
test("WT-08/STD-07/SPEC-005: coordinator pane placements are refused before any registry observation", async () => {
  for (const placement of ["right", "below"]) {
    const f = fixture({ placement });
    process.env.HERDR_PANE_ID = "synthetic-pane";
    revokeOriginDuring(f, "pane", "current");
    try {
      const result = await executeHerdrSpawnWorker(f.params, f.context, f.herdrOptions);
      assert.equal(result.ok, false, `${placement}: ${JSON.stringify(result)}`);
      assert.equal(result.code, "worker_tab_required", placement);
      assert.equal(result.status, "denied", `${placement}: no layout mutation happened`);
      assert.equal(result.partial, undefined, `${placement}: no layout partial is claimed`);
      const log = readLog(f.log);
      assert.equal(
        log.filter((entry) => entry.argv[0] === "pane" && entry.argv[1] === "split").length,
        0,
        `${placement}: the split is never attempted after membership revocation`,
      );
      assert.equal(
        log.filter((entry) => entry.argv[0] === "agent" && entry.argv[1] === "start").length,
        0,
        `${placement}: no agent start after membership revocation`,
      );
    } finally {
      cleanup(f.root);
    }
  }
});

// Why: Registry revocation after start requires a live-agent partial, not success.
test("WT-08/STD-07/SPEC-004: registry revocation during agent-get or pane-get keeps the agent_started partial and never reports spawned", async () => {
  for (const boundary of ["tui", "attended"]) {
    for (const [action, sub] of [["agent", "get"], ["pane", "get"]]) {
      const f = fixture({ boundary });
      if (boundary === "tui") process.env.HERDR_PANE_ID = "synthetic-pane";
      revokeOriginDuring(f, action, sub);
      try {
        const execute = boundary === "tui" ? executeHerdrSpawnWorker : executeHerdrSpawnWorkerAttendedElectron;
        const result = await execute(f.params, f.context, f.herdrOptions);
        assert.equal(result.ok, false, `${boundary}/${action} ${sub}: ${JSON.stringify(result)}`);
        assert.equal(result.code, "repository_origin_untrusted", `${boundary}/${action}`);
        assert.equal(result.status, "partial", `${boundary}/${action}: the start mutation is not erased`);
        assert.equal(result.partial, "agent_started", `${boundary}/${action}`);
        assert.equal(result.leaseId, undefined, `${boundary}/${action}: no obsolete lease id is reported`);
        assert.notEqual(result.status, "spawned", `${boundary}/${action}: never an obsolete success`);
      } finally {
        cleanup(f.root);
      }
    }
  }
});
