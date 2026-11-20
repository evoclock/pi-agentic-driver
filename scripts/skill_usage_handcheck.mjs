// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
export { wilson, scoreHandcheck } from './skill_usage_score.mjs';
import { scoreHandcheck } from './skill_usage_score.mjs';

if (process.argv[1]?.endsWith('/skill_usage_handcheck.mjs')) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--labels' || args[2] !== '--predictions') {
    console.error('Usage: node scripts/skill_usage_handcheck.mjs --labels FILE --predictions FILE');
    process.exitCode = 2;
  } else {
    try {
      const labels = JSON.parse(await readFile(args[1], 'utf8'));
      const predictions = JSON.parse(await readFile(args[3], 'utf8'));
      console.log(JSON.stringify(scoreHandcheck(labels, predictions)));
    } catch (error) {
      console.error(`Handcheck unavailable: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
