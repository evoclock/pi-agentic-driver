import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Why: every declared gate executable and known local pipeline dependency must be present, not waived.
test('gate tool readiness fails for each missing executable and names its command', async () => {
  assert.ok(existsSync('scripts/review_gate_tools.mjs'), 'gate tool readiness must exist');
  const { requiredGateTools, checkGateTools } = await import('../scripts/review_gate_tools.mjs');
  const tools = requiredGateTools();
  for (const name of ['sfw','rsvg-convert','janus/node_modules/.bin/tsc','janus/node_modules/.bin/tsx','node','npm','python3','git','make','curl','gh','buildkite-agent']) assert.ok(tools.some(tool => tool.name === name),name);
  assert.deepEqual(checkGateTools({available:() => true}),tools);
  for (const tool of tools) {
    assert.throws(() => checkGateTools({available:name => name !== tool.name}),error => error.message.includes(tool.name) && error.message.includes(tool.neededBy));
  }
  assert.ok(requiredGateTools({checks:[{kind:'command',id:'future-check',command:['future-tool','--check']}]}).some(tool => tool.name === 'future-tool' && tool.neededBy.includes('future-check')));
});

// Why: a real missing PATH must produce a hard nonzero exit, never an environment-gap warning.
test('tool readiness CLI fails closed with an empty executable search path', () => {
  assert.ok(existsSync('scripts/review_gate_tools.mjs'), 'gate tool readiness must exist');
  const result = spawnSync(process.execPath,['scripts/review_gate_tools.mjs'],{env:{...process.env,PATH:''},encoding:'utf8',timeout:10000});
  assert.equal(result.status,1,result.stdout + result.stderr);
  assert.match(result.stderr,/missing gate tool: sfw/);
  assert.match(result.stderr,/needed by/);
  assert.doesNotMatch(result.stdout,/OK|warning|skip/i);
});
