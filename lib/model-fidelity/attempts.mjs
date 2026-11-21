import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { outputPath } from './records.mjs';

const id = value => {
  if (!['string'].includes(typeof value) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new TypeError('Invalid ID');
  return value;
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const conflict = () => Object.assign(new Error('Attempt owner or generation does not match'), { code: 'attempt-conflict' });

async function exclusive(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function directory(root, parts) {
  let at = await realpath(root);
  for (const part of parts) {
    at = path.join(at, part);
    try { await mkdir(at); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(at)).isDirectory() || (await lstat(at)).isSymbolicLink()) throw conflict();
  }
  return at;
}

export async function createAttempt({ storeRoot, unitId, attemptId, owner }) {
  id(unitId); id(attemptId); id(owner);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const dir = await directory(storeRoot, ['units', unitId, 'attempts', attemptId]);
  const token = randomUUID();
  const claim = { schema: 'model-fidelity.owner.v1', unitId, attemptId, owner, generation: token };
  try { await exclusive(path.join(dir, 'owner.json'), json(claim)); }
  catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
  return { ...claim, storeRoot };
}

async function owned(claim, parts) {
  const dir = await directory(claim.storeRoot, ['units', id(claim.unitId), 'attempts', id(claim.attemptId)]);
  const saved = JSON.parse(await readFile(path.join(dir, 'owner.json'), 'utf8'));
  if (saved.owner !== claim.owner || saved.generation !== claim.generation || saved.unitId !== claim.unitId || saved.attemptId !== claim.attemptId) throw conflict();
  return directory(dir, parts);
}

export async function captureBundle(claim, { repoRoot, bundleId, sourceRevision, checker, files }) {
  id(bundleId);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new TypeError('Invalid source revision');
  if (typeof checker !== 'string' || !checker) throw new TypeError('Invalid checker');
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) throw new TypeError('Expected distinct file paths');
  const repo = await realpath(repoRoot);
  const inputs = [];
  for (const name of files) {
    if (typeof name !== 'string' || !name || name.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(name) || name.includes('\\')) throw new TypeError('Invalid input path');
    const target = path.resolve(repo, name);
    if (!target.startsWith(`${repo}${path.sep}`)) throw new TypeError('Input escapes repository');
    let current = repo;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new TypeError('Symlink input refused');
    }
    if (!(await lstat(target)).isFile()) throw new TypeError('Input must be a file');
    const bytes = await readFile(target);
    inputs.push({ path: name, bytes, sha256: sha(bytes) });
  }
  const parent = await owned(claim, ['input', 'bundles']);
  const dir = path.join(parent, bundleId);
  await mkdir(dir);
  for (const input of inputs) {
    const dest = await owned(claim, ['input', 'bundles', bundleId, 'files', ...input.path.split('/').slice(0, -1)]);
    await exclusive(path.join(dest, path.basename(input.path)), input.bytes);
  }
  const manifest = { schema: 'model-fidelity.bundle.v1', unitId: claim.unitId, attemptId: claim.attemptId, bundleId, owner: claim.owner, generation: claim.generation, sourceRevision, checker, files: inputs.map(({ path, sha256, bytes }) => ({ path, sha256, size: bytes.length })) };
  await owned(claim, ['input', 'bundles', bundleId]);
  await exclusive(path.join(dir, 'manifest.json'), json(manifest));
  return { ...manifest, manifestDigest: sha(json(manifest)) };
}

export async function publishOutput(claim, { kind, ids, name, bytes }) {
  if (!['result', 'view', 'evaluation'].includes(kind)) throw new TypeError('Invalid output kind');
  const relative = outputPath(kind, ids);
  const parts = relative.split('/').filter(Boolean);
  const filename = kind === 'result' ? parts.pop() : name;
  if (kind !== 'result' && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(filename)) throw new TypeError('Invalid output name');
  const dir = await owned(claim, parts);
  if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') throw new TypeError('Expected bytes');
  await exclusive(path.join(dir, filename), bytes);
  return { path: `${relative}${kind === 'result' ? '' : filename}`, sha256: sha(bytes) };
}
