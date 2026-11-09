// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
// Explicit local session inputs only. Never emit transcript lines or input paths.
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { aggregateSkillObservations, SKILL_OBSERVATION_ENTRY } from './enforcement/task_skill_observability_pi.js';

async function main(paths) {
  if (!paths.length) throw new Error('Supply explicit session JSONL paths or a directory');
  const files = [];
  for (const arg of paths) {
    const path = resolve(arg);
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) if (name.endsWith('.jsonl')) files.push(join(path, name));
    } else if (info.isFile() && path.endsWith('.jsonl')) files.push(path);
    else throw new Error('Input must be a session JSONL file or directory');
  }
  const events = [];
  for (const file of [...new Set(files)].sort()) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === 'custom' && entry.customType === SKILL_OBSERVATION_ENTRY) events.push(entry.data);
    }
  }
  process.stdout.write(`${JSON.stringify(aggregateSkillObservations(events))}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Observation report unavailable: ${error instanceof SyntaxError ? 'invalid JSONL' : error.code ?? error.message}\n`);
  process.exitCode = 1;
});
