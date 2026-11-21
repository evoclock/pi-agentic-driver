import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packedFiles, registeredContract } from './packed_extension_contract.mjs';

// Why: the shipped README must document 3.2.0, while model-callable dispatch must not advertise unsupported journey modes.
test('packed 3.2.0 README ships without hidden autonomy in journey tool', async () => {
  assert.ok(packedFiles.has('README.md'));
  const readme = readFileSync(resolve(import.meta.dirname, '../README.md'), 'utf8');
  assert.match(readme, /^## What's new in 3\.2\.0$/m);
  const { tools } = await registeredContract();
  const tool = tools.get('agentic_worker_dispatch');
  assert.ok(tool, 'dispatch must be registered');
  const surface = [tool.description, tool.promptSnippet, ...tool.promptGuidelines, JSON.stringify(tool.parameters)].join(' ');
  assert.doesNotMatch(surface, /autonomous|autonomy|overnight|\bcast\b/i);
});
