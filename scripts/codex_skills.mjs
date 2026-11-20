#!/usr/bin/env node
// Export local pack instructions as Codex-discoverable skills. No network or package installation.
import { readdir, readFile, lstat, mkdir, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = homedir();
const PACKS = Object.freeze({
  'poteto-mode': path.join(HOME, 'repos/pi-poteto-mode-agents/skills'),
  'agent-skill-vault': path.join(HOME, 'repos/agent-skill-vault-agents/skills'),
  statechart: path.join(HOME, 'repos/pi-poteto-mode-agents/skills/statechart-pi'),
  bowerbird: path.join(HOME, 'repos/pi-bowerbird/skills/bowerbird'),
});

async function safeStat(file) {
  try { return await lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertDirectoryChain(file, home) {
  if (file !== home) {
    if (path.dirname(file) === file || !file.startsWith(`${home}${path.sep}`)) throw new Error(`Outside Codex home: ${file}`);
    await assertDirectoryChain(path.dirname(file), home);
  }
  const stat = await safeStat(file);
  if (stat && !stat.isDirectory()) throw new Error(`Not a plain directory: ${file}`);
}

function frontmatter(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) throw new Error(`Missing YAML frontmatter: ${file}`);
  const name = /^name:\s*([a-z0-9-]+)\s*$/m.exec(match[1])?.[1];
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1];
  if (!name || !description) throw new Error(`Missing name/description: ${file}`);
  if (`pad-${name}`.length > 64) throw new Error(`Codex skill name too long: ${name}`);
  const setting = /^disable-model-invocation:\s*([^\r\n]*)$/m.exec(match[1]);
  const value = setting?.[1].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, double, single) => double ?? single);
  // YAML 1.2 core booleans are true/false with case variants. Also honor their
  // quoted spellings as opt-out intent; reject YAML 1.1 yes/on rather than guess.
  if (setting && !/^(?:true|false)$/i.test(value)) throw new Error(`Invalid disable-model-invocation: ${file}`);
  return { name, description, optOut: value?.toLowerCase() === 'true' };
}

function wrapper(name, description, source, pack) {
  const cli = pack === 'bowerbird'
    ? `\nRun Bowerbird as a CLI: \`node ${path.join(HOME, 'repos/pi-bowerbird/bin/bowerbird.mjs')} <action> <file>\` (or the installed \`bowerbird\` npm bin). Use \`--help\` for exact arguments. Do not assume a Pi bowerbird tool exists.\n`
    : `\nFor Treehouse operations use \`${path.join(HOME, '.local/bin/treehouse')}\` as a CLI, not a Pi tool.\n`;
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name} (local pack bridge)\n\nRead the source skill at \`${source}\` and its linked references before use. The source pack must remain installed at this location; this file does not vendor it. Pi-only tools and prompts are not Codex capabilities; follow the target repository's authority rules. If a step needs a Pi tool (including Herdr spawn or communication), mark the step blocked. Never substitute raw \`herdr\` CLI, send-keys, or a cloud agent.${cli}`;
}

async function atomicWrite(dest, desired) {
  const temporary = `${dest}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, desired, { flag: 'wx' });
    await rename(temporary, dest);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function exportCodexSkills({ codexHome, packs = Object.keys(PACKS), apply = false, sources = PACKS, beforeWrite } = {}) {
  if (!codexHome || !path.isAbsolute(codexHome)) throw new Error('Provide an absolute --codex-home (never inferred from your login)');
  if (codexHome.split(path.sep).includes('..') || codexHome.split(path.sep).includes('.')) throw new Error('Path escape or non-canonical --codex-home');
  codexHome = path.resolve(codexHome); // normalize repeated and trailing separators before comparing paths
  if (!Array.isArray(packs) || !packs.length || packs.some(p => !Object.hasOwn(PACKS, p))) throw new Error('Unknown or empty pack selection');
  const skillsDir = path.join(codexHome, 'skills');
  await assertDirectoryChain(skillsDir, codexHome);
  const planned = new Map();
  const seen = new Map();
  for (const pack of new Set(packs)) {
    const root = sources[pack];
    if (!root) throw new Error(`Missing source: ${pack}`);
    const dirs = pack === 'poteto-mode' || pack === 'agent-skill-vault'
      ? (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
      : [''];
    let found = 0;
    for (const dir of dirs) {
      const file = path.resolve(root, dir, 'SKILL.md');
      const sourceStat = await safeStat(file);
      if (!sourceStat) { if (dir) continue; throw new Error(`Source skill not installed: ${file}`); }
      if (!sourceStat.isFile()) throw new Error(`Not a plain source skill file: ${file}`);
      found++;
      const text = await readFile(file, 'utf8');
      const { name, description, optOut } = frontmatter(text, file);
      if (dir && name !== dir) throw new Error(`Skill directory/name mismatch: ${file}`);
      const destDir = path.join(skillsDir, `pad-${name}`);
      const original = seen.get(destDir);
      if (original) {
        if (original !== file) throw new Error(`Duplicate skill name: ${name} (${original}, ${file})`);
        continue;
      }
      seen.set(destDir, file);
      await assertDirectoryChain(destDir, codexHome);
      const files = [[path.join(destDir, 'SKILL.md'), wrapper(`pad-${name}`, description, file, pack)]];
      if (optOut) files.push([path.join(destDir, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n']);
      for (const [dest, desired] of files) {
        await assertDirectoryChain(path.dirname(dest), codexHome);
        const prior = await safeStat(dest);
        if (prior && !prior.isFile()) throw new Error(`Not a plain skill file: ${dest}`);
        if (!prior || await readFile(dest, 'utf8') !== desired) planned.set(dest, { dest, desired });
      }
    }
    if (!found) throw new Error(`No installed skills for pack: ${pack}`);
  }
  const completed = [];
  for (const { dest, desired } of planned.values()) {
    const result = { path: dest, action: 'create' };
    if (apply) {
      try {
        await assertDirectoryChain(path.dirname(dest), codexHome);
        const current = await safeStat(dest);
        if (current && !current.isFile()) throw new Error(`Not a plain skill file: ${dest}`);
        await mkdir(path.dirname(dest), { recursive: true });
        if (beforeWrite) await beforeWrite(dest);
        if (current) {
          result.backupPath = `${dest}.bak-${randomUUID()}`;
          await copyFile(dest, result.backupPath, constants.COPYFILE_EXCL);
          result.action = 'backup-and-update';
        }
        await atomicWrite(dest, desired);
      } catch (error) {
        error.report = { mode: 'apply', completed, failed: { path: dest, error: error.message, ...(result.backupPath && { backupPath: result.backupPath }) } };
        throw error;
      }
    } else if (await safeStat(dest)) result.action = 'backup-and-update';
    completed.push(result);
  }
  return completed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
    const allowed = new Set(['--codex-home', '--pack', '--apply', '--help']);
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
      if (args[i] === '--pack' || args[i] === '--codex-home') { if (!args[++i] || args[i].startsWith('--')) throw new Error('Missing argument value'); }
    }
    if (args.includes('--help')) {
      console.log('Usage: node scripts/codex_skills.mjs --codex-home ABSOLUTE_PATH [--pack poteto-mode|agent-skill-vault|statechart|bowerbird] [--apply]\nDry-run by default. No login/config/auth files touched.');
    } else {
      const pack = value('--pack');
      const apply = args.includes('--apply');
      const actions = await exportCodexSkills({ codexHome: value('--codex-home'), packs: pack ? [pack] : undefined, apply });
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', count: actions.length, actions }, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify(error.report ?? { error: error.message }));
    process.exitCode = 1;
  }
}
