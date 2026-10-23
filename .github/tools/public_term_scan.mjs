// SPDX-License-Identifier: Apache-2.0
// Public-facing content scanner; license and prior-art credit are recorded privately.
// Scan declared public-facing files; optional private terms stay outside Git.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configPath = resolve(root, '.github/public-scan.json');

export function parseTerms(value) {
  const terms = JSON.parse(value);
  if (!Array.isArray(terms) || !terms.every((term) => typeof term === 'string' && term.trim())) {
    throw new Error('scan terms must be a JSON array of nonempty strings');
  }
  return terms;
}

export function scanText(text, terms) {
  const found = [];
  if (/(?:\/Users\/|\/home\/)[^\s/]+|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/i.test(text)) {
    found.push('personal path or credential-shaped text');
  }
  for (const term of terms) {
    if (text.toLowerCase().includes(term.toLowerCase())) found.push('configured public term');
  }
  return found;
}

export function conflictLines(text, markdown = false) {
  let fenced = false;
  const hits = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (markdown && /^\s*(`{3,}|~{3,})/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && (/^<<<<<<< /.test(line) || line === '=======' || /^>>>>>>> /.test(line))) hits.push(index + 1);
  }
  return hits;
}

function main() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  let failures = 0;
  for (const name of tracked) {
    const bytes = readFileSync(resolve(root, name));
    if (bytes.includes(0)) continue;
    const hits = conflictLines(bytes.toString('utf8'), /\.md(?:own)?$/i.test(name));
    if (hits.length) { console.error(`${name}: conflict markers at lines ${hits.join(', ')}`); failures++; }
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.files) || !config.files.every((name) => typeof name === 'string')) {
    throw new Error('public-scan.json must declare a files array');
  }
  const terms = [...parseTerms(JSON.stringify(config.terms)), ...parseTerms(process.env.PUBLIC_SCAN_TERMS || '[]')];
  for (const name of config.files) {
    const path = resolve(root, name);
    if (isAbsolute(name) || relative(root, path).startsWith('..')) throw new Error('scan path must stay inside the repository');
    const hits = scanText(readFileSync(path, 'utf8'), terms);
    if (hits.length) {
      console.error(`${name}: ${hits.join(', ')}`);
      failures++;
    }
  }
  console.log(`Public scan: ${config.files.length} files, ${failures} findings`);
  return failures ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
