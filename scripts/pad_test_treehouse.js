import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

// Shared by local and CI test fixtures; HOME can be intentionally faked by tests.
export function createTestTreehouse() {
  const treehouse = join(realpathSync(userInfo().homedir), ".treehouse");
  mkdirSync(treehouse, { recursive: true });
  const root = realpathSync(mkdtempSync(join(treehouse, `.pad-test-${process.pid}-`)));

  return openTestTreehouse(root);
}

// Test-fixture containment only; filesystem changes between validation and use are not prevented.
export function openTestTreehouse(root) {
  root = realpathSync(root);
  const treehouse = realpathSync(join(realpathSync(userInfo().homedir), ".treehouse"));
  const name = relative(treehouse, root);
  if (!/^\.pad-test-[^/]+$/.test(name)) throw new Error("Refusing outside test Treehouse fixture root");

  function path(...parts) {
    const target = resolve(root, ...parts);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("Refusing path outside test Treehouse fixture");
    }
    let parent = target;
    while (true) {
      try { lstatSync(parent); break; } catch (error) {
        if (error.code !== "ENOENT") throw error;
        parent = dirname(parent);
      }
    }
    let realParent;
    try { realParent = realpathSync(parent); } catch (error) {
      if (error.code === "ENOENT") throw new Error("Refusing dangling symlink outside test Treehouse fixture");
      throw error;
    }
    if (realParent !== root && !realParent.startsWith(root + sep)) {
      throw new Error("Refusing path outside test Treehouse fixture");
    }
    return target;
  }

  function addWorktree(repository, target, before = [], after = []) {
    const checked = path(target);
    return execFileSync("git", ["-C", repository, "worktree", "add", ...before, checked, ...after], { encoding: "utf8" });
  }

  return { root, path, addWorktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
