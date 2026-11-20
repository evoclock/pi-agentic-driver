export * from '../scripts/workflow_runner_core.mjs';
import { run as guardedRun } from '../scripts/workflow_runner_core.mjs';
import { createFakeAuthority } from '../scripts/workflow_runner_authority.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
/** Synthetic authority state is separate from the cache attacked by lock fixtures.
 * This is not a deployed authority or a proof of service-account isolation.
 * Cache writer exclusion serializes mutations in these fixtures.
 */
export function fixtureAuthority(repo, store) {
  const taskId = createHash('sha256').update(store).digest('hex').slice(0, 32);
  const root = join(repo, '.local', 'synthetic-authority'), file = join(root, `${taskId}.json`);
  return Object.fromEntries(['readEpoch', 'status', 'commitCancel', 'casAdmitEffect'].map(method => [method, body => {
    const fake = createFakeAuthority({ tenantId: 'tenant_0001', taskId,
      snapshot: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined });
    const result = fake[method](body);
    if (['commitCancel', 'casAdmitEffect'].includes(method)) {
      mkdirSync(root, { recursive: true }); const temp = `${file}.${randomUUID()}`;
      writeFileSync(temp, JSON.stringify(fake.snapshotForTests())); renameSync(temp, file);
    }
    return result;
  }]));
}
export function run(workflow, store, event, adapter = {}) {
  return guardedRun(workflow, store, event, { ...adapter, authority: adapter.authority ?? fixtureAuthority(workflow.repo, store) });
}
