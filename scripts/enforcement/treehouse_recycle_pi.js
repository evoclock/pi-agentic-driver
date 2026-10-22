// Treehouse owns the pool. This scanner only returns settled, clean, pushed
// leases; it never removes worktrees or checks out branches itself.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const TREEHOUSE_CONFIG = JSON.parse(readFileSync(new URL("../../config/treehouse.v1.json", import.meta.url), "utf8"));
export const TREEHOUSE_VERSION = TREEHOUSE_CONFIG.version;
export const TREEHOUSE_ROOT = TREEHOUSE_CONFIG.root ?? join(homedir(), ".treehouse");
const execFileAsync = promisify(execFile);

export async function commandRunner(file, args, cwd) {
  const { stdout } = await execFileAsync(file, args, { cwd, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

function git(run, cwd, ...args) { return run("git", args, cwd); }

/** Runs only from the main repository checkout; never scans another pool. */
export async function recycleTreehouse({ root, run = commandRunner, current = process.cwd(), shouldContinue = () => true }) {
  const report = [];
  const repo = realpathSync(root);
  if (realpathSync(await git(run, repo, "rev-parse", "--show-toplevel")) !== repo) throw new Error("Treehouse scan requires the repository root");
  const versions = [...(await run("treehouse", ["--version"], repo)).matchAll(/(?:^|\s)(v\d+\.\d+\.\d+)(?=\s|$)/g)];
  if (versions.length !== 1 || versions[0][1] !== TREEHOUSE_VERSION) throw new Error("Treehouse version does not match the pinned version");
  const remote = await git(run, repo, "remote", "get-url", "origin");
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error("unrecognized GitHub origin; refusing Treehouse recycling");
  const repository = match[1];
  const slots = JSON.parse(await run("treehouse", ["status", "--json"], repo));
  if (!Array.isArray(slots)) throw new Error("invalid Treehouse status");
  const here = realpathSync(current);
  for (const slot of slots) {
    if (!shouldContinue()) break;
    if (slot?.status !== "leased" || !slot.lease_id || !slot.lease_holder ||
        !slot.branch || !Array.isArray(slot.processes) || slot.processes.length || !slot.path) continue;
    // Never return the checkout containing this process, even if a process probe misses it.
    let path;
    try { path = realpathSync(slot.path); } catch { continue; }
    if (here === path || here.startsWith(path + "/") || path === repo) continue;
    try {
      if (realpathSync(await git(run, path, "rev-parse", "--show-toplevel")) !== path ||
          await git(run, path, "branch", "--show-current") !== slot.branch ||
          await git(run, path, "status", "--porcelain", "--untracked-files=all", "--ignored=matching")) continue;
      const head = await git(run, path, "rev-parse", "HEAD");
      // A merged PR with the exact head proves this checkout was integrated.
      // A closed but unmerged PR never authorizes a return. Pagination keeps
      // older merged heads from being hidden by a result cap.
      const pages = await run("gh", ["api", "--method", "GET", `repos/${repository}/pulls`,
        "-f", "state=closed", "-f", `head=${repository.split("/")[0]}:${slot.branch}`,
        "-f", "per_page=100", "--paginate", "--jq",
        '[.[] | {headRefName:.head.ref,headRefOid:.head.sha,owner:.head.repo.owner.login,mergedAt:.merged_at}]'], repo);
      const prs = pages.split("\n").filter(Boolean).flatMap(page => {
        const entries = JSON.parse(page);
        if (!Array.isArray(entries)) throw new Error("invalid paginated PR response");
        return entries;
      });
      if (!prs.some(pr => pr.headRefName === slot.branch &&
          pr.headRefOid === head && pr.owner === repository.split("/")[0] &&
          typeof pr.mergedAt === "string" && Number.isFinite(Date.parse(pr.mergedAt)))) continue;
      // A concurrent new commit, dirty write, or lease change is caught again by
      // Treehouse's conditional return. Never use --force or --all.
      if (await git(run, path, "rev-parse", "HEAD") !== head ||
          await git(run, path, "status", "--porcelain", "--untracked-files=all", "--ignored=matching") ||
          !shouldContinue()) continue;
      await run("treehouse", ["return", path, "--if-lease-id", slot.lease_id,
        "--if-lease-holder", slot.lease_holder], repo);
      report.push({ branch: slot.branch, status: "returned" });
    } catch (error) {
      report.push({ branch: slot.branch, status: "held", reason: String(error.message) });
    }
  }
  return report;
}

const defaultReadDir = (path) => readdirSync(path, { withFileTypes: true });

function containsGitWorktree(dir, readDir, depth = 2) {
  if (depth < 0) return false;
  if (existsSync(join(dir, ".git"))) return true;
  let entries;
  try { entries = readDir(dir); } catch { return false; }
  return entries.some(entry => entry.isDirectory() && containsGitWorktree(join(dir, entry.name), readDir, depth - 1));
}

/** Finds the main checkout owning one slot worktree via its git common dir. */
async function repoForPool(pool, run, readDir) {
  let slots;
  try { slots = readDir(pool); } catch { return undefined; }
  for (const slot of slots) {
    if (!slot.isDirectory()) continue;
    let children;
    try { children = readDir(join(pool, slot.name)); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory() || !existsSync(join(pool, slot.name, child.name, ".git"))) continue;
      const worktree = join(pool, slot.name, child.name);
      const common = await git(run, worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");
      return dirname(realpathSync(common));
    }
  }
  return undefined;
}

/**
 * Sweeps every Treehouse pool under the treehouse root: managed pools are
 * recycled per owning repository; directories holding plain git worktrees
 * outside any pool are flagged as strays and never touched.
 */
export async function recycleAllPools({ treehouseRoot = TREEHOUSE_ROOT, run = commandRunner, current = process.cwd(), shouldContinue = () => true, readDir = defaultReadDir }) {
  const report = [];
  let entries;
  try { entries = readDir(treehouseRoot); } catch (error) {
    return [{ pool: treehouseRoot, status: "held", reason: String(error.message) }];
  }
  const repos = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !shouldContinue()) continue;
    const pool = join(treehouseRoot, entry.name);
    if (existsSync(join(pool, "treehouse-state.json"))) {
      try {
        const repo = await repoForPool(pool, run, readDir);
        if (repo && !repos.has(repo)) repos.set(repo, pool);
      } catch (error) {
        report.push({ pool, status: "held", reason: String(error.message) });
      }
    } else if (containsGitWorktree(pool, readDir)) {
      // A plain git worktree under the Treehouse root is invisible to every
      // pool command; flag it so a human can salvage and remove it by hand.
      report.push({ pool, status: "stray", reason: "git worktree outside any Treehouse pool" });
    }
  }
  for (const [repo, pool] of repos) {
    if (!shouldContinue()) break;
    try {
      for (const item of await recycleTreehouse({ root: repo, run, current, shouldContinue })) {
        report.push({ pool, ...item });
      }
    } catch (error) {
      report.push({ pool, status: "held", reason: String(error.message) });
    }
  }
  return report;
}
