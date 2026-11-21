import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { packageInfo, packedFiles, registeredContract } from './packed_extension_contract.mjs';
const readme = readFileSync(resolve(import.meta.dirname, '../README.md'), 'utf8');
const surfacePath = resolve(import.meta.dirname, '../docs/shipped-surface.md');
const section = (text, start, end) => {
  const rest = text.split(start)[1] ?? '';
  return end ? rest.split(end)[0] : rest;
};

// Why: the packed README and surface reference must cover every public name and relative link.
test('README and packed reference cover every shipped skill, tool, command and link', async () => {
  assert.ok(existsSync(surfacePath), 'the packed surface reference must exist');
  assert.ok(packedFiles.has('docs/shipped-surface.md'), 'the surface reference must be packed');
  assert.ok(readme.includes('## Shipped features'), 'the README must retain its feature overview');
  const surface = readFileSync(surfacePath, 'utf8');
  const skills = new Set(packageInfo.pi.skills.map(s => s.split('/').at(-1)));
  const skillRows = [...section(surface, '## Skills\n', '').matchAll(/^\| `([^`]+)` \|/gm)].map(m => m[1]);
  assert.deepEqual(new Set(skillRows), skills);
  assert.equal(skillRows.length, skills.size);
  const { tools, commands } = await registeredContract();
  const toolRows = [...section(surface, '## Model-callable tools\n', '## Commands').matchAll(/^\| ((?:`[^`]+`(?:, )?)+) \|/gm)].flatMap(m => [...m[1].matchAll(/`([^`]+)`/g)].map(item => item[1]));
  // Private source retains the hold tool, but public sync projects it out for 3.2.0.
  const hasCurator = existsSync(resolve(import.meta.dirname, '../scripts/public_sync.py'));
  const publicTools = [...tools.keys()].filter(name => !(hasCurator && name === 'agentic_workflow_handbrake'));
  assert.deepEqual(new Set(toolRows), new Set(publicTools));
  assert.equal(toolRows.length, publicTools.length);
  const commandRows = [...section(surface, '## Commands\n', '## Skills').matchAll(/^\| ((?:`\/[^`]+`(?:, )?)+) \|/gm)]
    .flatMap(m => [...m[1].matchAll(/`\/([a-z][a-z0-9-]*)/g)].map(item => item[1]));
  assert.deepEqual(new Set(commandRows), new Set(commands));
  assert.equal(commandRows.length, commands.size);
  for (const [path, text] of [['README.md', readme], ['docs/shipped-surface.md', surface]]) {
    const missingLinks = [...text.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)(?:#[^)]*)?\)/g)]
      .map(m => posix.normalize(posix.join(posix.dirname(path), m[1]))).filter(link => !packedFiles.has(link));
    assert.deepEqual(missingLinks, [], path);
  }
});
