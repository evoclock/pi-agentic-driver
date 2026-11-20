// Read the public tool surface from actual packaged extension entry points.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '..');
export const packageInfo = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
export const packedFiles = new Set(JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }))[0].files.map(f => f.path));
export async function registeredContract() {
  const tools = new Map();
  const commands = new Set();
  const pi = { registerTool: tool => tools.set(tool.name, tool), registerCommand: (name) => commands.add(name),
    registerShortcut() {}, on() {}, appendEntry() {}, cwd: root, getState: () => undefined };
  const dirs = packageInfo.pi.extensions;
  const files = dirs.flatMap(entry => entry.endsWith('/') || entry === './extensions' ?
    [...packedFiles].filter(f => f.startsWith(entry.replace(/^\.\//, '') + '/') && /\.(?:ts|js)$/.test(f) && !f.includes('/fixtures/')) :
    [entry.replace(/^\.\//, '')]);
  for (const file of files.sort()) {
    const mod = await import(pathToFileURL(resolve(root, file)).href);
    if (typeof mod.default === 'function') await mod.default(pi);
  }
  return { tools, commands };
}
