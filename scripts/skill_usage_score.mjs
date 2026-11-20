// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
export function wilson(successes, trials) {
  if (!trials) return null;
  const z = 1.959963984540054;
  const p = successes / trials;
  const z2 = z * z;
  const center = (p + z2 / (2 * trials)) / (1 + z2 / trials);
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / (1 + z2 / trials);
  return { estimate: p, lower: center - radius, upper: center + radius, n: trials };
}

export function scoreHandcheck(labels, predictions) {
  if (labels.schema !== 'pad.skill-usage-labels.v1' || !Array.isArray(labels.cases) || !labels.rubric ||
      predictions.schema !== 'pad.skill-usage-predictions.v1') throw new Error('Invalid handcheck schema');
  const ids = new Set();
  for (const row of labels.cases) {
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.needed !== 'boolean' ||
        typeof row.skill !== 'string' || typeof row.pack !== 'string') throw new Error('Invalid or duplicate label');
    ids.add(row.id);
  }
  const results = {};
  for (const provider of ['openai', 'jev']) {
    results[provider] = {};
    for (const phase of ['before', 'after']) {
      const rows = predictions[provider]?.[phase];
      if (!Array.isArray(rows) || rows.length !== ids.size) throw new Error(`Incomplete ${provider}/${phase} predictions`);
      const byId = new Map();
      for (const row of rows) {
        if (!ids.has(row.id) || byId.has(row.id) || typeof row.needed !== 'boolean') {
          throw new Error(`Invalid ${provider}/${phase} prediction`);
        }
        byId.set(row.id, row.needed);
      }
      let tp = 0; let fp = 0; let fn = 0; let tn = 0;
      for (const row of labels.cases) {
        const predicted = byId.get(row.id);
        if (predicted === undefined) throw new Error(`Missing prediction ${row.id}`);
        if (row.needed && predicted) tp++;
        else if (!row.needed && predicted) fp++;
        else if (row.needed) fn++;
        else tn++;
      }
      results[provider][phase] = { tp, fp, fn, tn,
        precision: wilson(tp, tp + fp), recall: wilson(tp, tp + fn) };
    }
  }
  return { schema: 'pad.skill-usage-handcheck-score.v1', n: ids.size, results };
}
