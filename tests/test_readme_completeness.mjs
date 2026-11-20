import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { packageInfo, packedFiles, registeredContract } from './packed_extension_contract.mjs';
const readme = readFileSync(resolve(import.meta.dirname, '../README.md'), 'utf8');
const section = (start, end) => readme.split(start)[1]?.split(end)[0] ?? '';

// Why: the public README must describe exactly the shipped skill and tool surface, not omitted or invented names.
test('README has every shipped skill, registered tool, command and packed link', async () => {
  const skills = new Set(packageInfo.pi.skills.map(s => s.split('/').at(-1)));
  const skillRows = [...section('## Skills\n', '## Safety model').matchAll(/^\| `([^`]+)` \|/gm)].map(m => m[1]);
  assert.deepEqual(new Set(skillRows), skills);
  assert.equal(skillRows.length, skills.size);
  const { tools, commands } = await registeredContract();
  const toolRows = [...section('### Model-callable tools', '### Commands, shortcuts').matchAll(/^\| ((?:`[^`]+`(?:, )?)+) \|/gm)].flatMap(m => [...m[1].matchAll(/`([^`]+)`/g)].map(item => item[1]));
  assert.deepEqual(new Set(toolRows), new Set(tools.keys()));
  assert.equal(toolRows.length, tools.size);
  const commandSection = section('### Commands, shortcuts', '## Skills');
  for (const command of commands) assert.ok(commandSection.includes(`/${command}`), command);
  const missingLinks = [...readme.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)(?:#[^)]*)?\)/g)]
    .map(m => posix.normalize(m[1].replace(/^\.\//, ''))).filter(link => !packedFiles.has(link));
  assert.deepEqual(missingLinks, []);
});
