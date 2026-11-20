// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export function parseSession(text) {
  const lines = text.split('\n').filter(Boolean);
  const records = lines.map((line) => JSON.parse(line));
  if (records[0]?.type !== 'session') throw new Error('Missing session header');
  const messages = records.filter((row) => row.type === 'message').map((row) => row.message);
  if (messages.some((m) => !m || typeof m.role !== 'string')) throw new Error('Malformed message');
  const user = messages.filter((m) => m.role === 'user').map((m) => textOf(m)).join(' ');
  const harness = /(?:--no-skills|skill-proof|pad-skill-usage-brief|You keep the skills of the agent)/i.test(user) ||
    /(?:Pi coordinator only|Read-only\. ONLY agentic_herdr_communication|ONLY agentic_herdr_communication)/i.test(user) ||
    /Continue this External bot conversation\./.test(user) ||
    /^(?:Pi coordinator\.|ONLY agentic_herdr_communication|Read-only Pi coordinator\.|You are the Pi coordinator|You keep the long-term memory)/i.test(user.trim()) ||
    (/\bpi\s+-p\b/.test(user) && /coordinator/i.test(user));
  const cwd = typeof records[0].cwd === 'string' && isAbsolute(records[0].cwd) ? records[0].cwd : null;
  const id = typeof records[0].id === 'string' && records[0].id.trim() ? records[0].id : null;
  return { messages, harness, cwd, id };
}

export function textOf(message) {
  const text = typeof message.content === 'string' ? message.content :
    (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  return message.role === 'user' ? text.replace(/<external_bot_saved_memories>[\s\S]*?<\/external_bot_saved_memories>/g, '') : text;
}

export function segments(messages, cwd) {
  const result = [];
  let current;
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user' && textOf(message).trim() &&
      !message.content?.some?.((part) => part.type === 'tool_result')) {
      current = { goal: textOf(message), messages: [], cwd };
      result.push(current);
    }
    if (current) current.messages.push(message);
  }
  return result;
}

export function loadedSkills(messages, catalog, cwd, observations = { unresolvedReads: [], externalReads: [] }) {
  const loaded = new Set();
  const pending = new Map();
  const catalogPaths = catalog.map((skill) => {
    try { return realpathSync(skill.path); } catch { return null; }
  });
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.content ?? []) {
        if (call.type !== 'toolCall') continue;
        const path = call.arguments?.path;
        if (call.name === 'read' && typeof path === 'string' && (isAbsolute(path) || cwd)) {
          pending.set(call.id, isAbsolute(path) ? path : `${cwd}/${path}`);
        }
      }
    }
    if (message.role !== 'toolResult' || message.isError || !pending.has(message.toolCallId) || !textOf(message).trim()) continue;
    const target = pending.get(message.toolCallId);
    pending.delete(message.toolCallId);
    let realPath;
    try { realPath = realpathSync.native(target); }
    catch (error) { observations.unresolvedReads.push({ path: target, reason: error.code ?? 'UNKNOWN' }); }
    if (realPath && cwd && realPath !== resolve(target)) {
      const fromCwd = relative(cwd, realPath);
      if (fromCwd === '..' || fromCwd.startsWith('../') || isAbsolute(fromCwd)) {
        observations.externalReads.push({ path: target, realPath });
      }
    }
    for (const [i, skill] of catalog.entries()) {
      if (realPath ? realPath === catalogPaths[i] : resolve(target) === resolve(skill.path)) loaded.add(skill.key);
    }
  }
  return loaded;
}

export function fitState(segment, { maxChars = 26000 } = {}) {
  const entries = segment.messages.map((message) => {
    const content = message.role === 'toolResult' ? `[tool result ${textOf(message).length} chars omitted]` :
      message.role === 'assistant' ? (message.content ?? []).map((part) => part.type === 'toolCall'
        ? `[tool ${part.name} ${JSON.stringify(part.arguments ?? {}).slice(0, 500)}]` :
        part.type === 'text' ? part.text ?? '' : '').join(' ') : textOf(message);
    return { role: message.role, text: content };
  });
  const size = () => JSON.stringify(entries).length;
  if (size() > maxChars) {
    for (let i = 1; i < entries.length - 6 && size() > maxChars; i++) {
      if (entries[i].text.length > 200) entries[i].text = entries[i].text.slice(0, 200) + ' [truncated]';
    }
  }
  if (size() > maxChars) {
    for (let i = 1; i < entries.length - 6 && size() > maxChars; i++) {
      if (entries[i].role !== 'user') entries[i].text = '[older turn omitted]';
    }
  }
  if (size() > maxChars) throw new Error('Session segment cannot fit state budget');
  return JSON.stringify({ goal: segment.goal.slice(0, 2000), history: entries });
}

// Focused description reader, not a general YAML parser.
function skillDescription(source) {
  const frontmatter = source.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
  const lines = frontmatter.split('\n');
  const index = lines.findIndex(line => /^description:/.test(line));
  if (index < 0) return '';
  const value = lines[index].slice('description:'.length).trim();
  const block = value.match(/^([>|])([-+]?)(?:[ \t]+#.*)?$/);
  if (!block) return value.replace(/^("|')(.*)\1$/, '$2');
  const content = [];
  let indent;
  for (const line of lines.slice(index + 1)) {
    if (line.trim()) {
      const spaces = line.match(/^ */)[0].length;
      if (indent === undefined) indent = spaces;
      if (!spaces || spaces < indent) break;
    }
    content.push(line.trim() ? line.slice(indent) : '');
  }
  let text = '';
  for (let i = 0; i < content.length; i++) {
    const current = content[i];
    const next = content[i + 1];
    text += current;
    if (block[1] === '>' && current && next && !/^ /.test(current) && !/^ /.test(next)) text += ' ';
    else if (block[1] === '>' && !current && next && i > 0 && content[i - 1]) continue;
    else text += '\n';
  }
  if (block[2] === '+') return text;
  return text.replace(/\n+$/, '') + (block[2] !== '-' && content.some(line => line) ? '\n' : '');
}

export async function discoverSkills(roots) {
  const catalog = [];
  for (const [pack, root] of roots) {
    let names;
    try { names = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = resolve(root, entry.name, 'SKILL.md');
      let source;
      try { source = await readFile(path, 'utf8'); } catch { continue; }
      const description = skillDescription(source);
      catalog.push({ key: `${pack}/${entry.name}`, pack, name: entry.name,
        path, description: description.slice(0, 500), procedure: source.replace(/^---[\s\S]*?---/, '').slice(0, 1200) });
    }
  }
  return catalog;
}

export function questionsFor(catalog, loaded, goal) {
  return catalog.flatMap((skill, i) => [
    { name: `n${i}`, type: 'predicate', instructions: `Evidence: ${goal}\nQuestion: Should the agent load ${skill.name} for this specific task? Skill purpose: ${skill.description}. Answer yes only if relevant to this task; a named skill alone does not imply usage.` },
    ...(loaded.has(skill.key) ? [{ name: `f${i}`, type: 'predicate', instructions: `Is there clear evidence the agent failed a required step of ${skill.name}? Do not count a lack of visible evidence as a violation. Relevant procedure excerpt: ${skill.procedure ?? skill.description}` }] : []),
  ]);
}

export async function scoreSegment(segment, catalog, asker, threshold = 0.7, observations) {
  const loaded = loadedSkills(segment.messages, catalog, segment.cwd, observations);
  const state = fitState(segment);
  const questions = questionsFor(catalog, loaded, JSON.parse(state).goal);
  const probabilities = new Map();
  for (let i = 0; i < questions.length; i += 100) {
    const batch = questions.slice(i, i + 100);
    const answers = await asker.ask(state, batch);
    for (const q of batch) {
      const probability = answers.get(q.name);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`Invalid answer ${q.name}`);
      probabilities.set(q.name, probability);
    }
  }
  return catalog.map((skill, i) => {
    const need = probabilities.get(`n${i}`) >= threshold;
    const wasLoaded = loaded.has(skill.key);
    return { key: skill.key, pack: skill.pack, need, loaded: wasLoaded,
      followed: wasLoaded ? probabilities.get(`f${i}`) < threshold : null };
  });
}

export function aggregate(rows, catalog) {
  const skills = catalog.map((skill) => {
    const hits = rows.filter((row) => row.key === skill.key);
    return { skill: skill.name, pack: skill.pack,
      loadedWhenNeeded: hits.filter((r) => r.need && r.loaded).length,
      missedWhenNeeded: hits.filter((r) => r.need && !r.loaded).length,
      loadedNotFollowed: hits.filter((r) => r.loaded && !r.followed).length };
  });
  const packs = [...new Set(catalog.map((s) => s.pack))].map((pack) => ({ pack,
    loadedWhenNeeded: skills.filter((s) => s.pack === pack).reduce((n, s) => n + s.loadedWhenNeeded, 0),
    missedWhenNeeded: skills.filter((s) => s.pack === pack).reduce((n, s) => n + s.missedWhenNeeded, 0),
    loadedNotFollowed: skills.filter((s) => s.pack === pack).reduce((n, s) => n + s.loadedNotFollowed, 0) }));
  return { skills, packs };
}

export function markdown(report) {
  return [`Unresolved reads: ${report.unresolvedReads?.length ?? 0}. External linked reads: ${report.externalReads?.length ?? 0}.`,
    '', '| Pack | Skill | Loaded when needed | Missed when needed | Loaded not followed |',
    '| --- | --- | ---: | ---: | ---: |',
    ...report.skills.map((r) => `| ${r.pack} | ${r.skill} | ${r.loadedWhenNeeded} | ${r.missedWhenNeeded} | ${r.loadedNotFollowed} |`),
    '', '| Pack | Loaded when needed | Missed when needed | Loaded not followed |',
    '| --- | ---: | ---: | ---: |',
    ...report.packs.map((r) => `| ${r.pack} | ${r.loadedWhenNeeded} | ${r.missedWhenNeeded} | ${r.loadedNotFollowed} |`)].join('\n');
}
