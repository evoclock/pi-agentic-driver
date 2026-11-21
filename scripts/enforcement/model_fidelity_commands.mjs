// Evidence-only MCP adapter for the currently implemented model-fidelity CLI operations.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../model_fidelity.mjs', import.meta.url));
import { requestPayloads, schemas, validateRecord } from '../../lib/model-fidelity/records.mjs';

const operations = ['prepare', 'diagram', 'read'];
const failure = (code, message) => ({ schema: 'model-fidelity.error.v1', status: 'error', continuation: 'continue', errors: [{ code, message }], authorityCreated: false });

export const modelFidelitySchemas = Object.fromEntries(operations.map(operation => {
  const payload = requestPayloads[operation];
  return [`model-fidelity.${operation}`, { ...schemas.request,
    properties: { ...schemas.request.properties, operation: { const: operation }, payload: {
      type: 'object', required: payload.required.filter(key => key !== 'schema'),
      properties: Object.fromEntries(Object.entries(payload.properties).filter(([key]) => key !== 'schema')),
      additionalProperties: false,
      ...(operation === 'read' ? { oneOf: [{ required: ['artifactId'] }, { required: ['resultId'] }] } : {}),
    } },
  }];
}));

export function createModelFidelityCommands({ repoRoot = process.cwd() } = {}) {
  return Object.freeze(Object.fromEntries(operations.map(operation => [`model-fidelity.${operation}`, async request => {
    if (request?.operation !== operation) return failure('invalid-request', 'Operation and tool name differ');
    const checked = validateRecord('request', request);
    if (!checked.ok) return failure('invalid-request', checked.errors.join('; ').slice(0, 256));
    if (![request.requestId, request.unitId, request.attemptId].every(value => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))) return failure('invalid-request', 'Invalid ID');
    const bytes = JSON.stringify(request);
    if (Buffer.byteLength(bytes) > 256 * 1024) return failure('read-limit', 'Request exceeds CLI limit');
    try {
      const scratch = join(repoRoot, '.scratch');
      const store = join(scratch, 'model-fidelity');
      const inputs = join(store, 'mcp-inputs');
      for (const directory of [scratch, store, inputs]) {
        await mkdir(directory, { mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('Evidence directory is a symlink');
      }
      const file = join(inputs, `${randomUUID()}.json`);
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, operation, '--json', relative(repoRoot, file)],
          { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const timer = setTimeout(() => child.kill(), 120_000);
        child.stdout.on('data', chunk => { if (output.length + chunk.length > 4 * 1024 * 1024) { child.kill(); return; } output += chunk; });
        child.stderr.on('data', () => {});
        child.on('error', reject);
        child.on('close', () => { clearTimeout(timer); resolve(output); });
      });
      return JSON.parse(stdout);
    } catch {
      return failure('operational-error', 'Model-fidelity CLI did not return a valid bounded result');
    }
  }] )));
}
