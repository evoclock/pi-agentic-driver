// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readdirSync, renameSync, copyFileSync, chmodSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { main } from '../scripts/skill_usage_eval.mjs';
import { parseSession, segments, loadedSkills, fitState, scoreSegment, aggregate } from '../scripts/skill_usage_core.mjs';
import { createAsker } from '../scripts/skill_usage_askers.mjs';

// Public checkouts do not ship the private model default. Tests already name
// the expected model and export it when local config is absent.
if (!process.env.PAD_SKILL_USAGE_OPENAI_MODEL) {
  process.env.PAD_SKILL_USAGE_OPENAI_MODEL = 'gpt-6-luna';
}

// Why: the npm-test stage must not discover the agent's HOME keys or change the real credential policy.
test('npm test stage owns a private HOME and retains only its download cache',async t=>{
  const module=resolve('scripts/node_test_home.mjs');
  assert.ok(existsSync(module),'private npm-test HOME runner is required');
  const {runWithPrivateHome}=await import(pathToFileURL(module).href);
  const root=mkdtempSync(join(tmpdir(),'ci-home-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'dirty');mkdirSync(home);
  for(const name of ['.typesafe_key','.openai_key']) writeFileSync(join(home,name),'owned fixture marker');
  const cache=join(root,'downloads');
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{test:'node inspect.cjs'}}));
  writeFileSync(join(root,'inspect.cjs'),`const fs=require('fs');const path=require('path');for(const name of ['.typesafe_key','.openai_key'])if(fs.existsSync(path.join(process.env.HOME,name)))process.exit(7);console.log('HOME_RESULT '+JSON.stringify({home:process.env.HOME,profile:process.env.USERPROFILE,cache:process.env.npm_config_cache,packedCache:process.env.PI_PACKED_NPM_CACHE}));`);
  const run=runWithPrivateHome('npm',['test'],{cwd:root,env:{...process.env,HOME:home,npm_config_cache:cache,PI_PACKED_NPM_CACHE:''},capture:true});
  assert.equal(run.status,0,run.output);
  const value=JSON.parse(run.output.match(/HOME_RESULT (.+)/)[1]);
  assert.notEqual(value.home,home);assert.equal(value.profile,value.home);assert.equal(value.cache,cache);
  assert.equal(value.packedCache,cache,'offline packed installs retain the same download cache');
  const explicit=join(root,'explicit-packed-cache');
  const configured=runWithPrivateHome('npm',['test'],{cwd:root,env:{...process.env,HOME:home,npm_config_cache:cache,PI_PACKED_NPM_CACHE:explicit},capture:true});
  assert.equal(configured.status,0,configured.output);
  const configuredValue=JSON.parse(configured.output.match(/HOME_RESULT (.+)/)[1]);
  assert.equal(configuredValue.packedCache,explicit,'explicit packed cache selection is preserved');
  assert.equal(configuredValue.cache,cache);
  assert.equal(existsSync(configuredValue.home),false);
  assert.equal(existsSync(value.home),false,'private home is cleaned after npm completes');
  assert.equal(readFileSync(join(home,'.typesafe_key'),'utf8'),'owned fixture marker');
  const pipeline=existsSync(resolve('.buildkite/pipeline.yml'))?readFileSync(resolve('.buildkite/pipeline.yml'),'utf8'):'';
  if (pipeline.includes('node scripts/node_test_home.mjs')) {
    assert.match(pipeline,/node scripts\/node_test_home\.mjs/);
  }
});

// Why: an installed skill must not direct callers to an evaluator absent from its archive.
test('packed skill-use evaluator includes its runnable workflow and scorer but excludes handcheck evidence', () => {
  const root = resolve(import.meta.dirname, '..');
  const instructions = readFileSync(resolve(root, 'skills/skill-usage-eval/SKILL.md'), 'utf8');
  assert.match(instructions, /scripts\/skill_usage_eval\.mjs/);
  const [archive] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }));
  const packed = new Set(archive.files.map(({ path }) => path));
  assert.ok(packed.has('skills/skill-usage-eval/SKILL.md'));
  for (const path of ['scripts/skill_usage_eval.mjs', 'scripts/skill_usage_core.mjs',
    'scripts/skill_usage_askers.mjs', 'docs/skill-usage-eval.md']) {
    assert.ok(packed.has(path), `${path} must ship with the advertised evaluator`);
  }
  assert.ok(!packed.has('scripts/skill_usage_handcheck.mjs'));
  assert.ok(packed.has('scripts/skill_usage_score.mjs'));
  assert.ok(!packed.has('docs/skill-usage-handcheck.md'));
  assert.ok(!archive.files.some(({ path }) => path.startsWith('tests/fixtures/skill_usage_')));
});

// Why: A scheduler needs identical paired input, private immutable evidence and a machine-readable history.
test('dual workflow scores the same sessions, keeps every run immutable and emits stable JSON', async () => {
  const scratch = resolve('.scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'dual-eval-test-'));
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  writeFileSync(join(sessions, 'one.jsonl'), [
    { type: 'session', cwd: '/repo' },
    { type: 'message', message: { role: 'user', content: 'Verify a changed test' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const catalog = [{ key: 'PAD/test-gate', name: 'test-gate', pack: 'PAD', path: '/repo/test-gate/SKILL.md',
    description: 'Verify changed tests' }];
  const calls = { jev: 0, openai: 0 };
  const askers = Object.fromEntries(['jev', 'openai'].map((provider) => [provider, {
    ask: async (_state, questions) => { calls[provider]++;
      return new Map(questions.map((q) => [q.name, provider === 'jev' ? 0.9 : 0.1])); },
  }]));
  const args = ['--dual', '--since', '24h', '--sessions', sessions, '--out', join(root, 'runs'), '--label-sample', '1'];
  await main(args, { catalog, askers });
  const out = join(root, 'runs');
  const [first] = readdirSync(out).filter((x) => x !== 'running.jsonl');
  const firstBytes = readFileSync(join(out, first, 'verdict.json'));
  const sample = JSON.parse(readFileSync(join(out, first, 'label-sample.json')));
  assert.equal(JSON.stringify(sample).includes('jev'), false);
  assert.equal(JSON.stringify(sample).includes('openai'), false);
  assert.deepEqual(calls, { jev: 1, openai: 1 });
  const labels = { schema: 'pad.skill-usage-labels.v1', rubric: 'Independent human task need',
    cases: sample.cases.map(({ id, skill, pack, evidenceKey }) => ({ id, skill, pack, evidenceKey, needed: true })) };
  const labelsPath = join(root, 'labels.json');
  writeFileSync(labelsPath, JSON.stringify(labels));
  await assert.doesNotReject(main([...args, '--labels', labelsPath], { catalog, askers }));
  assert.deepEqual(readFileSync(join(out, first, 'verdict.json')), firstBytes);
  const records = readFileSync(join(out, 'running.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].output, records[1].output);
  assert.equal(records[1].running.providers.jev.tp, 1);
  assert.equal(records[1].running.providers.openai.fn, 1);
  assert.equal(records[1].running.clearWinner, null);
  assert.equal(JSON.parse(readFileSync(join(records[1].output, 'run.json'))).schema, 'pad.skill-usage-dual.v1');
  assert.equal(JSON.parse(readFileSync(join(records[1].output, 'score.json'))).n, 1);
});

// Why: A changed task or skill must not inherit a positional label from an earlier sample.
test('rejects labels when frozen evidence changes at the same positional id', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-binding-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  const file = join(sessions, 'one.jsonl');
  const transcript = (goal) => [{ type: 'session', cwd: '/repo' },
    { type: 'message', message: { role: 'user', content: goal } }].map(JSON.stringify).join('\n') + '\n';
  writeFileSync(file, transcript('Original task'));
  const catalog = [{ key: 'PAD/test', name: 'test', pack: 'PAD', description: 'Original skill' }];
  const askers = Object.fromEntries(['jev', 'openai'].map((p) => [p, {
    ask: async (_state, questions) => new Map(questions.map((q) => [q.name, 0.9])),
  }]));
  const args = ['--dual', '--sessions', sessions, '--out', join(root, 'runs'), '--label-sample', '1'];
  await main(args, { catalog, askers });
  const first = JSON.parse(readFileSync(join(root, 'runs', 'running.jsonl'), 'utf8'));
  const sample = JSON.parse(readFileSync(join(first.output, 'label-sample.json')));
  const labels = { schema: 'pad.skill-usage-labels.v1', rubric: 'Independent',
    cases: sample.cases.map(({ id, skill, pack, evidenceKey }) => ({ id, skill, pack, evidenceKey, needed: true })) };
  const labelPath = join(root, 'labels.json'); writeFileSync(labelPath, JSON.stringify(labels));
  writeFileSync(file, transcript('Different task'));
  await assert.rejects(main([...args, '--labels', labelPath], { catalog, askers }), /evidence|mismatch/i);
  writeFileSync(file, transcript('Original task'));
  await assert.rejects(main([...args, '--labels', labelPath], {
    catalog: [{ ...catalog[0], description: 'Different skill' }], askers,
  }), /evidence|mismatch/i);
});

// Why: Repeated judgments and correlated skills in one session cannot manufacture a winner.
test('running numbers deduplicate repeated evidence and require independent sessions', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-repeat-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  writeFileSync(join(sessions, 'one.jsonl'), [{ type: 'session', id: 'repeat-origin', cwd: '/repo' },
    { type: 'message', message: { role: 'user', content: 'One task' } }].map(JSON.stringify).join('\n') + '\n');
  const catalog = Array.from({ length: 4 }, (_, i) => ({ key: `PAD/s${i}`, name: `s${i}`, pack: 'PAD', description: `Skill ${i}` }));
  const askers = { jev: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.9])) },
    openai: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.1])) } };
  const args = ['--dual', '--sessions', sessions, '--out', join(root, 'runs'), '--label-sample', '4'];
  await main(args, { catalog, askers });
  const first = JSON.parse(readFileSync(join(root, 'runs', 'running.jsonl'), 'utf8'));
  const sample = JSON.parse(readFileSync(join(first.output, 'label-sample.json')));
  const labelPath = join(root, 'labels.json');
  writeFileSync(labelPath, JSON.stringify({ schema: 'pad.skill-usage-labels.v1', rubric: 'Independent',
    cases: sample.cases.map(({ id, skill, pack, evidenceKey }) => ({ id, skill, pack, evidenceKey, needed: true })) }));
  for (let i = 0; i < 25; i++) await assert.doesNotReject(main([...args, '--labels', labelPath], { catalog, askers }));
  const records = readFileSync(join(root, 'runs', 'running.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 26);
  assert.equal(records.at(-1).running.providers.jev.n, 4);
  assert.equal(records.at(-1).running.sessions, 1);
  assert.equal(records.at(-1).running.clearWinner, null);
});

// Why: Appending to two real sessions must not turn 100 snapshots into 100 independent sessions.
test('repeated revisions retain the latest case per stable session', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-revisions-'));
  const catalog = [{ key: 'PAD/test', name: 'test', pack: 'PAD', description: 'Skill' }];
  const askers = { jev: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.9])) },
    openai: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.1])) } };
  for (let revision = 0; revision < 50; revision++) for (const [id, needed] of [['positive', true], ['negative', false]]) {
    const sessions = join(root, id); mkdirSync(sessions, { recursive: true });
    const args = ['--dual', '--sessions', sessions, '--out', join(root, 'runs'), '--label-sample', '1'];
    const file = join(sessions, `${id}.jsonl`);
    const history = [{ type: 'session', id, cwd: '/repo' },
      { type: 'message', message: { role: 'user', content: 'One stable task' } },
      ...Array.from({ length: revision }, (_, i) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `revision ${i}` }] } }))];
    writeFileSync(file, history.map(JSON.stringify).join('\n') + '\n');
    await main(args, { catalog, askers });
    const records = readFileSync(join(root, 'runs', 'running.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const sample = JSON.parse(readFileSync(join(records.at(-1).output, 'label-sample.json')));
    const labelPath = join(root, 'labels.json');
    writeFileSync(labelPath, JSON.stringify({ schema: 'pad.skill-usage-labels.v1', rubric: 'Independent',
      cases: sample.cases.map(({ id: caseId, skill, pack, evidenceKey }) =>
        ({ id: caseId, skill, pack, evidenceKey, needed: revision === 49 ? true : needed })) }));
    await main([...args, '--labels', labelPath], { catalog, askers });
  }
  const records = readFileSync(join(root, 'runs', 'running.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const last = records.at(-1).running;
  assert.equal(last.providers.jev.n, 2);
  assert.equal(last.sessions, 2);
  assert.equal(last.clearWinner, null);
  assert.equal(records.length, 200);
  assert.equal(last.providers.jev.tp, 2);
  assert.equal(last.providers.jev.fp, 0);
});

// Why: Renames and copies of two ID-less origins must not become 100 independent sessions.
test('ID-less renamed and copied snapshots remain descriptive across 50 rounds', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-idless-'));
  const catalog = [{ key: 'PAD/test', name: 'test', pack: 'PAD', description: 'Skill' }];
  const askers = { jev: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.9])) },
    openai: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.1])) } };
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  const archive = join(root, 'archive'); mkdirSync(archive);
  const out = join(root, 'runs');
  for (let round = 0; round < 50; round++) for (const [name, needed] of [['positive', true], ['negative', false]]) {
    const origin = join(sessions, name); mkdirSync(origin, { recursive: true });
    const file = join(origin, `${name}-${round}.jsonl`);
    if (round === 0) writeFileSync(file, [{ type: 'session', cwd: '/repo' },
      { type: 'message', message: { role: 'user', content: 'Stable task' } }].map(JSON.stringify).join('\n') + '\n');
    else if (round % 2) renameSync(join(origin, `${name}-${round - 1}.jsonl`), file);
    else {
      const previous = join(origin, `${name}-${round - 1}.jsonl`);
      const archived = join(archive, `${name}-${round - 1}.jsonl`);
      renameSync(previous, archived);
      copyFileSync(archived, file);
    }
    const args = ['--dual', '--sessions', origin, '--out', out, '--label-sample', '1'];
    await main(args, { catalog, askers });
    const sampleRun = JSON.parse(readFileSync(join(out, 'running.jsonl'), 'utf8').trim().split('\n').at(-1));
    const sample = JSON.parse(readFileSync(join(sampleRun.output, 'label-sample.json')));
    const labelsPath = join(root, 'labels.json');
    writeFileSync(labelsPath, JSON.stringify({ schema: 'pad.skill-usage-labels.v1', rubric: 'Independent',
      cases: sample.cases.map(({ id, skill, pack, evidenceKey }) => ({ id, skill, pack, evidenceKey, needed })) }));
    await main([...args, '--labels', labelsPath], { catalog, askers });
  }
  const last = JSON.parse(readFileSync(join(out, 'running.jsonl'), 'utf8').trim().split('\n').at(-1)).running;
  assert.equal(last.sessions, 0);
  assert.equal(last.verifiedProviders.jev.n, 0);
  assert.ok(last.providers.jev.n >= 100);
  assert.ok(last.descriptiveOnly.cases >= 100);
  assert.equal(last.clearWinner, null);
});

// Why: Existing weak key permissions must be visible without changing the key asset.
test('existing permissive binding key warns without repair', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-key-mode-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  const out = join(root, 'runs'); mkdirSync(out);
  const key = join(out, 'label-binding.key');
  writeFileSync(key, 'a'.repeat(64), { mode: 0o600 }); chmodSync(key, 0o644);
  const original = readFileSync(key);
  const catalog = [{ key: 'PAD/test', name: 'test', pack: 'PAD', description: 'Skill' }];
  const askers = { jev: { ask: async () => new Map() }, openai: { ask: async () => new Map() } };
  await main(['--dual', '--sessions', sessions, '--out', out, '--label-sample', '1'], { catalog, askers });
  const record = JSON.parse(readFileSync(join(out, 'running.jsonl'), 'utf8'));
  assert.match(record.warnings.join(' '), /binding key.*permissions.*0600/i);
  assert.deepEqual(readFileSync(key), original);
  assert.equal(statSync(key).mode & 0o777, 0o644);
});

// Why: A blind sample alone must not let a labeller enumerate the two prediction bits.
test('sample evidence does not disclose predictions by four hash guesses', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-blind-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  writeFileSync(join(sessions, 'one.jsonl'), [{ type: 'session', id: 'stable', cwd: '/repo' },
    { type: 'message', message: { role: 'user', content: 'Task' } }].map(JSON.stringify).join('\n') + '\n');
  const catalog = [{ key: 'PAD/test', name: 'test', pack: 'PAD', description: 'Skill' }];
  const askers = { jev: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.9])) },
    openai: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.1])) } };
  await main(['--dual', '--sessions', sessions, '--out', join(root, 'runs'), '--label-sample', '1'], { catalog, askers });
  const [run] = readdirSync(join(root, 'runs')).filter((x) => x !== 'running.jsonl' && x !== 'label-binding.key');
  const [entry] = JSON.parse(readFileSync(join(root, 'runs', run, 'label-sample.json'))).cases;
  const [, segment] = entry.id.split('-').map(Number);
  const guesses = [false, true].flatMap((jev) => [false, true].map((openai) =>
    createHash('sha256').update(JSON.stringify([entry.sessionKey, segment, catalog[0].key,
      entry.goal, entry.skill, entry.pack, entry.description, jev, openai])).digest('hex')));
  assert.ok(!guesses.includes(entry.evidenceKey));
  assert.equal(readdirSync(join(root, 'runs')).includes('label-binding.key'), true);
});

// Why: Total provider outage must fail the machine contract without a success history record.
test('zero paired segments with provider failures fails closed', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-outage-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  writeFileSync(join(sessions, 'one.jsonl'), [{ type: 'session', cwd: '/repo' },
    { type: 'message', message: { role: 'user', content: 'Task' } }].map(JSON.stringify).join('\n') + '\n');
  const catalog = [{ key: 'PAD/test', name: 'test', pack: 'PAD', description: 'Skill' }];
  const askers = { jev: { ask: async () => { throw new Error('HTTP 500'); } },
    openai: { ask: async (_s, qs) => new Map(qs.map((q) => [q.name, 0.9])) } };
  await assert.rejects(main(['--dual', '--sessions', sessions, '--out', join(root, 'runs')], { catalog, askers }),
    /no paired|provider/i);
  assert.equal(readdirSync(join(root, 'runs')).includes('running.jsonl'), false);
});

// Why: Concurrent identical runs must reserve distinct folders and preserve both complete history lines.
test('concurrent identical inputs preserve distinct runs and the exact append-only prefix', async () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-concurrent-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  writeFileSync(join(sessions, 'one.jsonl'), [{ type: 'session', cwd: '/repo' },
    { type: 'message', message: { role: 'user', content: 'Task' } }].map(JSON.stringify).join('\n') + '\n');
  const catalog = [{ key: 'PAD/test', name: 'test', pack: 'PAD', description: 'Skill' }];
  const askers = Object.fromEntries(['jev', 'openai'].map((p) => [p, {
    ask: async (_state, qs) => new Map(qs.map((q) => [q.name, 0.9])),
  }]));
  const args = ['--dual', '--sessions', sessions, '--out', join(root, 'runs')];
  await main(args, { catalog, askers });
  const history = join(root, 'runs', 'running.jsonl');
  const prefix = readFileSync(history, 'utf8');
  await Promise.all([main(args, { catalog, askers }), main(args, { catalog, askers })]);
  const later = readFileSync(history, 'utf8');
  assert.ok(later.startsWith(prefix));
  const lines = later.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.equal(new Set(lines.map((line) => line.output)).size, 3);
  for (const line of lines) assert.equal(JSON.parse(readFileSync(join(line.output, 'run.json'))).output, line.output);
});

// Why: A scheduler consumes exactly one JSON stdout success or one JSON stderr error with exit status.
test('CLI stdout and stderr JSON contracts have disjoint success and failure', () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-cli-'));
  const script = resolve('scripts/skill_usage_eval.mjs');
  const args = ['--dual', '--sessions', join(root, 'empty'), '--out', join(root, 'runs')];
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
  const env = { ...process.env, OPENAI_API_KEY: 'fake', TYPESAFE_API_KEY: 'fake' };
  const success = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  assert.equal(success.status, 0);
  assert.equal(success.stderr, '');
  const record = JSON.parse(success.stdout.trim());
  assert.equal(record.schema, 'pad.skill-usage-dual.v1');
  assert.equal(record.status, 'ok');
  assert.equal(record.segments, 0);
  assert.equal(readFileSync(join(record.output, 'run.json'), 'utf8').includes('pad.skill-usage-dual.v1'), true);
  const failure = spawnSync(process.execPath, [script, ...args, '--acting', 'invalid'], { encoding: 'utf8', env });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.deepEqual(JSON.parse(failure.stderr.trim()), {
    schema: 'pad.skill-usage-dual-error.v1', status: 'failed', error: 'Invalid --acting provider',
  });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

// Why: The actual dual CLI must surface read counts without publishing sensitive read paths or transcript text.
test('dual CLI preserves unresolved and external read evidence in private reports and safe stdout counts', () => {
  const root = mkdtempSync(join(resolve('.scratch'), 'dual-read-cli-'));
  const script = resolve('scripts/skill_usage_eval.mjs');
  const preload = `globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = url.includes('openai.com')
      ? body.questions.map(({ name }) => ({ type: 'predicate', name, probability: 0.9 }))
      : Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: 0.9 }]));
    return { ok: true, json: async () => ({ answers }) };
  };`;
  const env = { ...process.env, OPENAI_API_KEY: 'fake', TYPESAFE_API_KEY: 'fake' };
  const cases = ['unresolved', 'external', 'clean'];
  for (const kind of cases) {
    const folder = join(root, kind);
    mkdirSync(folder);
    const cwd = join(folder, 'cwd'); mkdirSync(cwd);
    const target = join(folder, 'target.md');
    const alias = join(cwd, 'alias.md');
    if (kind === 'external') { writeFileSync(target, 'fixture'); symlinkSync(target, alias); }
    if (kind === 'unresolved') symlinkSync(join(folder, 'missing.md'), alias);
    const messages = [{ type: 'session', id: kind, cwd },
      { type: 'message', message: user('Check safe read evidence sensitive-transcript-marker') }];
    if (kind !== 'clean') messages.push(
      { type: 'message', message: tool('read-1', 'alias.md') },
      { type: 'message', message: result('read-1') });
    const sessions = join(folder, 'sessions'); mkdirSync(sessions);
    writeFileSync(join(sessions, 'one.jsonl'), messages.map(JSON.stringify).join('\n') + '\n');
    const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      script, '--dual', '--sessions', sessions, '--out', join(folder, 'runs'), '--label-sample', '1'],
    { encoding: 'utf8', env });
    assert.equal(child.status, 0, child.stderr);
    const record = JSON.parse(child.stdout.trim());
    assert.equal(record.schema, 'pad.skill-usage-dual.v1');
    assert.equal(record.segments, 1);
    const expected = { unresolvedReads: Number(kind === 'unresolved'), externalReads: Number(kind === 'external') };
    assert.deepEqual(record.readObservations, expected);
    assert.deepEqual(JSON.parse(readFileSync(join(record.output, 'run.json'))).readObservations, expected);
    for (const name of ['verdict.json', 'shadow.json']) {
      const report = JSON.parse(readFileSync(join(record.output, name)));
      assert.equal(report.unresolvedReads.length, expected.unresolvedReads);
      assert.equal(report.externalReads.length, expected.externalReads);
      if (kind === 'unresolved') assert.deepEqual(report.unresolvedReads,
        [{ index: 0, segmentIndex: 0, path: alias, reason: 'ENOENT' }]);
      if (kind === 'external') assert.deepEqual(report.externalReads,
        [{ index: 0, segmentIndex: 0, path: alias, realPath: target }]);
    }
    const sample = readFileSync(join(record.output, 'label-sample.json'), 'utf8');
    assert.ok(!sample.includes('"jev"') && !sample.includes('"openai"'));
    assert.ok(!sample.includes('alias.md'));
    assert.ok(!child.stdout.includes('sensitive-transcript-marker'));
    assert.ok(!child.stdout.includes('alias.md'));
  }
});

const skill = { key: 'PAD/test-gate', name: 'test-gate', pack: 'PAD',
  path: '/packs/PAD/test-gate/SKILL.md', description: 'Verify changed tests' };
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const tool = (id, path) => ({ role: 'assistant', content: [{ type: 'toolCall', name: 'read', id,
  arguments: { path } }] });
const result = (id, isError = false) => ({ role: 'toolResult', toolCallId: id, isError,
  content: [{ type: 'text', text: 'skill content' }] });

// Why: Catalog advertising cannot be mistaken for an agent skill read.
test('parses only messages; system catalog is not a load', () => {
  const lines = [{ type: 'session', cwd: '/repo' },
    { type: 'message', message: { role: 'system', content: skill.path } },
    { type: 'message', message: user('Verify tests') }].map(JSON.stringify).join('\n');
  const parsed = parseSession(lines);
  assert.equal(parsed.harness, false);
  assert.equal(loadedSkills(parsed.messages, [skill]).size, 0);
  assert.equal(segments(parsed.messages).length, 1);
  assert.equal(parseSession(lines.replace('Verify tests', 'skill-proof --no-skills')).harness, true);
});

// Why: Only successful agent-initiated reads count as observed loads.
test('a successful actual read counts; a failed read and bare mention do not', () => {
  assert.deepEqual([...loadedSkills([user(skill.path), tool('a', skill.path), result('a')], [skill])], [skill.key]);
  assert.equal(loadedSkills([tool('a', skill.path), result('a', true)], [skill]).size, 0);
  assert.equal(loadedSkills([user(skill.path)], [skill]).size, 0);
});

// Why: A path-bearing write/edit is not evidence that the skill procedure was read.
test('only successful content reads establish a skill load', () => {
  const call = (id, name, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
  for (const name of ['write', 'edit']) {
    assert.equal(loadedSkills([call('a', name, { path: skill.path }), result('a')], [skill]).size, 0);
  }
  assert.equal(loadedSkills([call('a', 'read', { path: skill.path }), result('a', true)], [skill]).size, 0);
  assert.deepEqual([...loadedSkills([call('a', 'read', { path: skill.path }), result('a')], [skill])], [skill.key]);
  assert.equal(loadedSkills([call('a', 'bash', { command: `cat ${skill.path}` }), result('a')], [skill]).size, 0);
  assert.equal(loadedSkills([call('a', 'bash', { command: `echo ${skill.path}` }), result('a')], [skill]).size, 0);
});

// Why: A shell command mentioning a skill is not proof that its contents were read.
test('shell path mentions and write commands never establish a load', () => {
  for (const command of [
    `cat /dev/null; printf '%s' '${skill.path}'`,
    `sed -i '' 's/old/new/' ${skill.path}`,
    `cat /dev/null > ${skill.path}; printf done`,
    `printf done >> ${skill.path}`,
    `cat /dev/null | tee ${skill.path}`,
  ]) {
    const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'bash', arguments: { command } }] };
    assert.equal(loadedSkills([call, result('a')], [skill]).size, 0, command);
  }
});

// Why: Similar strings do not identify the exact catalog file or pack.
test('reads of backup files and same-named skills in other packs do not load the catalog skill', () => {
  for (const path of [`${skill.path}.backup`, '/packs/other/test-gate/SKILL.md']) {
    assert.equal(loadedSkills([tool('a', path), result('a')], [skill]).size, 0, path);
  }
});

// Why: Normalizing a dedicated read path preserves exact file identity.
test('a normalized equivalent dedicated read loads only its catalog entry', () => {
  assert.deepEqual([...loadedSkills([tool('a', '/packs/PAD/other/../test-gate/SKILL.md'), result('a')], [skill])], [skill.key]);
});

// Why: A relative read from another project's session cannot load this catalog.
test('foreign recorded cwd does not credit a relative skill read', async () => {
  const transcript = [{ type: 'session', cwd: '/foreign/project' },
    { type: 'message', message: user('Verify tests') },
    { type: 'message', message: tool('a', 'skills/test-gate/SKILL.md') },
    { type: 'message', message: result('a') }].map(JSON.stringify).join('\n');
  const session = parseSession(transcript);
  const [segment] = segments(session.messages, session.cwd);
  const localSkill = { ...skill, path: process.cwd() + '/skills/test-gate/SKILL.md' };
  const rows = await scoreSegment(segment, [localSkill],
    { ask: async (_state, questions) => new Map(questions.map((q) => [q.name, 0.9])) });
  assert.deepEqual(aggregate(rows, [localSkill]).skills[0],
    { skill: 'test-gate', pack: 'PAD', loadedWhenNeeded: 0, missedWhenNeeded: 1, loadedNotFollowed: 0 });
});

// Why: The recorded cwd is the positive origin for relative read targets.
test('relative read under recorded cwd credits the exact catalog path', () => {
  const transcript = [{ type: 'session', cwd: '/packs/PAD' },
    { type: 'message', message: user('Verify tests') },
    { type: 'message', message: tool('a', 'test-gate/SKILL.md') },
    { type: 'message', message: result('a') }].map(JSON.stringify).join('\n');
  const session = parseSession(transcript);
  assert.deepEqual([...loadedSkills(segments(session.messages, session.cwd)[0].messages, [skill], session.cwd)], [skill.key]);
});

// Why: Missing origin must never be silently replaced with the evaluator's cwd.
test('relative read with no recorded cwd does not count', () => {
  const transcript = [{ type: 'session' }, { type: 'message', message: user('Verify tests') },
    { type: 'message', message: tool('a', 'test-gate/SKILL.md') },
    { type: 'message', message: result('a') }].map(JSON.stringify).join('\n');
  const session = parseSession(transcript);
  assert.equal(loadedSkills(segments(session.messages, session.cwd)[0].messages,
    [{ ...skill, path: process.cwd() + '/test-gate/SKILL.md' }], session.cwd).size, 0);
});

// Why: Identical transcript and catalog must score identically from distinct evaluator directories.
test('scoring a relative read is independent of evaluator cwd', () => {
  const script = `import { parseSession, segments, loadedSkills } from ${JSON.stringify(new URL('../scripts/skill_usage_core.mjs', import.meta.url).href)};
    const session = parseSession(${JSON.stringify([{ type: 'session', cwd: '/foreign/project' },
      { type: 'message', message: user('Verify tests') },
      { type: 'message', message: tool('a', 'skills/test-gate/SKILL.md') },
      { type: 'message', message: result('a') }].map(JSON.stringify).join('\n'))});
    console.log(JSON.stringify([...loadedSkills(segments(session.messages, session.cwd)[0].messages,
      [{ key: 'PAD/test-gate', path: ${JSON.stringify(process.cwd() + '/skills/test-gate/SKILL.md')} }], session.cwd)]));`;
  const run = (cwd) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' });
  assert.equal(run('/'), run(process.cwd()));
  assert.equal(run('/'), '[]\n');
});

// Why: A successful read through a symlink must credit the real catalog skill, not its alias.
test('symlinked read credits its catalog skill', () => {
  const scratch = resolve(import.meta.dirname, '../.scratch/skill-usage-tests');
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(resolve(scratch, 'linked-'));
  const target = resolve(folder, 'SKILL.md');
  writeFileSync(target, 'skill content');
  symlinkSync(target, resolve(folder, 'alias.md'));
  const observations = { unresolvedReads: [], externalReads: [] };
  assert.deepEqual([...loadedSkills([tool('a', resolve(folder, 'alias.md')), result('a')],
    [{ ...skill, path: target }], folder, observations)], [skill.key]);
  assert.deepEqual(observations.unresolvedReads, []);
});

// Why: Even a successful historical tool result cannot hide an unresolvable read path.
test('broken symlink flags an unresolved read without claiming a skill', () => {
  const scratch = resolve(import.meta.dirname, '../.scratch/skill-usage-tests');
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(resolve(scratch, 'broken-'));
  const alias = resolve(folder, 'alias.md');
  symlinkSync(resolve(folder, 'missing.md'), alias);
  const observations = { unresolvedReads: [], externalReads: [] };
  assert.equal(loadedSkills([tool('a', alias), result('a')], [skill], folder, observations).size, 0);
  assert.deepEqual(observations.unresolvedReads, [{ path: alias, reason: 'ENOENT' }]);
});

// Why: A link escaping the recorded session cwd must expose its real target, not disappear or count as a different skill.
test('outside-cwd link records its real path and still matches its catalog file', () => {
  const scratch = resolve(import.meta.dirname, '../.scratch/skill-usage-tests');
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(resolve(scratch, 'outside-'));
  const sessionCwd = resolve(folder, 'session');
  mkdirSync(sessionCwd);
  const target = resolve(folder, 'SKILL.md');
  writeFileSync(target, 'skill content');
  const alias = resolve(sessionCwd, 'alias.md');
  symlinkSync(target, alias);
  const observations = { unresolvedReads: [], externalReads: [] };
  assert.deepEqual([...loadedSkills([tool('a', 'alias.md'), result('a')],
    [{ ...skill, path: target }], sessionCwd, observations)], [skill.key]);
  assert.deepEqual(observations.externalReads, [{ path: alias, realPath: target }]);
  assert.equal(relative(sessionCwd, target).startsWith('..'), true);
});

// Why: A directory link followed by .. traverses the link target before its parent.
test('directory-link parent traversal credits only the real pack, even through a session alias', () => {
  const scratch = resolve(import.meta.dirname, '../.scratch/skill-usage-tests');
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(resolve(scratch, 'parent-link-'));
  const packA = resolve(folder, 'pack-a');
  const packB = resolve(folder, 'pack-b');
  mkdirSync(packA);
  mkdirSync(resolve(packB, 'child'), { recursive: true });
  const a = resolve(packA, 'SKILL.md');
  const b = resolve(packB, 'SKILL.md');
  writeFileSync(a, 'pack A');
  writeFileSync(b, 'pack B');
  symlinkSync(resolve(packB, 'child'), resolve(packA, 'redirect'), 'dir');
  const catalog = [{ ...skill, key: 'A/skill', path: a }, { ...skill, key: 'B/skill', path: b }];
  for (const cwd of [folder, resolve(folder, 'session')]) {
    if (cwd !== folder) {
      mkdirSync(cwd);
      symlinkSync(packA, resolve(cwd, 'alias'), 'dir');
    }
    const path = cwd === folder ? 'pack-a/redirect/../SKILL.md' : 'alias/redirect/../SKILL.md';
    const observations = { unresolvedReads: [], externalReads: [] };
    assert.deepEqual([...loadedSkills([tool('a', path), result('a')], catalog, cwd, observations)], ['B/skill']);
    assert.deepEqual(observations.unresolvedReads, []);
  }
});

// Why: A failed state budget must not erase an earlier historical read observation.
test('CLI reports a broken-link read despite an oversized message', () => {
  const scratch = resolve(import.meta.dirname, '../.scratch/skill-usage-tests');
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(resolve(scratch, 'oversized-'));
  const alias = resolve(folder, 'broken.md');
  symlinkSync(resolve(folder, 'missing.md'), alias);
  const session = [{ type: 'session', cwd: folder },
    { type: 'message', message: user('x'.repeat(27000)) },
    { type: 'message', message: tool('a', alias) },
    { type: 'message', message: result('a') }].map(JSON.stringify).join('\n');
  writeFileSync(resolve(folder, 'session.jsonl'), session);
  const output = resolve(folder, 'report');
  execFileSync(process.execPath, ['scripts/skill_usage_eval.mjs', '--sessions', folder, '--out', output],
    { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, OPENAI_API_KEY: 'test-only' } });
  const report = JSON.parse(readFileSync(output + '.json', 'utf8'));
  assert.equal(report.failures['Session segment cannot fit state budget'], 1);
  assert.deepEqual(report.unresolvedReads, [{ index: 0, path: alias, reason: 'ENOENT' }]);
  assert.match(readFileSync(output + '.md', 'utf8'), /Unresolved reads: 1\./);
});

// Why: The report must distinguish needed loads, misses and step violations.
test('fake decider distinguishes needed, missed and not followed', async () => {
  const asker = { ask: async (_state, questions) => {
    assert.match(questions[0].instructions, /^Evidence: Verify tests\nQuestion: Should the agent load test-gate/);
    return new Map(questions.map((q) => [q.name, 0.9]));
  } };
  const missing = await scoreSegment({ goal: 'Verify tests', messages: [user('Verify tests')] }, [skill], asker);
  const loaded = await scoreSegment({ goal: 'Verify tests', messages: [user('Verify tests'), tool('a', skill.path), result('a')] }, [skill], asker);
  const report = aggregate([...missing, ...loaded], [skill]);
  assert.deepEqual(report.skills[0], { skill: 'test-gate', pack: 'PAD',
    loadedWhenNeeded: 1, missedWhenNeeded: 1, loadedNotFollowed: 1 });
});

// Why: Tool results are short notes while turn order stays visible to the decider.
test('state is fitted in order and never contains tool output', () => {
  const state = fitState({ goal: 'Inspect', messages: [user('Inspect'), tool('a', skill.path), result('a')] });
  assert.ok(state.indexOf('Inspect') < state.indexOf('tool read'));
  assert.ok(!state.includes('skill content'));
  assert.match(state, /tool result 13 chars omitted/);
});

// Why: Tests must exercise the documented API shape without network traffic.
test('OpenAI request shape and strict answer matching with injected fetch', async () => {
  const asker = createAsker('openai', { openaiKey: 'fake', fetcher: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_json', data: { goal: 'context' } }] }]);
    assert.equal(body.questions[0].type, 'predicate');
    return { ok: true, json: async () => ({ answers: [{ type: 'predicate', name: 'n0', probability: 0.91 }] }) };
  } });
  assert.equal((await asker.ask('{"goal":"context"}', [{ name: 'n0', type: 'predicate', instructions: 'Needed?' }])).get('n0'), 0.91);
});

// Why: A refusal must never become a false negative decision.
test('a refusal fails closed', async () => {
  const asker = createAsker('openai', { openaiKey: 'fake', fetcher: async () => ({ ok: true,
    json: async () => ({ answers: [{ type: 'refusal', name: 'n0' }] }) }) });
  await assert.rejects(asker.ask('{"goal":"context"}', [{ name: 'n0', type: 'predicate', instructions: 'Needed?' }]));
});

// Why: Malformed transport answers must not be silently scored as negatives.
test('OpenAI rejects malformed probabilities and incomplete answers', async () => {
  const questions = [{ name: 'n0', type: 'predicate', instructions: 'Needed?' }];
  for (const answers of [[], [{ type: 'predicate', name: 'n0', probability: null }],
    [{ type: 'predicate', name: 'n0', probability: 1.5 }],
    [{ type: 'predicate', name: 'wrong', probability: 0.5 }]]) {
    const asker = createAsker('openai', { openaiKey: 'fake', fetcher: async () => ({ ok: true,
      json: async () => ({ answers }) }) });
    await assert.rejects(asker.ask('{}', questions));
  }
});

// Why: Untrusted saved memories must not become classifier input.
test('redacts injected memory and excludes coordinator-only runs', () => {
  const message = user('<external_bot_saved_memories>private memory</external_bot_saved_memories>Review this PR');
  assert.equal(fitState({ goal: 'Review', messages: [message] }).includes('private memory'), false);
  assert.equal(parseSession([{ type: 'session' }, { type: 'message', message: user('Pi coordinator. ONLY agentic_herdr_communication') }]
    .map(JSON.stringify).join('\n')).harness, true);
});

// Why: A separate transport must use Jev's named noul response, not the OpenAI array format.
test('Jev transport validates named probabilities with a fake fetch', async () => {
  const asker = createAsker('jev', { jevKey: 'fake', fetcher: async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(init.body);
    assert.equal(body.questions.n0.type, 'noul');
    return { ok: true, json: async () => ({ answers: { n0: { noul: 0.8 } } }) };
  } });
  assert.equal((await asker.ask('{}', [{ name: 'n0', type: 'predicate', instructions: 'Needed?' }])).get('n0'), 0.8);
});

// Why: Invalid probabilities must never be counted as missed skills.
test('rejects out-of-range answers before aggregation', async () => {
  await assert.rejects(scoreSegment({ goal: 'Verify', messages: [user('Verify')] }, [skill],
    { ask: async () => new Map([['n0', 1.2]]) }));
});
