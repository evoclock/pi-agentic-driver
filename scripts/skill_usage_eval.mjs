// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile, stat, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { parseSession, segments, discoverSkills, scoreSegment, aggregate, markdown } from './skill_usage_core.mjs';
import { createAsker } from './skill_usage_askers.mjs';
import { scoreHandcheck, wilson } from './skill_usage_score.mjs';

import { credentialOptions } from './credential_store.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function sessionFiles(root, since) {
  const files = [];
  async function visit(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && (await stat(path)).mtimeMs >= since) files.push(path);
    }
  }
  await visit(root, 0);
  return files.sort();
}

function duration(value) {
  const match = /^(\d+)(h|d)$/.exec(value);
  const hours = match && Number(match[1]) * ({ h: 1, d: 24 })[match[2]];
  if (!hours || hours > 720) throw new Error('Invalid --since duration');
  return hours * 3600000;
}

function runningNumbers(records) {
  const unique = new Map();
  for (const record of records) for (const row of record.cases ?? []) {
    // Older records used a mutable transcript digest as session identity and cannot prove independence.
    if (!row.caseKey) continue;
    if (typeof row.evidenceKey !== 'string' || typeof row.sessionKey !== 'string' ||
        typeof row.caseKey !== 'string' || typeof row.needed !== 'boolean' ||
        typeof row.jev !== 'boolean' || typeof row.openai !== 'boolean')
      throw new Error('Invalid running evidence case');
    unique.set(row.caseKey, row);
  }
  const allCases = [...unique.values()];
  // Historical cases lack proof of whether their sessionKey came from a header or a pathname.
  const cases = allCases.filter((row) => row.verifiedSession === true);
  const tally = (rows) => {
    const totals = Object.fromEntries(['jev', 'openai'].map((p) => [p, { tp: 0, fp: 0, fn: 0, tn: 0 }]));
    for (const row of rows) for (const p of ['jev', 'openai']) {
      const kind = row.needed ? (row[p] ? 'tp' : 'fn') : (row[p] ? 'fp' : 'tn');
      totals[p][kind]++;
    }
    return Object.fromEntries(Object.entries(totals).map(([name, c]) => [name, {
      ...c, n: rows.length, precision: wilson(c.tp, c.tp + c.fp), recall: wilson(c.tp, c.tp + c.fn),
    }]));
  };
  const providers = tally(allCases);
  const verifiedProviders = tally(cases);
  const sessions = new Set(cases.map((row) => row.sessionKey)).size;
  const [a, b] = [verifiedProviders.jev, verifiedProviders.openai];
  // Wilson intervals assume independent observations; do not issue a winner when sessions contain multiple labels.
  const eligible = (x) => cases.length >= 100 && sessions === cases.length && x.tp + x.fn >= 20 && x.precision && x.recall;
  const wins = (x, y) => eligible(x) && eligible(y) &&
    x.precision.lower > y.precision.upper && x.recall.lower > y.recall.upper;
  return { providers, verifiedProviders, sessions, descriptiveOnly: { cases: allCases.length - cases.length },
    clearWinner: wins(a, b) ? 'jev' : wins(b, a) ? 'openai' : null,
    rule: 'At least 100 latest cases from 100 distinct verified header-ID sessions (one label per session), 20 positive labels, and non-overlapping 95% Wilson precision and recall intervals; ID-less and legacy cases are descriptive only.' };
}

async function dualRun({ args, out, catalog, selected, source, skipped, since, injectedAskers }) {
  const take = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const acting = take('--acting', 'jev');
  if (!['jev', 'openai'].includes(acting)) throw new Error('Invalid --acting provider');
  const sampleSize = Number(take('--label-sample', '0'));
  if (!Number.isInteger(sampleSize) || sampleSize < 0) throw new Error('Invalid --label-sample');
  const askers = injectedAskers ?? { jev: createAsker('jev', await credentialOptions('jev')), openai: createAsker('openai', await credentialOptions('openai')) };
  const startedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  let folder;
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  for (let i = 0; ; i++) {
    folder = join(out, stamp + (i ? `-${i}` : ''));
    try { await mkdir(folder); break; } catch (error) { if (!['EEXIST'].includes(error.code)) throw error; }
  }
  const pairs = [];
  const failures = {};
  const unresolvedReads = [];
  const externalReads = [];
  for (const [sessionIndex, file] of selected.entries()) {
    let session;
    let transcript;
    try { transcript = await source(file); session = parseSession(transcript); } catch { skipped++; continue; }
    if (session.harness) { skipped++; continue; }
    if (file === '-' && !session.id) throw new Error('Streamed sessions require a session header id');
    const verifiedSession = Boolean(session.id);
    const sessionKey = hash(['session', session.id ?? resolve(file)]);
    const transcriptDigest = hash(transcript);
    for (const [segmentIndex, segment] of segments(session.messages, session.cwd).entries()) {
      const observations = { unresolvedReads: [], externalReads: [] };
      const answers = await Promise.allSettled(['jev', 'openai'].map((p) =>
        scoreSegment(segment, catalog, askers[p], 0.7, p === 'jev' ? observations : undefined)));
      unresolvedReads.push(...observations.unresolvedReads.map((read) => ({ index: sessionIndex, segmentIndex, ...read })));
      externalReads.push(...observations.externalReads.map((read) => ({ index: sessionIndex, segmentIndex, ...read })));
      if (answers.some((answer) => answer.status === 'rejected')) {
        for (const [i, answer] of answers.entries()) if (answer.status === 'rejected') {
          const reason = `${['jev', 'openai'][i]}: ${answer.reason.message.replace(/\d+/g, '#')}`;
          failures[reason] = (failures[reason] ?? 0) + 1;
          if (/HTTP 401|HTTP 403/.test(answer.reason.message)) throw answer.reason;
        }
        continue;
      }
      pairs.push({ sessionIndex, segmentIndex, sessionKey, verifiedSession, transcriptDigest, goal: segment.goal.slice(0, 2000),
        jev: answers[0].value, openai: answers[1].value });
    }
  }
  if (!pairs.length && Object.keys(failures).length) throw new Error('No paired segments: provider failure');
  const reports = Object.fromEntries(['jev', 'openai'].map((p) => [p, {
    schema: 'pad.skill-usage-eval.v1', provider: p, sessions: selected.length,
    segments: pairs.length, skipped, failures, threshold: 0.7,
    unresolvedReads, externalReads, ...aggregate(pairs.flatMap((pair) => pair[p]), catalog),
  }]));
  let bindingKey;
  const warnings = [];
  if (sampleSize) {
    const keyPath = join(out, 'label-binding.key');
    try { await writeFile(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    bindingKey = await readFile(keyPath, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(bindingKey)) throw new Error('Invalid private label binding key');
    if (((await stat(keyPath)).mode & 0o077) !== 0)
      warnings.push('Existing label binding key permissions exceed 0600; restrict access before sharing samples');
  }
  const sample = sampleSize ? pairs.flatMap((pair) => pair.jev.map((row, i) => ({
    id: `${pair.sessionIndex}-${pair.segmentIndex}-${i}`, goal: pair.goal,
    skill: catalog[i].name, pack: catalog[i].pack, description: catalog[i].description,
    sessionKey: pair.sessionKey, verifiedSession: pair.verifiedSession,
    caseKey: hash([pair.sessionKey, pair.segmentIndex, catalog[i].key]),
    evidenceKey: createHmac('sha256', bindingKey).update(JSON.stringify([pair.transcriptDigest,
      pair.sessionKey, pair.segmentIndex, catalog[i].key, pair.goal, catalog[i].name,
      catalog[i].pack, catalog[i].description, pair.jev[i].need, pair.openai[i].need])).digest('hex'),
  }))).filter((_, i, all) => i % Math.max(1, Math.ceil(all.length / sampleSize)) === 0).slice(0, sampleSize) : [];
  const predictions = { schema: 'pad.skill-usage-predictions.v1' };
  for (const provider of ['jev', 'openai']) {
    const rows = sample.map((entry) => {
      const [s, g, i] = entry.id.split('-').map(Number);
      const pair = pairs.find((p) => p.sessionIndex === s && p.segmentIndex === g);
      return { id: entry.id, needed: pair[provider][i].need };
    });
    predictions[provider] = { before: rows, after: rows };
  }
  let score = null;
  let labels;
  if (args.includes('--labels')) {
    labels = JSON.parse(await readFile(take('--labels'), 'utf8'));
    if (labels.cases?.length !== sample.length || labels.cases.some((row, i) =>
      row.id !== sample[i].id || row.skill !== sample[i].skill || row.pack !== sample[i].pack ||
      !sample[i].evidenceKey || row.evidenceKey !== sample[i].evidenceKey))
      throw new Error('Label evidence mismatch: sample is not the frozen labelled input');
    score = scoreHandcheck(labels, predictions);
  }
  const previous = (await readFile(join(out, 'running.jsonl'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''; throw error;
  })).trim().split('\n').filter(Boolean).map(JSON.parse);
  const counts = score ? Object.fromEntries(['jev', 'openai'].map((p) => [p, score.results[p].before])) : null;
  const cases = score ? sample.map((entry, i) => ({ evidenceKey: entry.evidenceKey,
    sessionKey: entry.sessionKey, caseKey: entry.caseKey, verifiedSession: entry.verifiedSession,
    needed: labels.cases[i].needed, jev: predictions.jev.before[i].needed,
    openai: predictions.openai.before[i].needed })) : [];
  const running = runningNumbers([...previous, { cases }]);
  const record = { schema: 'pad.skill-usage-dual.v1', startedAt, since, acting, shadow: acting === 'jev' ? 'openai' : 'jev',
    status: 'ok', output: folder, sessions: selected.length, segments: pairs.length, skipped, failures, warnings, counts, cases,
    readObservations: { unresolvedReads: unresolvedReads.length, externalReads: externalReads.length }, running };
  const save = (name, data) => writeFile(join(folder, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await save('verdict.json', reports[acting]);
  await save('shadow.json', reports[record.shadow]);
  await save('run.json', record);
  if (sampleSize) { await save('label-sample.json', { schema: 'pad.skill-usage-label-sample.v1', cases: sample });
    await save('predictions.json', predictions); }
  if (score) await save('score.json', score);
  await appendFile(join(out, 'running.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(record));
}

export async function main(args, { catalog: injectedCatalog, askers } = {}) {
  const provider = args.includes('--jev') ? 'jev' : 'openai';
  const take = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const days = Number(take('--days', '7'));
  const since = args.includes('--since') ? duration(take('--since')) : days * 86400000;
  const limit = Number(take('--limit', '0'));
  const out = resolve(take('--out', '.scratch/skill-usage/report'));
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(limit) || limit < 0 ||
      ['--since', '--out', '--days', '--limit', '--label-sample', '--labels', '--acting'].some((flag) => args.includes(flag) && !take(flag))) throw new Error('Invalid date, limit or missing argument');
  if (args.includes('--labels') && (!args.includes('--dual') || !args.includes('--label-sample'))) throw new Error('--labels requires --dual and --label-sample');
  const home = homedir();
  const roots = [['poteto', join(home, 'pi-poteto-mode/skills')],
    ['PAD', resolve(dirname(fileURLToPath(import.meta.url)), '../skills')], ['pi-user', join(home, '.pi/pi/skills')]];
  const npm = join(home, '.pi/pi/npm/node_modules');
  for (const scope of await readdir(npm).catch(() => [])) {
    if (!scope.startsWith('@')) continue;
    for (const packageName of await readdir(join(npm, scope)).catch(() => [])) {
      if (packageName === 'pi-agentic-driver') continue;
      roots.push([packageName, join(npm, scope, packageName, 'skills')]);
    }
  }
  const catalog = injectedCatalog ?? await discoverSkills(roots);
  const inputs = args.filter((arg, i) => args[i - 1] === '--sessions');
  const sessionRoots = inputs.length ? inputs : [join(home, '.pi/pi/sessions'), join(home, '.pi/agent/sessions')];
  const files = (await Promise.all(sessionRoots.map((root) => root === '-' ? ['-'] :
    sessionFiles(root, Date.now() - since)))).flat();
  const streamed = files.includes('-') ? await (async () => {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text;
  })() : null;
  const source = (file) => file === '-' ? Promise.resolve(streamed) : readFile(file, 'utf8');
  const eligible = [];
  let skipped = 0;
  for (const file of files) {
    try {
      if (parseSession(await source(file)).harness) skipped++;
      else eligible.push(file);
    } catch { skipped++; }
  }
  const selected = limit ? Array.from({ length: Math.min(limit, eligible.length) }, (_, i) =>
    eligible[Math.floor(i * eligible.length / Math.min(limit, eligible.length))]) : eligible;
  if (args.includes('--dual')) return dualRun({ args, out, catalog, selected, source, skipped, since: take('--since', `${days}d`), injectedAskers: askers });
  const asker = createAsker(provider, await credentialOptions(provider));
  const results = [];
  const detail = [];
  const failures = {};
  const unresolvedReads = [];
  const externalReads = [];
  for (const [index, file] of selected.entries()) {
    let session;
    try { session = parseSession(await source(file)); } catch { skipped++; continue; }
    if (session.harness) { skipped++; continue; }
    for (const segment of segments(session.messages, session.cwd)) {
      const observations = { unresolvedReads: [], externalReads: [] };
      try {
        const rows = await scoreSegment(segment, catalog, asker, 0.7, observations);
        results.push(...rows);
        detail.push({ index, rows, ...observations });
      } catch (error) {
        const reason = error.message.replace(/\d+/g, '#');
        failures[reason] = (failures[reason] ?? 0) + 1;
        if (/HTTP 401|HTTP 403/.test(error.message)) throw error;
      } finally {
        unresolvedReads.push(...observations.unresolvedReads.map((read) => ({ index, ...read })));
        externalReads.push(...observations.externalReads.map((read) => ({ index, ...read })));
      }
    }
  }
  const report = { schema: 'pad.skill-usage-eval.v1', provider, sessions: selected.length,
    segments: results.length / catalog.length, skipped, failures, threshold: 0.7,
    unresolvedReads, externalReads, ...aggregate(results, catalog) };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out + '.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(out + '.md', markdown(report) + '\n', { mode: 0o600 });
  if (limit) await writeFile(out + '.sample.json', JSON.stringify(detail, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ sessions: report.sessions, segments: report.segments, skipped,
    failures, skills: catalog.length, output: out }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ schema: 'pad.skill-usage-dual-error.v1', status: 'failed', error: error.message }));
    process.exitCode = 1;
  });
}
