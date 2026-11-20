import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const identity = /^[A-Za-z0-9_-]{8,64}$/;
const peerProgram = `import os,socket,sys,ctypes,struct
s=socket.socket(fileno=3)
if sys.platform == 'darwin':
 u=ctypes.c_uint(); g=ctypes.c_uint()
 c=ctypes.CDLL(None,use_errno=True)
 if c.getpeereid(3,ctypes.byref(u),ctypes.byref(g)) != 0: sys.exit(1)
 print(u.value)
elif sys.platform.startswith('linux'):
 print(struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1])
else: sys.exit(1)
`;

// The inherited descriptor is the accepted socket, never a uid supplied by the caller.
function peerUid(socket, pythonBin) {
  return new Promise((accept, reject) => {
    const child = spawn(pythonBin, ['-I', '-c', peerProgram], { stdio: ['ignore', 'pipe', 'ignore', socket._handle.fd] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 2000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && /^\d+\s*$/.test(output)) accept(Number(output.trim()));
      else reject(new Error('UNAUTHENTICATED'));
    });
  });
}

export async function acquireStateLock(stateDir, pythonBin = 'python3') {
  const handle = await fs.open(join(stateDir, 'daemon.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(pythonBin, ['-I', '-c', 'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      child.once('error', reject);
      child.once('close', code => code === 0 ? accept() : reject(new Error('AUTHORITY_ALREADY_RUNNING')));
    });
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function syncDir(path) {
  const handle = await fs.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableReplace(path, value) {
  const temporary = `${path}.${randomUUID()}.new`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, path);
  await syncDir(resolve(path, '..'));
}

export async function startAuthorityDaemon({ stateDir, socketPath, tenantByUid, pythonBin = 'python3', now = Date.now, fault } = {}) {
  if (!stateDir || !socketPath || !tenantByUid) throw new Error('BAD_REQUEST');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDir, 0o700);
  await syncDir(resolve(stateDir, '..'));
  const lock = await acquireStateLock(stateDir, pythonBin);
  try {
    const socket = await fs.lstat(socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid()) throw new Error('UNSAFE_SOCKET_PATH');
    await fs.unlink(socketPath);
  } catch (error) { if (error.code !== 'ENOENT') { await lock.close(); throw error; } }
  const boot = randomUUID(), states = new Map(), sockets = new Set(), deadlines = new Map();
  let queue = Promise.resolve(), closed = false;
  const readJSON = async path => { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  async function load(tenantId, taskId) {
    const key = `${tenantId}.${taskId}`;
    if (states.has(key)) return states.get(key);
    const directory = join(stateDir, key);
    await fs.mkdir(directory, { mode: 0o700, recursive: true });
    await syncDir(stateDir);
    const watermark = await readJSON(join(directory, 'high-water.json'));
    let state = { tenantId, taskId, seq: 0, epoch: 0, cancelled: null, lease: null, effects: {}, requests: {} };
    let log = '';
    try { log = await fs.readFile(join(directory, 'records.jsonl'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lines = log.split('\n');
    lines.pop();
    let valid = '';
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { break; }
      if (record.digest !== hash(record.state) || record.state.seq !== state.seq + 1) break;
      if (!watermark || record.state.seq > watermark.seq) break;
      state = record.state;
      valid += `${line}\n`;
    }
    await fs.writeFile(join(directory, 'records.jsonl'), valid, { mode: 0o600 });
    const snapshot = await readJSON(join(directory, 'snapshot.json'));
    if (snapshot && snapshot.seq > state.seq) state = snapshot;
    const stale = watermark ? state.seq !== watermark.seq || state.epoch !== watermark.epoch : state.seq !== 0;
    const entry = { state, directory, stale };
    states.set(key, entry);
    return entry;
  }
  const envelope = (state, op, extra = {}) => ({ ok: true, op, tenantId: state.tenantId, taskId: state.taskId, seq: state.seq, epoch: state.epoch, cancelled: state.cancelled, lease: state.lease, unknownEffects: Object.keys(state.effects).filter(id => ['admitted', 'unknown'].includes(state.effects[id])), backend: 'local-daemon', ...extra });
  const failure = (state, op, code) => envelope(state, op, { ok: false, error: { code, message: code, retryable: code === 'AUTHORITY_UNAVAILABLE' } });
  async function admit(request, uid) {
    const { op, tenantId, taskId } = request;
    const blank = { tenantId, taskId, seq: 0, epoch: 0, cancelled: null, lease: null, effects: {} };
    if (!Object.hasOwn(tenantByUid, uid)) return failure(blank, op, 'UNAUTHENTICATED');
    if (tenantByUid[uid] !== tenantId) return failure(blank, op, 'TENANT_MISMATCH');
    if (!identity.test(tenantId) || !identity.test(taskId)) return failure(blank, op, 'BAD_REQUEST');
    const entry = await load(tenantId, taskId), current = entry.state;
    const fail = code => failure(current, op, code);
    if (!['status', 'readEpoch', 'commitCancel', 'casAdmitEffect'].includes(op)) return fail('BAD_REQUEST');
    if (op === 'status') return envelope(current, op, { enabled: true });
    if (op === 'readEpoch') return entry.stale ? fail('STALE_AUTHORITY') : envelope(current, op);
    const body = request.body ?? Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'op'));
    if (body.tenantId !== undefined && body.tenantId !== tenantId || body.taskId !== undefined && body.taskId !== taskId) return fail('TENANT_MISMATCH');
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$|^[0-9a-f-]{36}$/i.test(body.requestId)) return fail('BAD_REQUEST');
    const digest = hash({ op, ...body });
    const previous = current.requests[body.requestId];
    if (previous) return previous.bodyHash === digest ? { ...previous.response, replayed: true } : fail('IDEMPOTENCY_MISMATCH');
    if (entry.stale || (body.clientSeenSeq ?? 0) > current.seq) return fail('STALE_AUTHORITY');
    if (current.seq >= Number.MAX_SAFE_INTEGER || current.epoch >= Number.MAX_SAFE_INTEGER) return fail('BAD_REQUEST');
    const next = structuredClone(current);
    let result = {};
    if (op === 'commitCancel') {
      if (!['owner_cancel', 'policy', 'other'].includes(body.reasonCode)) return fail('BAD_REQUEST');
      next.epoch++;
      next.cancelled ??= { atSeq: next.seq + 1, atEpoch: next.epoch, reasonCode: body.reasonCode, requestId: body.requestId };
    } else {
      if (!['claim', 'effect', 'settle'].includes(body.op)) return fail('BAD_REQUEST');
      if (next.cancelled && body.op !== 'settle') return fail('CANCELLED');
      if (body.op !== 'settle' && body.expectedEpoch !== next.epoch || body.op === 'effect' && body.expectedSeq !== next.seq) return fail('CAS_CONFLICT');
      if (next.lease && (next.leaseBoot !== boot || now() >= next.lease.expiresAt || process.hrtime.bigint() >= (deadlines.get(next.lease.leaseId) ?? 0n))) {
        deadlines.delete(next.lease.leaseId);
        current.lease = null;
        return fail('LEASE_EXPIRED');
      }
      if (body.op === 'claim') {
        if (!Number.isInteger(body.leaseTtlMs) || body.leaseTtlMs < 1000 || body.leaseTtlMs > 600000) return fail('BAD_REQUEST');
        next.epoch++;
        next.lease = { epoch: next.epoch, leaseId: randomUUID(), expiresAt: now() + body.leaseTtlMs };
        next.leaseBoot = boot;
        deadlines.set(next.lease.leaseId, process.hrtime.bigint() + BigInt(body.leaseTtlMs) * 1000000n);
        result = { leaseId: next.lease.leaseId };
      } else {
        if (!next.lease) return fail('LEASE_EXPIRED');
        if (next.lease.leaseId !== body.leaseId || next.lease.epoch !== body.expectedEpoch) return fail('CAS_CONFLICT');
        if (typeof body.effectId !== 'string' || Object.hasOwn(Object.prototype, body.effectId) || !/^[A-Za-z0-9_-]{1,128}$/.test(body.effectId)) return fail('BAD_REQUEST');
        if (body.op === 'effect') {
          if (Object.values(next.effects).some(value => ['admitted', 'unknown'].includes(value))) return fail('UNKNOWN_EFFECT_PENDING');
          if (Object.hasOwn(next.effects, body.effectId) || !/^[a-f0-9]{64}$/i.test(body.intentHash ?? '')) return fail('BAD_REQUEST');
          next.effects[body.effectId] = 'admitted';
          result = { effectId: body.effectId, admitted: true };
        } else {
          if (!Object.hasOwn(next.effects, body.effectId) || !['ok', 'failed', 'unknown'].includes(body.outcome) || !/^[a-f0-9]{64}$/i.test(body.evidenceHash ?? '')) return fail('BAD_REQUEST');
          next.effects[body.effectId] = body.outcome;
          result = { effectId: body.effectId };
        }
      }
    }
    next.seq++;
    const response = envelope(next, op, { requestId: body.requestId, result, committedAt: new Date(now()).toISOString() });
    next.requests[body.requestId] = { bodyHash: digest, response };
    const file = await fs.open(join(entry.directory, 'records.jsonl'), 'a', 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ state: next, digest: hash(next) })}\n`);
      await fault?.('afterWrite');
      await file.sync();
    } catch (error) { closed = true; throw error; } finally { await file.close(); }
    try {
      await syncDir(entry.directory);
      await durableReplace(join(entry.directory, 'high-water.json'), { seq: next.seq, epoch: next.epoch });
      await durableReplace(join(entry.directory, 'snapshot.json'), next);
    } catch (error) { closed = true; throw error; }
    entry.state = next;
    return response;
  }
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const credentials = peerUid(socket, pythonBin);
    credentials.catch(() => {});
    let data = '', submitted = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (submitted) return;
      data += chunk;
      if (Buffer.byteLength(data) > 65536) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      submitted = true;
      queue = queue.then(async () => {
        if (closed) { socket.destroy(); return; }
        try {
          const uid = await credentials;
          const request = JSON.parse(data.split('\n')[0]);
          const response = await admit(request, uid);
          socket.end(`${JSON.stringify(response)}\n`);
        } catch { socket.destroy(); }
      });
    });
  });
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(relative(process.cwd(), socketPath), accept); });
    await fs.chmod(socketPath, 0o660);
  } catch (error) { await lock.close(); throw error; }
  return { async close() {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise(accept => server.close(accept));
    await queue;
    await lock.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const daemon = await startAuthorityDaemon(config);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await daemon.close(); process.exit(0); });
}
