import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDurableSeamStore } from "../scripts/enforcement/durable_assignment_pi.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runner = join(root, "tests/fixtures/outward-effect/crash-runner.mjs");
const gh = join(root, "tests/fixtures/outward-effect/fake-gh.mjs");
chmodSync(gh, 0o755);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function fixture(t, action, symlinkedCwd = false) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "durable-outward-test-"));
  t.after(() => {
    if (process.platform !== "darwin") return;
    const trash = join(homedir(), ".Trash");
    mkdirSync(trash, { recursive: true });
    renameSync(parent, join(trash, basename(parent)));
  });
  const directory = join(parent, "store");
  const actualCwd = join(parent, "local");
  const cwd = symlinkedCwd ? join(parent, "linked") : actualCwd;
  const remote = join(parent, "remote.git");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(actualCwd);
  if (symlinkedCwd) symlinkSync(actualCwd, cwd);
  git(parent, "init", "--bare", "-q", remote);
  git(cwd, "init", "-q", "-b", "feat/test");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(cwd, "file.txt"), "sample\n");
  git(cwd, "add", "file.txt");
  git(cwd, "commit", "-q", "-m", "fixture");
  git(cwd, "remote", "add", "origin", remote);
  const targetHead = git(cwd, "rev-parse", "HEAD");
  if (action !== "push") git(cwd, "push", "-q", "origin", "HEAD:refs/heads/feat/test");
  const store = await openDurableSeamStore({ directory, orphanWaitMs: 100 });
  const admitted = await store.runJourneyStep({ id: "jrn-fixture", digest: "a".repeat(64),
    role: "worker", repository: cwd, createdAt: Date.now(), journeyId: "stage3", iteration: "1", taskId: "fixture" }, {
    send: async () => ({ ok: true, promptSent: true, report: "attributed" }),
  });
  assert.equal(admitted.state, "verified");
  await store.close();
  const statePath = join(parent, "gh.json");
  writeFileSync(statePath, JSON.stringify({ repository: "fixture/private-repo", branch: "feat/test",
    head: targetHead, pulls: action === "pr-update" ? [{ number: 1, state: "open", draft: true,
      title: "Old title", body: "Old body", base: "feat/base" }] : [], writes: 0 }));
  const request = { action, journeyId: "stage3", effectId: "effect-1", repository: "fixture/private-repo",
    branch: "feat/test", targetHead,
    ...(action === "push" ? { expectedHead: null } : { base: "feat/base", title: "I improve recovery", body: "I check the remote first." }),
    ...(action === "pr-update" ? { number: 1, previousBodyDigest: createHash("sha256").update("Old body").digest("hex") } : {}) };
  const configPath = join(parent, "config.json");
  const invoke = (killAt, offlineAfterEffect = false) => {
    writeFileSync(configPath, JSON.stringify({ directory, cwd, gh, request, killAt, offlineAfterEffect,
      remote, statePath }));
    return spawnSync(process.execPath, [runner, configPath], {
      cwd: root, env: { ...process.env, OUTWARD_FAKE_GH_STATE: statePath }, encoding: "utf8", timeout: 12_000,
    });
  };
  return { parent, cwd, remote, request, invoke,
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    setState: (state) => writeFileSync(statePath, JSON.stringify(state)) };
}

test("kill before push: admitted checkpoint needs a new confirmed call", async (t) => {
  const f = await fixture(t, "push");
  const killed = f.invoke("before-effect");
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/feat/test"), "");
  const resumed = f.invoke(null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "verified");
  assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/feat/test").split("\t")[0], f.request.targetHead);
});

test("kill after push before commit: remote proof resolves without replay", async (t) => {
  const f = await fixture(t, "push");
  const killed = f.invoke("after-effect");
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/feat/test").split("\t")[0], f.request.targetHead);
  writeFileSync(join(f.cwd, "file.txt"), "drift\n");
  git(f.cwd, "add", "file.txt");
  git(f.cwd, "commit", "-q", "-m", "drift");
  const resumed = f.invoke(null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "verified");
});

test("kill after PR create before commit: matching private draft is observed, not created again", async (t) => {
  const f = await fixture(t, "pr-create");
  const killed = f.invoke("after-effect");
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  assert.equal(f.state().writes, 1);
  const resumed = f.invoke(null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "verified");
  assert.equal(f.state().writes, 1);
});

test("kill after PR update before commit: exact updated draft is observed without a second PATCH", async (t) => {
  const f = await fixture(t, "pr-update");
  const killed = f.invoke("after-effect");
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  assert.equal(f.state().writes, 1);
  const resumed = f.invoke(null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "verified");
  assert.equal(f.state().writes, 1);
});

for (const action of ["pr-create", "pr-update"]) {
  test(`kill before ${action}: new confirmed call applies once`, async (t) => {
    const f = await fixture(t, action);
    const killed = f.invoke("before-effect");
    assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
    assert.equal(f.state().writes, 0);
    const resumed = f.invoke(null);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, "verified");
    assert.equal(f.state().writes, 1);
  });
}

test("a symlinked journey cwd resolves to the same canonical repository", async (t) => {
  const f = await fixture(t, "push", true);
  const result = f.invoke(null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "verified");
});

for (const mismatch of ["multiple", "title-body"]) {
  test(`PR ${mismatch} ambiguity after a crash blocks without a second create`, async (t) => {
    const f = await fixture(t, "pr-create");
    const killed = f.invoke("after-effect");
    assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
    const state = f.state();
    if (mismatch === "multiple") state.pulls.push({ ...state.pulls[0], number: 2 });
    else Object.assign(state.pulls[0], { title: "Changed title", body: "Changed body" });
    f.setState(state);
    const resumed = f.invoke(null);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, "blocked");
    assert.equal(f.state().writes, 1);
  });
}

test("transient push observation failure blocks, then a new effect ID observes the landed push", async (t) => {
  const f = await fixture(t, "push");
  const first = f.invoke(null, true);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "blocked");
  renameSync(`${f.remote}.offline`, f.remote);
  f.request.effectId = "effect-2";
  const resumed = f.invoke(null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "verified");
  assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/feat/test").split("\t")[0], f.request.targetHead);
});

test("transient PR observation failure blocks, then a new effect ID observes the existing draft", async (t) => {
  const f = await fixture(t, "pr-create");
  const first = f.invoke(null, true);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "blocked");
  f.request.effectId = "effect-2";
  const resumed = f.invoke(null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "verified");
  assert.equal(f.state().writes, 1);
});

test("outward records reject a stray worker role", async (t) => {
  const f = await fixture(t, "push");
  const store = await openDurableSeamStore({ directory: join(f.parent, "store"), orphanWaitMs: 100 });
  try {
    await assert.rejects(store.runOutwardEffect({ id: "out-stray-role", digest: "b".repeat(64),
      role: "worker", repository: f.cwd, createdAt: Date.now(), kind: "push", journeyId: "stage3" }, {
      apply: () => assert.fail("invalid record must not apply"), observe: () => ({ verified: false }),
    }), /unsupported seam field/);
  } finally { await store.close(); }
});

test("PR creation rejects an unused PR number before any remote write", async (t) => {
  const f = await fixture(t, "pr-create");
  f.request.number = 1;
  const response = f.invoke(null);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).status, "blocked");
  assert.equal(f.state().writes, 0);
});

test("existing exact push target verifies despite a changed local HEAD", async (t) => {
  const f = await fixture(t, "push");
  git(f.cwd, "push", "-q", "origin", `${f.request.targetHead}:refs/heads/feat/test`);
  writeFileSync(join(f.cwd, "file.txt"), "local change\n");
  git(f.cwd, "add", "file.txt");
  git(f.cwd, "commit", "-q", "-m", "local drift");
  const result = f.invoke(null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "verified");
  assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/feat/test").split("\t")[0], f.request.targetHead);
});

test("existing exact PR update target verifies despite a stale prior-body digest", async (t) => {
  const f = await fixture(t, "pr-update");
  const state = f.state();
  state.pulls[0].title = f.request.title;
  state.pulls[0].body = f.request.body;
  f.setState(state);
  const result = f.invoke(null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "verified");
  assert.equal(f.state().writes, 0);
});

test("ambiguous remote push after crash blocks without replay", async (t) => {
  const f = await fixture(t, "push");
  const killed = f.invoke("after-effect");
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  writeFileSync(join(f.cwd, "file.txt"), "remote changed\n");
  git(f.cwd, "add", "file.txt");
  git(f.cwd, "commit", "-q", "-m", "remote drift");
  const otherHead = git(f.cwd, "rev-parse", "HEAD");
  git(f.cwd, "push", "-q", "origin", "HEAD:refs/heads/feat/test");
  const resumed = f.invoke(null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "blocked");
  assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/feat/test").split("\t")[0], otherHead);
});
