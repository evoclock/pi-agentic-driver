import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'pad-public-pack-'));
const fail = message => { throw new Error(`pack smoke: ${message}`); };
const unsafe = /(?:^|\/)(?:tests|fixtures|design|state-machines|review)\/|(?:^|\/)test_[^/]+\.py$|\.(?:tla|cfg|out)$/i;

function extensionFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? extensionFiles(path) :
      entry.isFile() && /\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

try {
  const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp],
    { cwd: root, encoding: 'utf8' }))[0];
  if (!pack?.filename || !Array.isArray(pack.files)) fail('npm pack did not return a file list');
  const names = new Set(pack.files.map(file => file.path));
  for (const name of names) if (unsafe.test(name)) fail(`forbidden packed path: ${name}`);
  for (const name of ['README.md', 'LICENSE', 'package.json']) {
    if (!names.has(name)) fail(`required packed path missing: ${name}`);
  }
  console.log(`Packed files: ${names.size}`);

  const consumer = join(temp, 'consumer');
  const command = spawnSync('sh', ['-c', 'command -v sfw'], { encoding: 'utf8' }).status === 0 ? 'sfw' : 'npm';
  const args = command === 'sfw' ? ['npm', 'install'] : ['install'];
  const result = spawnSync(command, [...args, '--prefix', consumer, join(temp, pack.filename), '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: temp, encoding: 'utf8', timeout: 600000 });
  if (result.error || result.status !== 0) fail(`consumer install failed: ${result.error?.message || result.stderr || result.stdout}`);
  const installed = join(consumer, 'node_modules', '@evoclock', 'pi-agentic-driver');
  if (!existsSync(installed)) fail('installed driver package missing');
  const copy = join(consumer, 'package-copy');
  cpSync(installed, copy, { recursive: true });
  const info = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
  for (const entry of info.pi?.skills || []) {
    if (!existsSync(join(copy, entry, 'SKILL.md'))) fail(`installed skill missing SKILL.md: ${entry}`);
  }
  const tools = new Set();
  const bus = new EventEmitter();
  const pi = {
    registerTool(tool) {
      if (!tool?.name || tools.has(tool.name)) fail(`duplicate or unnamed tool: ${tool?.name}`);
      tools.add(tool.name);
    },
    registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {},
    events: { emit: (...args) => bus.emit(...args), on: (...args) => bus.on(...args) },
    cwd: copy, getState: () => undefined,
  };
  const extensions = extensionFiles(join(copy, 'extensions')).sort();
  if (!extensions.length) fail('no extensions installed');
  for (const file of extensions) {
    const module = await import(pathToFileURL(file).href);
    if (typeof module.default !== 'function') fail(`extension has no default export: ${file}`);
    await module.default(pi);
  }
  if (!tools.size) fail('no tools registered');
  for (const name of ['agentic_herdr_communication', 'agentic_herdr_spawn_worker']) {
    if (!tools.has(name)) fail(`required tool missing: ${name}`);
  }
  console.log(`Registered tools: ${[...tools].sort().join(', ')}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
