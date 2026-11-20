import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packedFiles, registeredContract } from './packed_extension_contract.mjs';

// Why: unsupported journey modes must not appear in the README or the model-callable package surface.
test('packed README and journey tool do not advertise hidden autonomy', async () => {
  assert.ok(packedFiles.has('README.md'));
  const readme = readFileSync(resolve(import.meta.dirname, '../README.md'), 'utf8');
  assert.doesNotMatch(readme, /autonomous|autonomy|overnight|\bcast\b/i);
  const { tools } = await registeredContract();
  const tool = tools.get('agentic_worker_dispatch');
  assert.ok(tool, 'dispatch must be registered');
  const surface = [tool.description, tool.promptSnippet, ...tool.promptGuidelines, JSON.stringify(tool.parameters)].join(' ');
  assert.doesNotMatch(surface, /autonomous|autonomy|overnight|\bcast\b/i);
});
