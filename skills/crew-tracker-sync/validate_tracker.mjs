// SPDX-License-Identifier: AGPL-3.0-only
// Validate a tracker against its observed PR and agent input; never publish.
import { readFileSync } from 'node:fs';

export function validateTracker(data, source) {
  const errors = [];
  for (const field of ['streams', 'merges', 'decisions', 'steps', 'settled']) {
    if (!Array.isArray(data?.[field])) errors.push(`${field}: expected array`);
  }
  if (errors.length) return errors;
  for (const [index, row] of data.merges.entries()) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(x => typeof x === 'string') ||
        !/^(draft \(.+\)|ready|merged .+|closed .+|blocked .+)$/.test(row[3])) errors.push(`merges[${index}]: invalid schema row`);
  }
  for (const [index, row] of data.streams.entries()) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(x => typeof x === 'string' && x.trim())) errors.push(`streams[${index}]: invalid schema row`);
  }
  for (const [index, row] of data.steps.entries()) {
    if (typeof row?.text !== 'string' || typeof row?.meta !== 'string' || typeof row?.done !== 'boolean') errors.push(`steps[${index}]: invalid schema row`);
  }
  for (const [index, row] of data.decisions.entries()) {
    if (!['open', 'settled'].includes(row?.state) || typeof row?.text !== 'string') errors.push(`decisions[${index}]: invalid schema row`);
  }
  for (const [index, row] of data.settled.entries()) {
    if (!['title', 'detail', 'meta'].every(key => typeof row?.[key] === 'string')) errors.push(`settled[${index}]: invalid schema row`);
  }
  for (const pr of source.prs ?? []) {
    if (!['draft', 'ready'].includes(pr.state)) continue;
    const rows = data.merges.filter(row => row[0] === pr.title && row[1] === pr.repo);
    if (rows.length !== 1) errors.push(`${pr.repo}: ${pr.title} needs exactly one open PR row`);
    if (pr.state === 'draft' && rows.length === 1 && !/^draft \(.+\)$/.test(rows[0][3])) errors.push(`${pr.title}: draft needs age`);
    if (pr.state === 'draft' && data.steps.some(step => !step.done && step.text.toLowerCase().includes(pr.title.toLowerCase()))) errors.push(`${pr.title}: draft must not appear on Your steps`);
  }
  for (const agent of source.agents ?? []) {
    const rows = data.streams.filter(row => row[0] === agent);
    if (rows.length !== 1) errors.push(`${agent}: needs exactly one stream with current work and time`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const [data, source] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')));
    const errors = validateTracker(data, source);
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  } catch (error) { console.error(String(error)); process.exitCode = 2; }
}
