import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(new URL('../config/owner-terms.v1.json', import.meta.url), 'utf8'));

export function lintLines(lines, rules = config.rules) {
  return lines.flatMap(item => rules.filter(rule => !rule.exclude.includes(item.path) && new RegExp(rule.pattern, 'i').test(item.text))
    .map(rule => ({ ...item, rule: rule.id, preferred: rule.preferred })));
}

export function addedLines(diff) {
  let path;
  let line = 0;
  const lines = [];
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) path = undefined;
    else if (text.startsWith('+++ b/')) path = text.slice(6);
    else if (text.startsWith('@@ ')) line = Number(text.match(/\+(\d+)/)?.[1] ?? 0);
    else if (path && text.startsWith('+')) lines.push({path, line: line++, text: text.slice(1)});
    else if (path && (text.startsWith(' ') || text === '')) line++;
  }
  return lines;
}

export function checkTerms({base = 'origin/main', cwd = process.cwd(), title = '', body = ''} = {}) {
  const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', `${base}...HEAD`, '--'], {cwd, encoding:'utf8'});
  return lintLines([...addedLines(diff), ...[title, body].flatMap((text, i) => text.split('\n').map((text, line) => ({path:i ? 'PR body' : 'PR title', line:line + 1, text})))]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
    const bodyFile = value('--body-file');
    const hits = checkTerms({base:value('--base'), title:value('--title'), body:bodyFile ? readFileSync(bodyFile, 'utf8') : ''});
    for (const hit of hits) console.error(`${hit.path}:${hit.line}: ${hit.rule}: use ${hit.preferred}`);
    console.log(`owner terms: ${hits.length} hits`);
    process.exitCode = hits.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
