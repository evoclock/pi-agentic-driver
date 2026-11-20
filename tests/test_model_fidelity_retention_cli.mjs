import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Why: callers need a closed-input JSON contract, even when the destination is invalid.
test('retention CLI returns typed error for relative destination', () => {
  const cli = new URL('../scripts/model_fidelity_retention.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, '--repo', '/project', '--destination', 'relative'], { input: '' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).schema, 'model-fidelity.retention.v1');
});
