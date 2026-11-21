import { readFile } from 'node:fs/promises';

export const redLineConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'model-fidelity.red-lines.v1',
  type: 'object',
  required: ['schema', 'rawDataPaths', 'keyAssetPaths'],
  properties: {
    schema: { const: 'model-fidelity.red-lines.v1' },
    rawDataPaths: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    keyAssetPaths: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  },
  additionalProperties: false,
});

const validPath = path => typeof path === 'string' && path.length > 0 &&
  !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

function pathList(paths, name) {
  if (!Array.isArray(paths) || paths.some(path => !validPath(path)) || new Set(paths).size !== paths.length) {
    throw new TypeError(`${name} must be a unique list of relative paths`);
  }
  return paths;
}

export function validateRedLineConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      config.schema !== redLineConfigSchema.title ||
      Object.keys(config).some(key => !redLineConfigSchema.properties[key])) {
    throw new TypeError('Unknown or invalid red-line configuration version');
  }
  return {
    schema: redLineConfigSchema.title,
    rawDataPaths: [...pathList(config.rawDataPaths, 'rawDataPaths')],
    keyAssetPaths: [...pathList(config.keyAssetPaths, 'keyAssetPaths')],
  };
}

export async function loadRedLineConfig(filename) {
  return validateRedLineConfig(JSON.parse(await readFile(filename, 'utf8')));
}

const evidenceFile = path => path.split('/').includes('evidence');
const scriptFile = path => /\.(?:cjs|mjs|js|py|sh|ts)$/.test(path);

// This is an action-level decision, not a model-fidelity.result.v1 record.
// The caller must record confirmation separately before adapting it into a result.
export function assessRedLines(diff, config, { confirmedScriptPaths = [] } = {}) {
  const lists = validateRedLineConfig(config);
  if (!diff || typeof diff !== 'object' || Array.isArray(diff) ||
      Object.keys(diff).some(key => !['modified', 'deleted', 'added'].includes(key))) {
    throw new TypeError('Invalid diff summary');
  }
  const modified = pathList(diff.modified, 'modified');
  const deleted = pathList(diff.deleted, 'deleted');
  const added = pathList(diff.added, 'added');
  const confirmations = pathList(confirmedScriptPaths, 'confirmedScriptPaths');
  if (confirmations.some(path => !modified.includes(path) || !scriptFile(path))) {
    throw new TypeError('Confirmation must identify a modified script');
  }
  const findings = [];
  for (const path of modified) {
    if (lists.rawDataPaths.includes(path)) findings.push({ path, redLine: 'raw-data-overwrite', confidence: 'confirmed' });
  }
  for (const path of deleted) {
    if (lists.keyAssetPaths.includes(path) || evidenceFile(path)) findings.push({ path, redLine: 'key-asset-delete', confidence: 'confirmed' });
  }
  // Diff-only history cannot prove repeated use of a script across tasks.
  for (const path of modified) {
    if (scriptFile(path) && !added.some(scriptFile)) {
      findings.push({ path, redLine: 'same-script-reedit', confidence: 'suspected' });
    }
  }
  const stoppedActions = findings.filter(finding => finding.confidence === 'confirmed' ||
    (finding.redLine === 'same-script-reedit' && confirmations.includes(finding.path)))
    .map(({ path, redLine }) => ({ path, redLine }));
  return {
    findings,
    continuation: stoppedActions.length ? 'stop-red-line' : 'continue',
    stoppedActions,
  };
}
