import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// Why: test worktrees must stay in the real user's Treehouse even when HOME is overridden.
test("fixture root rejects outside paths and cleans up", async () => {
  const helper = await import("../scripts/pad_test_treehouse.js").catch(() => null);
  assert.ok(helper, "Treehouse fixture helper is required");
  const oldHome = process.env.HOME;
  process.env.HOME = "/not-the-real-home";
  let fixture;
  try {
    fixture = helper.createTestTreehouse();
    assert.ok(fixture.root.startsWith(join(realpathSync(userInfo().homedir), ".treehouse") + "/"));
    assert.throws(() => fixture.path("../../outside"), /outside.*treehouse/i);
    assert.throws(() => fixture.addWorktree("unused", join(fixture.root, "../../outside")), /outside.*treehouse/i);
    symlinkSync(join(tmpdir(), "pad-missing-target-never-created"), join(fixture.root, "dangling"));
    assert.throws(() => fixture.path("dangling", "worktree"), /symlink|outside.*treehouse/i);
    symlinkSync(tmpdir(), join(fixture.root, "escape"));
    assert.throws(() => fixture.path("escape", "outside"), /outside.*treehouse/i);
    assert.ok(fixture.path("inside").startsWith(fixture.root + "/"));
    assert.ok(existsSync(fixture.root));
  } finally {
    fixture?.cleanup();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  }
  assert.equal(existsSync(fixture.root), false);
});

// Why: the installed guard must independently reject raw worktree adds outside Treehouse.
test("installed git guard refuses outside worktrees", (t) => {
  const which = spawnSync("which", ["git"], { encoding: "utf8" });
  const git = which.stdout.trim();
  if (which.status !== 0 || !readFileSync(realpathSync(git), "utf8").includes("evoclock_git_guard")) {
    t.skip("evoclock-guard is not the git on PATH");
    return;
  }
  const dir = mkdtempSync(join(realpathSync(userInfo().homedir), ".pad-guard-test-"));
  const repo = join(dir, "repo");
  const target = join(dir, "outside");
  try {
    assert.equal(spawnSync(git, ["init", "-q", repo]).status, 0);
    assert.equal(spawnSync(git, ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"]).status, 0);
    const add = spawnSync(git, ["-C", repo, "worktree", "add", "--detach", target], { encoding: "utf8" });
    assert.notEqual(add.status, 0);
    assert.match(add.stderr, /evoclock-guard.*(refus|treehouse)/i);
  } finally {
    spawnSync(git, ["-C", repo, "worktree", "remove", "--force", target]);
    rmSync(dir, { recursive: true, force: true });
  }
});
