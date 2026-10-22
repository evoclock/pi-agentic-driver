// SPDX-License-Identifier: Apache-2.0
// Public-facing content scanner; license and prior-art credit are recorded privately.
// Scan declared public-facing files; optional private terms stay outside Git.
import { readFileSync } from 'node:fs';
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

function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.files) || !config.files.every((name) => typeof name === 'string')) {
    throw new Error('public-scan.json must declare a files array');
  }
  const terms = [...parseTerms(JSON.stringify(config.terms)), ...parseTerms(process.env.PUBLIC_SCAN_TERMS || '[]')];
  let failures = 0;
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
