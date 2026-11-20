import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Resolve a host-selected store without writing or publishing any evidence. */
export function retentionDestination({ repo, destination } = {}) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) {
    throw new TypeError('repo must be an absolute path');
  }
  if (destination !== undefined && (typeof destination !== 'string' || !path.isAbsolute(destination))) {
    throw new TypeError('destination must be an absolute path');
  }
  return destination === undefined
    ? { root: path.join(repo, '.scratch', 'model-fidelity'), retention: 'local-non-durable', publication: 'none' }
    : { root: path.resolve(destination), retention: 'configured-unverified', publication: 'none' };
}

const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 30000 }).trim();
const safeId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new TypeError('invalid bundle identifier');
  return value;
};

function copyBundle(source, target, relative = '') {
  for (const entry of readdirSync(path.join(source, relative), { withFileTypes: true })) {
    if (entry.name === '.git') throw new TypeError('bundle cannot contain .git');
    const name = path.join(relative, entry.name);
    const input = path.join(source, name);
    if (entry.isDirectory()) {
      mkdirSync(path.join(target, name));
      copyBundle(source, target, name);
    } else if (entry.isFile()) {
      if (entry.name === 'manifest.json' && !relative) continue;
      copyFileSync(input, path.join(target, name), 1);
    } else throw new TypeError('bundle cannot contain links or special files');
  }
}

/** An explicit host verification callback is required before any destination write. */
export function appendRetentionBundle({ bundle, destination, planId, bundleId, verifyDestination }) {
  safeId(planId);
  safeId(bundleId);
  if (typeof verifyDestination !== 'function') throw new TypeError('destination verification required');
  if (!path.isAbsolute(bundle) || !path.isAbsolute(destination)) throw new TypeError('absolute paths required');
  if (!lstatSync(bundle).isDirectory() || realpathSync(bundle) !== path.resolve(bundle)) throw new TypeError('bundle must be a real directory');
  const manifest = path.join(bundle, 'manifest.json');
  if (!lstatSync(manifest).isFile() || realpathSync(manifest) !== manifest) throw new TypeError('regular manifest required');
  JSON.parse(readFileSync(manifest, 'utf8'));
  if (realpathSync(destination) !== path.resolve(destination)) throw new TypeError('destination must be a real directory');
  if (run('git', ['status', '--porcelain'], destination)) throw new Error('destination checkout is not clean');
  const origin = run('git', ['remote', 'get-url', 'origin'], destination);
  const pushOrigin = run('git', ['remote', 'get-url', '--push', 'origin'], destination);
  if (origin !== pushOrigin || !verifyDestination(origin)) throw new Error('destination identity, privacy or write permission not verified');
  const branch = run('git', ['symbolic-ref', '--short', 'HEAD'], destination);
  if (!branch || branch === 'HEAD') throw new Error('destination requires a branch');
  const relative = path.join('bundles', planId, bundleId);
  const target = path.join(destination, relative);
  if (bundle === destination || bundle.startsWith(`${destination}${path.sep}`)) throw new TypeError('bundle must be outside destination');
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  if (realpathSync(parent) !== parent) throw new TypeError('destination parent must not contain links');
  mkdirSync(target);
  copyBundle(bundle, target);
  copyFileSync(manifest, path.join(target, 'manifest.json'), 1);
  run('git', ['add', '--', relative], destination);
  run('git', ['commit', '-m', `Retain evidence bundle ${bundleId}`, '--', relative], destination);
  const head = run('git', ['rev-parse', 'HEAD'], destination);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], destination);
  return { relative, head, manifestSha256: createHash('sha256').update(readFileSync(manifest)).digest('hex'), retention: 'private-git', publication: 'pushed' };
}

/** Refuse any lookalike remote, public repository, or missing push permission. */
export function verifyPrivateEvidenceOrigin(origin) {
  if (!/^(https:\/\/github\.com\/evoclock\/model-fidelity-evidence(?:\.git)?|git@github\.com:evoclock\/model-fidelity-evidence(?:\.git)?)$/.test(origin)) return false;
  const repo = JSON.parse(run('gh', ['api', 'repos/evoclock/model-fidelity-evidence']));
  return repo.full_name === 'evoclock/model-fidelity-evidence' && repo.private === true && repo.permissions?.push === true;
}
