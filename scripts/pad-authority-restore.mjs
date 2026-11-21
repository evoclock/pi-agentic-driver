import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { durableReplace, acquireStateLock } from './pad-authority-daemon.mjs';

export function validateRestore(snapshot, watermark = { seq: 0, epoch: 0 }) {
  if (!Number.isSafeInteger(snapshot?.seq) || !Number.isSafeInteger(snapshot?.epoch) || snapshot.seq < 0 || snapshot.epoch < 0) throw new Error('BAD_REQUEST');
  if (snapshot.seq < watermark.seq || snapshot.epoch < watermark.epoch) throw new Error('RESTORE_WOULD_REWIND');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(snapshot.tenantId ?? '') || !/^[A-Za-z0-9_-]{8,64}$/.test(snapshot.taskId ?? '') || !snapshot.requests || !snapshot.effects) throw new Error('BAD_REQUEST');
  return snapshot;
}

export async function restoreAuthoritySnapshot(stateDir, snapshotPath) {
  if (process.getuid?.() !== 0) throw new Error('FORBIDDEN: owner restore requires root');
  const lock = await acquireStateLock(stateDir);
  try {
    const snapshot = validateRestore(JSON.parse(await fs.readFile(snapshotPath, 'utf8')));
    const directory = join(stateDir, `${snapshot.tenantId}.${snapshot.taskId}`);
    const owner = await fs.stat(directory);
    const watermark = JSON.parse(await fs.readFile(join(directory, 'high-water.json'), 'utf8'));
    const current = JSON.parse(await fs.readFile(join(directory, 'snapshot.json'), 'utf8'));
    validateRestore(snapshot, { seq: Math.max(watermark.seq, current.seq), epoch: Math.max(watermark.epoch, current.epoch) });
    if (current.cancelled && JSON.stringify(snapshot.cancelled) !== JSON.stringify(current.cancelled)) throw new Error('RESTORE_WOULD_REWIND');
    for (const [id, record] of Object.entries(current.requests)) {
      if (JSON.stringify(snapshot.requests[id]) !== JSON.stringify(record)) throw new Error('RESTORE_WOULD_REWIND');
    }
    await durableReplace(join(directory, 'snapshot.json'), snapshot);
    await durableReplace(join(directory, 'high-water.json'), { seq: snapshot.seq, epoch: snapshot.epoch });
    for (const name of ['snapshot.json', 'high-water.json']) await fs.chown(join(directory, name), owner.uid, owner.gid);
  } finally { await lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: pad-authority-restore <state-dir> <snapshot>');
    await restoreAuthoritySnapshot(process.argv[2], process.argv[3]);
    console.log('RESTORED');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
