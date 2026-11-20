#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
const fields = ['actionId', 'mechanism', 'schedule'];

export function evaluate(input) {
  if (input.schema !== 'model-fidelity.eval.v1' || !Array.isArray(input.cases) || !Array.isArray(input.attempts)) throw new Error('Invalid evaluation input');
  const cases = new Map();
  for (const item of input.cases) {
    if (!validId(item.id) || cases.has(item.id) || !['expected-unreviewed', 'reviewed'].includes(item.reviewStatus)) throw new Error('Invalid or duplicate case');
    if (!fields.every(key => key in item.expected) || !Array.isArray(item.expected.schedule)) throw new Error('Incomplete expected answer');
    if (item.reviewStatus === 'reviewed' && !(item.review?.independent === true && typeof item.review?.artifactDigest === 'string' && /^[a-f0-9]{64}$/.test(item.review.artifactDigest) && item.review.reviewer && item.review.reviewer !== input.author)) throw new Error('Reviewed answer needs independently bound provenance');
    cases.set(item.id, item);
  }
  const seen = new Set();
  const attempts = input.attempts.map(attempt => {
    const key = `${attempt.caseId}/${attempt.arm}`;
    if (!cases.has(attempt.caseId) || !['method-loaded', 'control'].includes(attempt.arm) || seen.has(key) || !['recorded', 'unavailable', 'interrupted'].includes(attempt.status)) throw new Error('Invalid or duplicate attempt');
    seen.add(key);
    if (attempt.status === 'recorded' && (!attempt.response || !fields.every(field => field in attempt.response) || !Array.isArray(attempt.response.schedule) || !attempt.provenance)) throw new Error('Recorded attempt requires response and provenance');
    const expected = cases.get(attempt.caseId);
    const eligible = expected.reviewStatus === 'reviewed' && attempt.status === 'recorded';
    const matches = eligible ? Object.fromEntries(fields.map(field => [field, JSON.stringify(attempt.response[field]) === JSON.stringify(expected.expected[field])])) : null;
    return { ...attempt, scoring: eligible ? matches : null, exclusion: eligible ? null : expected.reviewStatus !== 'reviewed' ? 'expected-unreviewed' : attempt.status };
  });
  const arms = Object.fromEntries(['method-loaded', 'control'].map(arm => {
    const records = attempts.filter(a => a.arm === arm);
    const scored = records.filter(a => a.scoring);
    return [arm, { attempts: records.length, unavailable: records.filter(a => a.status === 'unavailable').length,
      interrupted: records.filter(a => a.status === 'interrupted').length, unreviewed: records.filter(a => a.exclusion === 'expected-unreviewed').length,
      scored: scored.length, correct: Object.fromEntries(fields.map(field => [field, scored.filter(a => a.scoring[field]).length])),
      missedFindings: scored.filter(a => a.response.finding === false && cases.get(a.caseId).expected.finding === true).map(a => a.caseId),
      falseAlarms: scored.filter(a => a.response.finding === true && cases.get(a.caseId).expected.finding === false).map(a => a.caseId) }];
  }));
  return { schema: 'model-fidelity.eval-result.v1', caseCount: cases.size, reviewedCases: [...cases.values()].filter(c => c.reviewStatus === 'reviewed').length,
    arms, attempts, interpretation: 'Advisory only. Unreviewed answers and unavailable attempts are excluded from scoring; zero scored is not zero errors.' };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: model_fidelity_eval.mjs INPUT.json');
    const bytes = await readFile(process.argv[2]);
    process.stdout.write(`${JSON.stringify({ inputSha256: digest(bytes), ...evaluate(JSON.parse(bytes)) }, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
