import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, realpathSync, mkdirSync, readdirSync, openSync, closeSync, readFileSync,
  writeFileSync, fsyncSync, linkSync, unlinkSync, fstatSync, constants } from 'node:fs';

const requestId = /^[A-Za-z0-9_-]{16,128}$/;
const canonical = value => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
function syncDirectory(path) {
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function physicalPath(path) {
  const tail = []; let head = resolve(path);
  while (!existsSync(head)) { tail.unshift(basename(head)); head = dirname(head); }
  return join(realpathSync(head), ...tail);
}
function ensureDirectory(path) {
  if (!existsSync(path)) {
    ensureDirectory(dirname(path));
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    syncDirectory(dirname(path));
  }
  if (realpathSync(path) !== path) throw new Error('pending directory changed');
}

/** A crash-safe local outbox, not protection against its same-uid owner. */
export function pendingCancelStore({ stateDir, tenantId, taskId }) {
  if (!stateDir) return null;
  const namespace = createHash('sha256').update(JSON.stringify([tenantId, taskId])).digest('hex');
  const root = join(physicalPath(stateDir), `task-${namespace}`);
  const pathFor = id => {
    if (!requestId.test(id ?? '')) throw new Error('invalid pending request id');
    return join(root, `cancel-${id}.json`);
  };
  function validate(body, id) {
    if (!body || Array.isArray(body) || body.requestId !== id || body.tenantId !== tenantId || body.taskId !== taskId ||
        !['owner_cancel', 'policy', 'other'].includes(body.reasonCode) || !Number.isSafeInteger(body.clientSeenSeq) || body.clientSeenSeq < 0)
      throw new Error('invalid pending cancel');
    return body;
  }
  function read(id) {
    const fd = openSync(pathFor(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > 8192) throw new Error('invalid pending file');
      return validate(JSON.parse(readFileSync(fd, 'utf8')), id);
    } finally { closeSync(fd); }
  }
  return {
    load() {
      if (!existsSync(root)) {
        // A non-directory ancestor is a storage failure, not an empty queue.
        if (existsSync(stateDir)) readdirSync(stateDir);
        return [];
      }
      if (realpathSync(root) !== root) throw new Error('pending directory changed');
      const names = readdirSync(root).filter(name => name.startsWith('cancel-') && name.endsWith('.json')).sort();
      if (names.length > 1024) throw new Error('pending store limit');
      return names.map(name => read(name.slice(7, -5)));
    },
    save(body) {
      const target = pathFor(body.requestId); validate(body, body.requestId); ensureDirectory(root);
      const temp = join(root, `.pending-${randomUUID()}`), fd = openSync(temp, 'wx', 0o600);
      try {
        try { writeFileSync(fd, JSON.stringify(body)); fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(temp, target); }
        catch (error) {
          if (error.code !== 'EEXIST' || canonical(read(body.requestId)) !== canonical(body)) throw error;
        }
        syncDirectory(root);
      } finally { try { unlinkSync(temp); } catch { /* an unaccepted temporary record is ignored on restart */ } }
    },
    remove(id) {
      try { unlinkSync(pathFor(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      syncDirectory(root);
    },
  };
}
