import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recycleAllPools, recycleTreehouse, TREEHOUSE_VERSION } from "../scripts/enforcement/treehouse_recycle_pi.js";
import { createTreehouseRecycleExtension } from "../extensions/treehouse-recycle.ts";

// No forge or Treehouse process runs in these tests. Every command is fake.
const root = realpathSync(process.cwd());
const scratch = mkdtempSync(join(root, "scratch/treehouse-recycle-"));
const slotPath = join(scratch, "slot");
mkdirSync(slotPath);
const rootAlias = join(scratch, "root-link");
const slotAlias = join(scratch, "slot-link");
symlinkSync(root, rootAlias, "dir");
symlinkSync(slotPath, slotAlias, "dir");
const sha = "a".repeat(40);
function fixture({ dirty = false, pushed = true, processes = [], version = TREEHOUSE_VERSION } = {}) {
  const calls = [];
  const slot = { status: "leased", path: slotPath, branch: "feat/settled", lease_id: "lease-1", lease_holder: "driver-one", processes };
  const pr = { headRefName: slot.branch, headRefOid: pushed ? sha : "b".repeat(40), owner: "org", mergedAt: "2026-10-19T12:00:00Z" };
  const run = (bin, args, cwd) => {
    calls.push([bin, args, cwd]);
    const command = args.join(" ");
    if (bin === "treehouse" && command === "--version") return version;
    if (bin === "treehouse" && command === "status --json") return JSON.stringify([slot]);
    if (bin === "treehouse" && args[0] === "return") return "returned";
    if (bin === "gh") return args.includes("--paginate") && args.includes("head=org:" + slot.branch) ? JSON.stringify([pr]) : "[]";
    if (command === "rev-parse --show-toplevel") return cwd;
    if (command === "branch --show-current") return slot.branch;
    if (command.startsWith("status --porcelain")) return dirty ? " M tracked" : "";
    if (command === "rev-parse HEAD") return sha;
    if (command === "remote get-url origin") return "https://github.com/org/repo.git";
    throw new Error(`unexpected command ${bin} ${command}`);
  };
  return { calls, run, slot, pr };
}
function scan(f, extra = {}) { return recycleTreehouse({ root, current: root, run: f.run, ...extra }); }
function returns(f) { return f.calls.filter(([bin, args]) => bin === "treehouse" && args[0] === "return"); }
const settle = () => new Promise(resolve => setImmediate(resolve));

test("session events stay responsive while the async recycler is pending, and shutdown stops ticks", async () => {
  const handlers = {};
  const scans = [];
  let tick;
  let finishRecycle;
  let canceled = false;
  let finishProbe;
  const probe = () => new Promise(resolve => { finishProbe = resolve; });
  const recycle = ({ treehouseRoot: scanned, shouldContinue }) => {
    scans.push(scanned);
    return new Promise(resolve => { finishRecycle = () => { assert.equal(shouldContinue(), false); resolve(); }; });
  };
  createTreehouseRecycleExtension(recycle, probe,
    callback => { tick = callback; return { unref() {} }; },
    () => { canceled = true; })({ on: (name, handler) => { handlers[name] = handler; } });
  handlers.session_start();
  handlers.session_start();
  assert.deepEqual(scans, [], "session start does not wait for git");
  finishProbe(root);
  await settle();
  assert.deepEqual(scans, [root]);
  let eventDelivered = false;
  queueMicrotask(() => { eventDelivered = true; });
  await settle();
  assert.equal(eventDelivered, true, "other session events can run while recycler waits");
  tick();
  assert.deepEqual(scans, [root], "pending recycle prevents duplicate scan");
  handlers.session_shutdown();
  assert.equal(canceled, true);
  tick();
  await settle();
  assert.deepEqual(scans, [root]);
  finishRecycle();
  await settle();
});
test("returns an exact pushed head with conditional lease identity", async () => {
  const f = fixture();
  assert.deepEqual(await scan(f), [{ branch: f.slot.branch, status: "returned" }]);
  assert.deepEqual(returns(f)[0][1], ["return", slotPath, "--if-lease-id", "lease-1", "--if-lease-holder", "driver-one"]);
  assert.ok(f.calls.some(([bin, args]) => bin === "gh" && args.includes("--paginate") && args.includes("head=org:feat/settled")));
});
test("holds an exact pushed head when its PR was closed without merging", async () => {
  const f = fixture();
  f.pr.mergedAt = null;
  assert.deepEqual(await scan(f), []);
  assert.equal(returns(f).length, 0);
});
test("finds the exact head on the second page after 100 reused-branch PRs", async () => {
  const f = fixture();
  const original = f.run;
  f.run = (bin, args, cwd) => bin === "gh" ?
    JSON.stringify(Array.from({ length: 100 }, () => ({ ...f.pr, headRefOid: "b".repeat(40) }))) + "\n" + JSON.stringify([f.pr]) :
    original(bin, args, cwd);
  assert.equal((await scan(f))[0].status, "returned");
  assert.equal(returns(f).length, 1);
});
test("refuses dirty, unpushed, active, and wrong-version slots", async () => {
  for (const options of [{ dirty: true }, { pushed: false }, { processes: [{ pid: 1 }] }]) {
    const f = fixture(options);
    assert.deepEqual(await scan(f), []);
    assert.equal(returns(f).length, 0);
  }
  for (const version of ["v0.0.0", "treehouse v3.1.30", "treehouse v3.1.3 and v3.1.4"]) {
    const f = fixture({ version });
    await assert.rejects(scan(f), /pinned version/);
    assert.equal(returns(f).length, 0);
  }
  assert.equal((await scan(fixture({ version: "treehouse v3.1.3" })))[0].status, "returned");
});
test("a lease without a holder, a concurrent checkout change, or a canceled scan cannot return", async () => {
  const f = fixture();
  f.slot.lease_holder = "";
  assert.deepEqual(await scan(f), []);
  const changed = fixture();
  let statusReads = 0;
  const original = changed.run;
  changed.run = (bin, args, cwd) => bin === "git" && args[0] === "status" ?
    (++statusReads === 1 ? "" : " M new-change") : original(bin, args, cwd);
  assert.deepEqual(await scan(changed), []);
  const canceled = fixture();
  assert.deepEqual(await scan(canceled, { shouldContinue: () => false }), []);
  assert.equal(returns(f).length + returns(changed).length + returns(canceled).length, 0);
});
test("shutdown while the PR query is pending prevents a return", async () => {
  const f = fixture();
  const original = f.run;
  let finishQuery;
  let live = true;
  f.run = (bin, args, cwd) => bin === "gh" ? new Promise(resolve => {
    finishQuery = () => resolve(original(bin, args, cwd));
  }) : original(bin, args, cwd);
  const pending = scan(f, { shouldContinue: () => live });
  while (!finishQuery) await settle();
  live = false;
  finishQuery();
  assert.deepEqual(await pending, []);
  assert.equal(returns(f).length, 0);
});
test("normalizes symlinked root and current checkout without returning itself", async () => {
  const f = fixture();
  const original = f.run;
  f.slot.path = slotAlias;
  f.run = (bin, args, cwd) => bin === "git" && args.join(" ") === "rev-parse --show-toplevel" ? rootAlias : original(bin, args, cwd);
  assert.deepEqual(await recycleTreehouse({ root: rootAlias, current: slotAlias, run: f.run }), []);
  assert.equal(returns(f).length, 0);
});
test("normalizes a slot's git-reported symlinked toplevel", async () => {
  const f = fixture();
  const original = f.run;
  f.run = (bin, args, cwd) => bin === "git" && cwd === slotPath && args.join(" ") === "rev-parse --show-toplevel" ?
    slotAlias : original(bin, args, cwd);
  assert.equal((await scan(f))[0].status, "returned");
});
test("own checkout and repeated empty scans never return anything", async () => {
  const f = fixture();
  assert.deepEqual(await recycleTreehouse({ root, current: slotPath, run: f.run }), []);
  assert.equal(returns(f).length, 0);
  f.run = (bin, args, cwd) => args.join(" ") === "status --json" ? "[]" :
    args.join(" ") === "--version" ? TREEHOUSE_VERSION :
    args.join(" ") === "remote get-url origin" ? "https://github.com/org/repo.git" : cwd;
  assert.deepEqual(await scan(f), []);
  assert.deepEqual(await scan(f), []);
});
test("any lease holder is recycled, not only driver-* holders", async () => {
  const f = fixture();
  f.slot.lease_holder = "coordinator";
  assert.deepEqual(await scan(f), [{ branch: f.slot.branch, status: "returned" }]);
  assert.deepEqual(returns(f)[0][1], ["return", slotPath, "--if-lease-id", "lease-1", "--if-lease-holder", "coordinator"]);
});

test("sweeps every managed pool and flags plain worktrees outside any pool", async () => {
  const tree = mkdtempSync(join(scratch, "tree-"));
  const repoA = join(scratch, "repo-a");
  const repoB = join(scratch, "repo-b");
  mkdirSync(join(repoA, ".git"), { recursive: true });
  mkdirSync(join(repoB, ".git"), { recursive: true });
  const poolA = join(tree, "pool-a");
  const poolB = join(tree, "pool-b");
  const stray = join(tree, "stray-x");
  const plain = join(tree, "plain-docs");
  mkdirSync(join(poolA, "1", "repo-a"), { recursive: true });
  mkdirSync(join(poolB, "1", "repo-b"), { recursive: true });
  mkdirSync(join(stray, "9", "repo-a"), { recursive: true });
  mkdirSync(join(plain, "notes"), { recursive: true });
  writeFileSync(join(poolA, "treehouse-state.json"), "{}");
  writeFileSync(join(poolB, "treehouse-state.json"), "{}");
  for (const marker of [join(poolA, "1", "repo-a", ".git"), join(poolB, "1", "repo-b", ".git"), join(stray, "9", "repo-a", ".git")]) {
    writeFileSync(marker, "gitdir: elsewhere");
  }
  const f = fixture();
  const run = (bin, args, cwd) => {
    const command = args.join(" ");
    if (bin === "git" && command === "rev-parse --path-format=absolute --git-common-dir") {
      if (cwd === join(poolA, "1", "repo-a")) return join(repoA, ".git");
      if (cwd === join(poolB, "1", "repo-b")) return join(repoB, ".git");
    }
    if (bin === "git" && command === "rev-parse --show-toplevel" && (cwd === repoA || cwd === repoB)) return cwd;
    if (bin === "git" && command === "remote get-url origin") return "https://github.com/org/repo.git";
    return f.run(bin, args, cwd);
  };
  const report = await recycleAllPools({ treehouseRoot: tree, run, current: root });
  assert.deepEqual(report.filter(item => item.status === "stray"), [{ pool: stray, status: "stray", reason: "git worktree outside any Treehouse pool" }]);
  const returned = report.filter(item => item.status === "returned");
  assert.deepEqual(returned.map(item => item.pool).sort(), [poolA, poolB].sort());
  assert.equal(report.some(item => item.pool === plain), false, "directories without git worktrees are not flagged");
  assert.equal(returns(f).length, 2, "one conditional return per pool");
});

test("an unreadable treehouse root is reported held, never thrown", async () => {
  const report = await recycleAllPools({ treehouseRoot: join(scratch, "does-not-exist"), run: fixture().run });
  assert.equal(report.length, 1);
  assert.equal(report[0].status, "held");
});
