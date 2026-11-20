import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { dedupKey, outputPath, validateRecord } from './records.mjs';
import { publishOutput } from './attempts.mjs';

const safeId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new TypeError('Invalid ID');
  return value;
};
const conflict = () => Object.assign(new Error('Request key has different input or output'), { code: 'request-conflict' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function regular(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('Artifact is not a regular file');
}

async function location(claim) {
  const root = await realpath(claim.storeRoot);
  const unit = path.join(root, 'units', safeId(claim.unitId));
  const attempt = path.join(unit, 'attempts', safeId(claim.attemptId));
  let at = root;
  for (const segment of ['units', claim.unitId, 'attempts', claim.attemptId]) {
    at = path.join(at, segment);
    const stat = await lstat(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Symlink directory refused');
  }
  const ownerFile = path.join(attempt, 'owner.json');
  await regular(ownerFile);
  const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  if (owner.owner !== claim.owner || owner.generation !== claim.generation || owner.unitId !== claim.unitId || owner.attemptId !== claim.attemptId) {
    throw Object.assign(new Error('Attempt owner or generation does not match'), { code: 'attempt-conflict' });
  }
  return { unit, attempt };
}

function binding({ request, checkerVersion, inputDigest }, claim) {
  if (!validateRecord('request', request).ok || request.unitId !== claim.unitId) throw new TypeError('Invalid request');
  if (request.attemptId !== claim.attemptId) throw conflict();
  if (typeof inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(inputDigest)) throw new TypeError('Invalid input digest');
  const requestDigest = digest(Buffer.from(JSON.stringify(request)));
  return { schema: 'model-fidelity.reservation.v1', requestId: safeId(request.requestId), attemptId: claim.attemptId,
    generation: claim.generation, requestDigest, checkerVersion,
    inputDigest, key: dedupKey({ requestId: request.requestId, checkerVersion, inputDigest }) };
}

async function resultFile(attempt, requestId) {
  const file = path.join(attempt, outputPath('result', { requestId }));
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new TypeError('Invalid result size or type');
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('Result changed during read');
    return bytes;
  } finally { await handle.close(); }
}

async function reservation(args) {
  const { claim, request } = args;
  const place = await location(claim);
  const expected = binding(args, claim);
  const directory = path.join(place.unit, 'requests');
  try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Symlink directory refused');
  const file = path.join(directory, `${expected.requestId}.json`);
  return { place, expected, file, request };
}

async function inspect({ place, expected, file }) {
  await regular(file);
  let saved;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return { status: 'interrupted' }; throw error; }
  if (JSON.stringify(saved) !== JSON.stringify(expected)) throw conflict();
  const bytes = await resultFile(place.attempt, expected.requestId);
  return bytes === null ? { status: 'pending' } : { status: 'published', bytes };
}

export async function reserveRequest(args) {
  const entry = await reservation(args);
  if (await resultFile(entry.place.attempt, entry.expected.requestId) !== null) {
    try { return await inspect(entry); }
    catch (error) { if (error.code === 'ENOENT') throw conflict(); throw error; }
  }
  const bytes = Buffer.from(`${JSON.stringify(entry.expected)}\n`);
  const temporary = path.join(path.dirname(entry.file), `.request-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(temporary, entry.file); }
    catch (error) { if (error.code === 'EEXIST') return await inspect(entry); throw error; }
  } finally { await unlink(temporary); }
  if (await resultFile(entry.place.attempt, entry.expected.requestId) !== null) throw conflict();
  return { status: 'reserved' };
}

export async function readRequest(args) {
  const entry = await reservation(args);
  return inspect(entry);
}

export async function publishRequest({ bytes, ...args }) {
  const entry = await reservation(args);
  const state = await inspect(entry);
  if (state.status === 'interrupted') throw conflict();
  if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') throw new TypeError('Expected result bytes');
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new TypeError('Result exceeds read limit');
  const existing = await resultFile(entry.place.attempt, entry.expected.requestId);
  if (existing !== null) {
    if (existing.equals(Buffer.from(bytes))) return { status: 'published', bytes: existing };
    throw conflict();
  }
  try { await publishOutput(args.claim, { kind: 'result', ids: { requestId: entry.expected.requestId }, bytes }); }
  catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
  return { status: 'published', bytes: Buffer.from(bytes) };
}

export async function readArtifact(claim, artifactId, { maxBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw new TypeError('Invalid read limit');
  if (typeof artifactId !== 'string' || artifactId.length > 1024 || artifactId.includes('\\')) throw new TypeError('Invalid artifact ID');
  const segments = artifactId.split('/');
  if (!['results', 'views', 'evaluation', 'input'].includes(segments[0]) || segments.length < 2 || segments.some(segment => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(segment) || segment === '..')) throw new TypeError('Invalid artifact ID');
  if (segments[0] === 'input' && segments[1] !== 'bundles') throw new TypeError('Invalid artifact ID');
  const { attempt } = await location(claim);
  let at = attempt;
  for (const segment of segments.slice(0, -1)) {
    at = path.join(at, segment);
    const stat = await lstat(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Symlink directory refused');
  }
  const file = path.join(at, segments.at(-1));
  await regular(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TypeError('Artifact is not a regular file');
    if (stat.size > maxBytes) return { status: 'too-large', size: stat.size };
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) throw new Error('Artifact changed during read');
    return { status: 'ok', bytes };
  } finally { await handle.close(); }
}
