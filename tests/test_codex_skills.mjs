import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportCodexSkills } from '../scripts/codex_skills.mjs';

const script = fileURLToPath(new URL('../scripts/codex_skills.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pad-codex-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: bowerbird\ndescription: Draw diagrams.\n---\n\n# Source\n');
  return { home: path.join(root, 'codex'), sources: { bowerbird: source }, root };
}
function skill(name, disabled = false) {
  return `---\nname: ${name}\ndescription: Example.\n${disabled ? 'disable-model-invocation: true\n' : ''}---\n\n# Source\n`;
}

// Why: preview must be read-only and applying the same source twice must not touch user files.
test('dry-run writes nothing; apply makes Codex SKILL.md; re-run is byte-identical', async t => {
  const f = await fixture(t);
  assert.equal((await exportCodexSkills({ codexHome: f.home, packs: ['bowerbird'], sources: f.sources })).length, 1);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
  assert.equal((await exportCodexSkills({ codexHome: f.home, packs: ['bowerbird'], sources: f.sources, apply: true })).length, 1);
  const file = path.join(f.home, 'skills/pad-bowerbird/SKILL.md');
  const original = await readFile(file, 'utf8');
  assert.match(original, /^---\nname: pad-bowerbird\ndescription: Draw diagrams\./);
  assert.match(original, /bin\/bowerbird\.mjs/);
  assert.deepEqual(await exportCodexSkills({ codexHome: f.home, packs: ['bowerbird'], sources: f.sources, apply: true }), []);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(path.dirname(file)), ['SKILL.md']);
});

// Why: a user's edited file must survive, and backup paths must not collide on repeated updates.
test('changed user file is backed up before update, with collision-safe backups', async t => {
  const f = await fixture(t);
  const file = path.join(f.home, 'skills/pad-bowerbird/SKILL.md');
  for (let i = 0; i < 3; i++) {
    if (i) await writeFile(file, `user edits ${i}\n`);
    await exportCodexSkills({ codexHome: f.home, packs: ['bowerbird'], sources: f.sources, apply: true });
  }
  const backups = (await readdir(path.dirname(file))).filter(n => n.startsWith('SKILL.md.bak-'));
  assert.equal(backups.length, 2);
  assert.deepEqual((await Promise.all(backups.map(n => readFile(path.join(path.dirname(file), n), 'utf8')))).sort(), ['user edits 1\n', 'user edits 2\n']);
});

// Why: the source opt-out must survive the Codex bridge, and unavailable Pi tools must never imply CLI Herdr fallback.
test('opt-out skill emits non-implicit agents policy and blocked Herdr rule', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sources.bowerbird, 'SKILL.md'), skill('bowerbird', true));
  const actions = await exportCodexSkills({ codexHome: f.home, packs: ['bowerbird'], sources: f.sources, apply: true });
  assert.equal(actions.length, 2);
  assert.match(await readFile(path.join(f.home, 'skills/pad-bowerbird/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  assert.match(await readFile(path.join(f.home, 'skills/pad-bowerbird/SKILL.md'), 'utf8'), /mark (?:the step |it )?blocked/i);
  assert.match(await readFile(path.join(f.home, 'skills/pad-bowerbird/SKILL.md'), 'utf8'), /Never substitute raw `herdr` CLI/);
  assert.deepEqual(await exportCodexSkills({ codexHome: f.home, packs: ['bowerbird'], sources: f.sources, apply: true }), []);
});

// Why: YAML 1.2 booleans, including quoted true and case variants, must not silently lose opt-out intent.
test('YAML core boolean opt-out accepts quoted and case variants, rejects yes/on', async t => {
  const f = await fixture(t);
  const sourceFile = path.join(f.sources.bowerbird, 'SKILL.md');
  for (const [index, value] of ['true', 'True', 'TRUE', '"true"', "'true'", '"True"', "'TRUE'"].entries()) {
    await writeFile(sourceFile, `---\nname: bowerbird\ndescription: Draw diagrams.\ndisable-model-invocation: ${value}\n---\n`);
    const codexHome = path.join(f.root, `codex-${index}`);
    const result = await exportCodexSkills({ codexHome, packs: ['bowerbird'], sources: f.sources, apply: true });
    assert.equal(result.length, 2, `opt-out lost for ${value}`);
    assert.match(await readFile(path.join(codexHome, 'skills/pad-bowerbird/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  }
  for (const [index, value] of ['yes', 'on', '"yes"', 'false', 'FALSE', "'False'"].entries()) {
    await writeFile(sourceFile, `---\nname: bowerbird\ndescription: Draw diagrams.\ndisable-model-invocation: ${value}\n---\n`);
    const codexHome = path.join(f.root, `other-${index}`);
    if (['yes', 'on'].includes(value.replaceAll('"', ''))) {
      await assert.rejects(exportCodexSkills({ codexHome, packs: ['bowerbird'], sources: f.sources, apply: true }), /Invalid disable-model-invocation/);
    } else {
      assert.equal((await exportCodexSkills({ codexHome, packs: ['bowerbird'], sources: f.sources, apply: true })).length, 1);
    }
  }
});

// Why: poteto-mode includes statechart; a single source must have one destination and different sources must not collide.
test('multi-skill packs dedupe identical statechart source and reject distinct duplicate names', async t => {
  const f = await fixture(t);
  const pack = path.join(f.root, 'pack');
  await mkdir(path.join(pack, 'statechart-pi'), { recursive: true });
  await mkdir(path.join(pack, 'other'));
  await writeFile(path.join(pack, 'statechart-pi/SKILL.md'), skill('statechart-pi', true));
  await writeFile(path.join(pack, 'other/SKILL.md'), skill('other'));
  const sources = { 'poteto-mode': pack, statechart: path.join(pack, 'statechart-pi') };
  const options = { codexHome: f.home, packs: ['poteto-mode', 'statechart'], sources };
  assert.equal((await exportCodexSkills(options)).length, 3);
  assert.equal((await exportCodexSkills({ ...options, apply: true })).length, 3);
  assert.deepEqual(await exportCodexSkills({ ...options, apply: true }), []);
  const collision = path.join(f.root, 'other-statechart');
  await mkdir(collision);
  await writeFile(path.join(collision, 'SKILL.md'), skill('statechart-pi'));
  await assert.rejects(exportCodexSkills({ ...options, sources: { ...sources, statechart: collision }, apply: true }), /Duplicate skill name/);
});

// Why: home path spelling must not cause unbounded recursion or silently expand a relative path or tilde.
test('trailing and double slash home works; relative, tilde and traversal fail', async t => {
  const f = await fixture(t);
  for (const home of [`${f.home}/`, `${f.root}//codex`]) {
    assert.equal((await exportCodexSkills({ codexHome: home, packs: ['bowerbird'], sources: f.sources })).length, 1);
  }
  for (const home of ['relative', '~/codex', `${f.home}/../escape`]) {
    await assert.rejects(exportCodexSkills({ codexHome: home, packs: ['bowerbird'], sources: f.sources, apply: true }), /absolute|Path escape/);
  }
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
});

// Why: symlinked destination paths and invalid pack names must not write outside the requested home.
test('unknown pack and symlink escape fail without writing', async t => {
  const f = await fixture(t);
  await assert.rejects(exportCodexSkills({ codexHome: f.home, packs: ['unknown'], sources: f.sources }), /Unknown/);
  await mkdir(f.home);
  await symlink(f.root, path.join(f.home, 'skills'));
  await assert.rejects(exportCodexSkills({ codexHome: f.home, packs: ['bowerbird'], sources: f.sources, apply: true }), /Not a plain directory/);
  assert.deepEqual(await readdir(f.root), ['codex', 'source']);
});

// Why: an apply failure after a successful write must report both the completed file and failed destination.
test('partial apply reports completed writes, backups and failure path', async t => {
  const f = await fixture(t);
  const pack = path.join(f.root, 'pack');
  for (const name of ['first', 'second']) {
    await mkdir(path.join(pack, name), { recursive: true });
    await writeFile(path.join(pack, name, 'SKILL.md'), skill(name));
  }
  const home = f.home;
  const sources = { 'poteto-mode': pack };
  await exportCodexSkills({ codexHome: home, packs: ['poteto-mode'], sources, apply: true });
  await writeFile(path.join(home, 'skills/pad-first/SKILL.md'), 'user first\n');
  await writeFile(path.join(home, 'skills/pad-second/SKILL.md'), 'user second\n');
  let report;
  await assert.rejects(exportCodexSkills({
    codexHome: home, packs: ['poteto-mode'], sources, apply: true,
    beforeWrite: dest => { if (dest.includes('pad-second')) throw new Error('injected write failure'); },
  }), error => { report = error.report; return error.message.includes('injected write failure'); });
  assert.equal(report.mode, 'apply');
  assert.equal(report.completed.length, 1);
  assert.equal(report.completed[0].action, 'backup-and-update');
  assert.equal(await readFile(report.completed[0].backupPath, 'utf8'), 'user first\n');
  assert.match(report.failed.path, /pad-second\/SKILL.md$/);
  assert.equal(report.failed.error, 'injected write failure');
  assert.equal(await readFile(path.join(home, 'skills/pad-second/SKILL.md'), 'utf8'), 'user second\n');
});
