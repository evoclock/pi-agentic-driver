import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as inventory from '../scripts/model_negative_controls.mjs';
import { preflight } from '../scripts/review_preflight.mjs';
import { guardToolCall } from '../scripts/enforcement/attended_authority_guard.js';

function fixture(run) {
  const scratch = resolve('.scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'recurrence-inventory-'));
  const put = (name, text) => {
    const path = join(root, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    put('config/model-negative-controls.v1.json', '{}');
    put('config/model-negative-controls.allowlist.v1.json', '{}');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    put('docs/design/New.tla', '---- MODULE New ----\nVARIABLE x\nInit == x = 0\nNext == x\' = x\nSpec == Init /\\ [][Next]_<<x>>\nRegistered == x = 0\n====\n');
    put('docs/design/New.cfg', 'SPECIFICATION Spec\nINVARIANT Registered\nCHECK_DEADLOCK FALSE\n');
    run({ root, put, git });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Why: a newly added model must fail fast with its missing names and repair file.
test('changed model inventory reports exact unregistered obligation', () => {
  assert.equal(typeof inventory.changedModelInventory, 'function');
  fixture(({ root }) => {
    const result = inventory.changedModelInventory({ root });
    assert.match(result.errors.join('\n'), /docs\/design\/New\.tla.*Registered/);
    assert.match(result.errors.join('\n'), /config\/model-negative-controls\.v1\.json/);
  });
});

// Why: make preflight must reject inventory drift before expensive checker runs.
test('preflight rejects an unregistered new model without running long gates', () => {
  fixture(({ root, put }) => {
    for (const name of ['review_gate_tools.mjs', 'owner_terms_lint.mjs', 'model_negative_controls.mjs']) put(`scripts/${name}`, 'process.exit(0);\n');
    for (const name of ['review_contract_preflight.py', 'review_test_tokens.py']) put(`scripts/${name}`, 'print("fixture")\n');
    const result = preflight({ cwd: root, fetch: false });
    assert.equal(result.ok, false);
    assert.match(result.message, /Registered/);
    assert.match(result.message, /config\/model-negative-controls\.v1\.json/);
  });
});

// Why: raw mkdir polling must not silently compete with supported FIFO admission.
test('legacy shared-lock shell acquisition is refused with the FIFO entry point', async () => {
  for (const command of [
    'until mkdir .local/locks/test-gate.lock; do sleep 60; done',
    'lock="$HOME/repo/.local/locks/test-gate.lock"; mkdir "$lock"',
  ]) {
    const result = await guardToolCall({ toolName: 'bash', input: { command } }, {});
    assert.equal(result?.block, true);
    assert.match(result.reason, /make test-gate/);
  }
  assert.equal(await guardToolCall({ toolName: 'bash', input: { command: 'make test-gate' } }, {}), undefined);
  assert.equal(await guardToolCall({ toolName: 'bash', input: { command: 'mkdir .scratch/fixture' } }, {}), undefined);
});
