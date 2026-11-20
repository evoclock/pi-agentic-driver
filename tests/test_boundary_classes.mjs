import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Why: every filesystem class must be exercised without allowing a FIFO to hang the verifier.
test('user configuration reader rejects non-regular paths in bounded children', async () => {
  assert.ok(existsSync('tests/helpers/boundary_classes.mjs'), 'shared boundary tables must exist');
  const { pathCases } = await import('./helpers/boundary_classes.mjs');
  const fixture = pathCases();
  try {
    const module = new URL('../scripts/workflow_runner_user_config.mjs', import.meta.url).href;
    const program = `import {loadUserConfig} from ${JSON.stringify(module)}; try { loadUserConfig({env:{PAD_USER_CONFIG:process.argv[1]}}); } catch { process.exit(7); }`;
    for (const item of fixture.cases) {
      const result = spawnSync(process.execPath,['--input-type=module','-e',program,item.path],{encoding:'utf8',timeout:3000});
      assert.equal(result.error, undefined, `${item.name}: bounded child failed`);
      assert.equal(result.status,item.name === 'regular' ? 0 : 7,item.name);
    }
  } finally { rmSync(fixture.root,{recursive:true,force:true}); }
});

// Why: boundary numbers must drive real validators, including clamping and cross-field ordering.
test('user configuration numeric boundaries are rejected or bounded', async () => {
  assert.ok(existsSync('tests/helpers/boundary_classes.mjs'), 'shared boundary tables must exist');
  const { numbers } = await import('./helpers/boundary_classes.mjs');
  const { loadUserConfig } = await import('../scripts/workflow_runner_user_config.mjs');
  for (const item of numbers(100)) {
    const load = () => loadUserConfig({env:{PAD_USER_CONFIG:'fixture.json'},readFile:() => JSON.stringify({schema:'pad-user.v1',attempts:{max:item.value}})});
    if (['exact-limit','limit+1'].includes(item.name)) assert.equal(load().attempts.max,100,item.name);
    else assert.throws(load,/Invalid user config/,item.name);
  }
  assert.throws(() => loadUserConfig({env:{PAD_USER_CONFIG:'fixture.json'},readFile:() => JSON.stringify({schema:'pad-user.v1',progress:{noProgressLimit:20,safetyCeiling:2}})}), /Invalid user config/);
});

// Why: canonical cases must include often-missed empty, huge and non-regular inputs.
test('boundary tables enumerate strings, numbers and bounded filesystem cases', async () => {
  assert.ok(existsSync('tests/helpers/boundary_classes.mjs'), 'shared boundary tables must exist');
  const { strings, numbers, pathCases } = await import('./helpers/boundary_classes.mjs');
  assert.deepEqual(strings(4).map(item => item.name), ['absent','empty','whitespace-only','valid','over-limit']);
  assert.deepEqual(numbers(4).map(item => item.name), ['zero','negative','NaN','exact-limit','limit+1','huge']);
  const fixture = pathCases();
  try {
    assert.ok(statSync(fixture.root).isDirectory());
    assert.deepEqual(fixture.cases.map(item => item.name), ['regular','symlink','directory','FIFO','device','oversize-json']);
    assert.equal(JSON.parse(readFileSync(fixture.cases.at(-1).path)).payload.length, 262145);
  } finally { rmSync(fixture.root,{recursive:true,force:true}); }
});

// Why: blank credentials must not suppress explicit-file fallback or trigger a real credential process.
test('string classes exercise credential lookup with injected dependencies only', async () => {
  assert.ok(existsSync('tests/helpers/boundary_classes.mjs'), 'shared boundary tables must exist');
  const { strings } = await import('./helpers/boundary_classes.mjs');
  const { loadProviderCredential } = await import('../scripts/credential_store.mjs');
  for (const item of strings(8)) {
    let reads = 0;
    const result = await loadProviderCredential('openai', {env:{OPENAI_API_KEY:item.value,OPENAI_API_KEY_FILE:'fixture-key'},userConfig:{secrets:{}},readFile:async () => { reads++; return 'fixture-value'; },spawn:() => { throw new Error('unexpected process'); },stderr:{write(){}},stat:async () => { throw new Error('no implicit file'); }});
    const usable = typeof item.value === 'string' && item.value.trim().length > 0;
    assert.equal(result.key, usable ? item.value : 'fixture-value', item.name);
    assert.equal(reads, usable ? 0 : 1, item.name);
  }
});
