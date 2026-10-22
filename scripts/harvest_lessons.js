// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only

// Deterministic, read-only evidence collector for harvest-lessons.
// Sources: PR review comments and CHANGES_REQUESTED reviews (gh api), revert,
// fixup and force-fix commits (git log), failed CI runs (gh api), and user
// messages in session logs (Pi sessions, Herdr logs, chat exports) that match
// correction patterns. Records already in the ledger are dropped, so a rerun
// only returns new evidence. Nothing here writes a file or calls a model.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_CONFIG = Object.freeze({
  since: "1970-01-01",
  until: null,
  gitDir: ".",
  maxPrs: 100,
  maxRuns: 100,
  sessionGlobs: [`${process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi", "agent")}/sessions/**/*.jsonl`],
  correctionPatterns: [
    "not what i asked", "\\bi said\\b", "why did you", "you should have", "i already told you",
    "that's wrong", "\\bagain\\?", "^no[,.]", "don't do that", "frustrating", "you missed", "you don't seem to",
  ],
  commitPatterns: ["^revert", "^fixup!", "^squash!", "\\bfix(?:es|ed)? (?:the )?(?:previous|last) commit\\b", "\\bforce[- ]?(?:fix|push)\\b"],
  ledger: "docs/lessons-ledger.json",
});

const SOURCES = ["github", "git", "sessions"];

export function makeRecord(source, ref, date, text, url = "") {
  const clean = String(text).split(/\s+/).filter(Boolean).join(" ").slice(0, 500);
  const id = createHash("sha256").update(`${source}|${ref}|${clean}`).digest("hex").slice(0, 16);
  return { id, source, ref, date, text: clean, url };
}

function parsePages(out) {
  const items = [];
  const text = out.trim();
  let depth = 0, start = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "]" || ch === "}") {
      if (--depth === 0) {
        const page = JSON.parse(text.slice(start, i + 1));
        items.push(...(Array.isArray(page) ? page : [page]));
      }
    }
  }
  return items;
}

function ghPages(run, path) {
  return parsePages(run("gh", ["api", "--paginate", path]));
}

export function fromGithub(cfg, run) {
  const { repo, since } = cfg;
  const found = [];
  for (const pr of ghPages(run, `repos/${repo}/pulls?state=all&per_page=100`).slice(0, cfg.maxPrs)) {
    const n = pr.number;
    for (const c of ghPages(run, `repos/${repo}/pulls/${n}/comments?per_page=100`)) {
      const when = c.created_at?.slice(0, 10) ?? "";
      if (!when || when >= since) found.push(makeRecord("pr_review_comment", `#${n}:${c.path ?? ""}`, when, c.body, c.html_url));
    }
    for (const r of ghPages(run, `repos/${repo}/pulls/${n}/reviews?per_page=100`)) {
      const when = (r.submitted_at ?? "").slice(0, 10);
      if (r.state === "CHANGES_REQUESTED" && (!when || when >= since)) found.push(makeRecord("pr_changes_requested", `#${n}`, when, r.body ?? "", r.html_url));
    }
  }
  const runs = ghPages(run, `repos/${repo}/actions/runs?status=failure&per_page=100`).flatMap((page) => page.workflow_runs ?? [page]);
  for (const ci of runs.slice(0, cfg.maxRuns)) {
    if (ci.created_at.slice(0, 10) >= since) {
      found.push(makeRecord("ci_failure", `${ci.name}@${ci.head_sha.slice(0, 7)}`, ci.created_at.slice(0, 10), `${ci.name} failed on ${ci.head_branch}`, ci.html_url));
    }
  }
  return found;
}

export function fromGit(cfg, run) {
  const out = run("git", ["-C", cfg.gitDir, "log", `--since=${cfg.since}`, "--format=%H%x1f%ad%x1f%s%x1e", "--date=short"]);
  const patterns = cfg.commitPatterns.map((p) => new RegExp(p, "i"));
  return out.split("\x1e").map((e) => e.trim()).filter(Boolean).flatMap((entry) => {
    const [sha, date, ...rest] = entry.split("\x1f");
    if (!sha || !date || !rest.length) return [];
    const subject = rest.join("\x1f");
    return patterns.some((p) => p.test(subject)) ? [makeRecord("commit", sha.slice(0, 12), date, subject)] : [];
  });
}

export function userText(line) {
  let message;
  try { message = JSON.parse(line); } catch { return line; }
  if (message === null || typeof message !== "object") return null;
  message = message.message ?? message;
  if (message.role !== undefined && message.role !== "user") return null;
  let content = message.content ?? message.text ?? "";
  if (Array.isArray(content)) content = content.filter((p) => p && typeof p === "object").map((p) => p.text ?? "").join(" ");
  return typeof content === "string" ? content : null;
}

const expand = (p) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);
// Cite session files as ~/... so records carry no user or machine path.
const cite = (p) => (p.startsWith(`${homedir()}/`) ? `~/${p.slice(homedir().length + 1)}` : p);

export function fromSessions(cfg) {
  const patterns = cfg.correctionPatterns.map((p) => new RegExp(p, "im"));
  const found = [];
  for (const pattern of cfg.sessionGlobs) {
    for (const path of globSync(expand(pattern)).sort()) {
      const mdate = statSync(path).mtime.toISOString().slice(0, 10);
      if (mdate < cfg.since) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        if (!line.trim()) return;
        const text = userText(line);
        if (text && patterns.some((p) => p.test(text))) found.push(makeRecord("session", `${cite(path)}:${index + 1}`, mdate, text));
      });
    }
  }
  return found;
}

const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

export function collect(userConfig, { run = defaultRun, skip = [] } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  if (cfg.until !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.until) || cfg.until < cfg.since)) {
    throw new Error("until must be a YYYY-MM-DD date on or after since");
  }
  const ledgerPath = cfg.ledger ? resolve(expand(cfg.ledger)) : "";
  const seen = new Set(ledgerPath && existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")).evidence_ids ?? [] : []);
  const collectors = { github: (c) => (c.repo ? fromGithub(c, run) : []), git: (c) => fromGit(c, run), sessions: fromSessions };
  const byId = new Map();
  const unavailable = [];
  const undatedById = new Map();
  for (const name of SOURCES) {
    if (skip.includes(name)) continue;
    try {
      for (const record of collectors[name](cfg)) {
        if (!record.date) {
          if (!undatedById.has(record.id)) undatedById.set(record.id, { id: record.id, source: record.source, ref: record.ref });
          continue;
        }
        if (cfg.until !== null && record.date > cfg.until) continue;
        if (!byId.has(record.id)) byId.set(record.id, record);
      }
    } catch (error) {
      unavailable.push({ source: name, reason: String(error?.message ?? error).split("\n")[0] });
    }
  }
  const ids = [...byId.keys()].sort();
  const records = ids.filter((id) => !seen.has(id)).map((id) => byId.get(id));
  return { records, alreadyInLedger: ids.length - records.length, unavailable, excludedUndated: [...undatedById.values()] };
}

async function main(argv) {
  const at = argv.indexOf("--config");
  if (at < 0 || !argv[at + 1]) {
    process.stderr.write("usage: node scripts/harvest_lessons.js --config harvest.json [--skip github|git|sessions]\n");
    return 2;
  }
  const config = JSON.parse(readFileSync(argv[at + 1], "utf8"));
  const skip = argv.flatMap((arg, i) => (arg === "--skip" ? [argv[i + 1]] : []));
  const result = collect(config, { skip });
  for (const record of result.records) process.stdout.write(`${JSON.stringify(record)}\n`);
  for (const gap of result.unavailable) process.stderr.write(`harvest_lessons: ${gap.source} unavailable: ${gap.reason}\n`);
  for (const item of result.excludedUndated) process.stderr.write(`harvest_lessons: excluded undated ${JSON.stringify(item)}\n`);
  process.stderr.write(`harvest_lessons: ${result.records.length} new, ${result.alreadyInLedger} already in ledger\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));

export function registerHarvestLessons(pi) {
  if (typeof pi?.registerTool !== "function") return;
  pi.registerTool({
    name: "agentic_harvest_lessons",
    label: "Harvest lessons",
    description: "Read-only. Collect cited correction evidence (PR reviews, revert and fixup commits, failed CI, session logs) for harvest-lessons. Returns only records not yet in the ledger. Never writes files, posts, or opens PRs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        configPath: { type: "string", maxLength: 1024 },
        skip: { type: "array", items: { type: "string", enum: SOURCES } },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["configPath"],
    },
    async execute(_id, params, _signal, _update, context) {
      try {
        const path = resolve(context?.cwd ?? process.cwd(), params.configPath);
        const config = JSON.parse(readFileSync(path, "utf8"));
        const base = context?.cwd ?? process.cwd();
        config.gitDir = resolve(base, config.gitDir ?? ".");
        const ledger = config.ledger ?? DEFAULT_CONFIG.ledger;
        if (ledger && !ledger.startsWith("~/")) config.ledger = resolve(base, ledger);
        const result = collect(config, { skip: params.skip ?? [] });
        const limit = params.limit ?? 200;
        const report = { ok: true, total: result.records.length, truncated: result.records.length > limit, alreadyInLedger: result.alreadyInLedger, unavailable: result.unavailable, excludedUndated: result.excludedUndated, records: result.records.slice(0, limit) };
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report };
      } catch (error) {
        const report = { ok: false, status: "blocked", reason: String(error?.message ?? error) };
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report };
      }
    },
  });
}
