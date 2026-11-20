import { isAbsolute } from 'node:path';
import { commandRunner, TREEHOUSE_VERSION } from '../scripts/enforcement/treehouse_recycle_pi.js';
import { ParallelScheduler, validateManifest } from './parallel-scheduler.mjs';

/** Real host ports; dispatch must be the caller's existing guarded host route.
 * This adapter never launches a raw worker CLI and never treats a task as permission.
 * cap is the owning host's configured pool ceiling, including foreign occupants.
 */
export function createTreehousePorts({ root, cap, base, branchPrefix, holder, dispatch, report, run = commandRunner }) {
  if (!isAbsolute(root) || !Number.isSafeInteger(cap) || cap < 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(base ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(branchPrefix ?? '') ||
      typeof holder !== 'string' || !holder || typeof dispatch !== 'function' || typeof report !== 'function')
    throw new Error('explicit root, pool cap, base, branch prefix, holder and guarded host ports required');
  const git = (cwd, ...args) => run('git', args, cwd);
  const claimed = new Map();
  async function slots() {
    const result = JSON.parse(await run('treehouse', ['status', '--json'], root));
    if (!Array.isArray(result)) throw new Error('invalid Treehouse status');
    return result;
  }
  const full = pool => pool.filter(s => s.status !== 'available').length >= cap;
  async function identity(lease) {
    const slot = (await slots()).find(s => s.path === lease.path);
    if (!slot || slot.status !== 'leased' || slot.lease_id !== lease.id ||
        slot.lease_holder !== holder || slot.branch !== lease.branch || !claimed.has(lease.id))
      throw new Error('Treehouse lease identity changed; reservation held');
    if (await git(lease.path, 'rev-parse', '--show-toplevel') !== lease.path ||
        await git(lease.path, 'rev-parse', '--path-format=absolute', '--git-common-dir') !==
          await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir') ||
        await git(lease.path, 'branch', '--show-current') !== lease.branch)
      throw new Error('lease is not the expected sibling Git worktree');
    return slot;
  }
  async function observe(task, outcome) {
    const lease = task.lease;
    await identity(lease);
    const head = await git(lease.path, 'rev-parse', 'HEAD');
    const origin = await git(root, 'remote', 'get-url', 'origin');
    const match = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (!match || !/^[a-f0-9]{40}$/.test(head)) throw new Error('unrecognized repository or head');
    const repository = match[1], owner = repository.split('/')[0];
    const pages = await run('gh', ['api', '--method', 'GET', `repos/${repository}/pulls`,
      '-f', 'state=closed', '-f', `head=${owner}:${lease.branch}`, '-f', 'per_page=100', '--paginate', '--jq',
      '[.[] | {headRefName:.head.ref,headRefOid:.head.sha,owner:.head.repo.owner.login,base:.base.ref,state:.state,closedAt:.closed_at,mergedAt:.merged_at}]'], root);
    const prs = pages.split('\n').filter(Boolean).flatMap(page => {
      const entries = JSON.parse(page);
      if (!Array.isArray(entries)) throw new Error('invalid PR observation');
      return entries;
    });
    return prs.some(pr => pr.headRefName === lease.branch && pr.headRefOid === head && pr.owner === owner && pr.base === base &&
      (outcome === 'merged'
        ? typeof pr.mergedAt === 'string' && Number.isFinite(Date.parse(pr.mergedAt))
        : pr.state === 'closed' && pr.mergedAt === null && typeof pr.closedAt === 'string' && Number.isFinite(Date.parse(pr.closedAt)))) &&
      await git(lease.path, 'rev-parse', 'HEAD') === head;
  }
  const merged = task => observe(task, 'merged');
  const closed = task => observe(task, 'abandoned');
  return {
    cap, report, merged, closed,
    async acquire(task) {
      validateManifest([{ ...task, dependsOn: [] }]);
      if (await git(root, 'rev-parse', '--show-toplevel') !== root) throw new Error('requires repository root');
      const version = await run('treehouse', ['--version'], root);
      if (!version.split(/\s+/).includes(TREEHOUSE_VERSION)) throw new Error('Treehouse version mismatch');
      if (full(await slots())) return null;
      const branch = branchPrefix + task.id;
      let path;
      try {
        path = await run('treehouse', ['get', '--lease', '--base', base, '--branch', branch, '--lease-holder', holder], root);
      } catch (error) {
        const observed = await slots();
        // A raced full pool is a wait only when no uncertain lease was created.
        const uncertain = observed.find(s => s.branch === branch);
        if (!uncertain && full(observed)) return null;
        if (uncertain) throw new Error(`acquisition uncertain; inspect lease id ${uncertain.lease_id ?? '<missing>'} before retry`, { cause: error });
        throw error;
      }
      const slot = (await slots()).find(s => s.path === path && s.branch === branch && s.lease_holder === holder && s.status === 'leased');
      if (!slot?.lease_id || !isAbsolute(path) || path === root || claimed.has(slot.lease_id))
        throw new Error('acquisition uncertain; inspect Treehouse, never retry blindly');
      const lease = { id: slot.lease_id, path, branch };
      claimed.set(lease.id, lease);
      await identity(lease);
      return lease;
    },
    async dispatch(task, lease) {
      await identity(lease);
      return dispatch(task, lease);
    },
    async release(lease, task, outcome = 'merged') {
      if (task.lease.id !== lease.id || task.lease.path !== lease.path) throw new Error('task/lease mismatch');
      const head = await git(lease.path, 'rev-parse', 'HEAD');
      if (outcome === 'merged') {
        if (!await merged(task)) throw new Error('exact PR head merge not verified');
      } else if (outcome === 'abandoned') {
        if (!await closed(task)) throw new Error('exact closed unmerged PR not verified');
      } else throw new Error('unknown lease return outcome');
      const slot = await identity(lease);
      if (!Array.isArray(slot.processes) || slot.processes.length ||
          await git(lease.path, 'status', '--porcelain', '--untracked-files=all'))
        throw new Error('worktree active or dirty; lease held');
      if (await git(lease.path, 'rev-parse', 'HEAD') !== head) throw new Error('head changed before return');
      await run('treehouse', ['return', lease.path, '--if-lease-id', lease.id, '--if-lease-holder', holder], root);
      if ((await slots()).some(s => s.lease_id === lease.id && s.status === 'leased'))
        throw new Error('lease return not observed');
      claimed.delete(lease.id);
    },
  };
}

/** Repository host entry point; call tick on capacity observations and merge on
 * observed PR changes. One owner per pool is required; no background spin loop.
 */
export function createTreehouseScheduler(tasks, options) {
  return new ParallelScheduler(tasks, createTreehousePorts(options));
}
