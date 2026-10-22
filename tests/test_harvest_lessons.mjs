// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, userText, registerHarvestLessons } from "../scripts/harvest_lessons.js";

function fakeGh(cmd, args) {
  if (cmd === "git") return execFileSync(cmd, args, { encoding: "utf8" });
  const path = args.at(-1);
  if (path.startsWith("repos/o/r/pulls?")) return JSON.stringify([{ number: 7 }]);
  // Two concatenated pages, as `gh api --paginate` prints them; brackets inside a string must not split a page.
  if (path.includes("/pulls/7/comments")) return "[]\n" + JSON.stringify([{ created_at: "2026-10-01T00:00:00Z", path: "a.py", body: "Don't name the model here ]}{\\\"", html_url: "u1" }]);
  if (path.includes("/pulls/7/reviews")) return JSON.stringify([
    { state: "CHANGES_REQUESTED", submitted_at: "2026-10-02T00:00:00Z", body: "Too long", html_url: "u2" },
    { state: "APPROVED", submitted_at: "2026-10-03T00:00:00Z", body: "ok", html_url: "u3" },
  ]);
  if (path.includes("actions/runs")) return JSON.stringify({ workflow_runs: [{ name: "ci", head_sha: "abcdef123", head_branch: "b", created_at: "2026-10-04T00:00:00Z", html_url: "u4" }] });
  throw new Error(`unexpected ${path}`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harvest-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("init", "-q");
  for (const s of ["Add feature", 'Revert "Add feature"', "fixup! Add loop", "Tidy docs"]) git("commit", "-q", "--allow-empty", "-m", s);
  mkdirSync(join(root, "sessions"));
  writeFileSync(join(root, "sessions", "s.jsonl"), [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "That's not what I asked" }] } },
    { type: "message", message: { role: "assistant", content: "not what I asked, sorry" } },
    { type: "message", message: { role: "user", content: "Thanks, looks good" } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n");
  const ledger = join(root, "ledger.json");
  return { root, ledger, config: { repo: "o/r", since: "2000-01-01", gitDir: repo, sessionGlobs: [join(root, "sessions", "*.jsonl")], ledger } };
}

test("collects every source and only corrections", () => {
  const { config } = fixture();
  const { records, unavailable } = collect(config, { run: fakeGh });
  assert.deepEqual(unavailable, []);
  assert.deepEqual(records.map((r) => r.source).sort(), ["ci_failure", "commit", "commit", "pr_changes_requested", "pr_review_comment", "session"]);
  const text = records.map((r) => r.text).join(" ");
  for (const absent of ["Tidy docs", "sorry", "looks good", "ok"]) assert.ok(!text.includes(absent), absent);
});

test("daily upper bound excludes later corrections without consuming their ledger ids", () => {
  const { config, ledger } = fixture();
  const day = collect({ ...config, until: "2026-10-02" }, { run: fakeGh, skip: ["git", "sessions"] });
  assert.deepEqual(day.records.map((r) => r.source).sort(), ["pr_changes_requested", "pr_review_comment"]);
  writeFileSync(ledger, JSON.stringify({ evidence_ids: day.records.map((r) => r.id) }));
  const later = collect({ ...config, since: "2026-10-03", until: "2026-10-04" }, { run: fakeGh, skip: ["git", "sessions"] });
  assert.deepEqual(later.records.map((r) => r.source), ["ci_failure"]);
  assert.equal(later.alreadyInLedger, 0);
  assert.throws(() => collect({ ...config, until: "1999-12-31" }, { skip: ["github", "git", "sessions"] }), /until must be/);
});

test("undated review evidence is surfaced instead of silently dropped", () => {
  const { config } = fixture();
  const run = (cmd, args) => {
    if (cmd === "gh" && args.at(-1).includes("/pulls/7/comments")) {
      const undated = { path: "a.py", body: "Don't do that", html_url: "u-undated" };
      return JSON.stringify([undated, undated]);
    }
    return fakeGh(cmd, args);
  };
  const result = collect({ ...config, until: "2026-10-02" }, { run, skip: ["git", "sessions"] });
  assert.deepEqual(result.excludedUndated.map((item) => item.source), ["pr_review_comment"]);
  assert.ok(result.excludedUndated[0].id);
  assert.equal(result.records.some((item) => item.source === "pr_review_comment"), false);
  const unbounded = collect(config, { run, skip: ["git", "sessions"] });
  assert.deepEqual(unbounded.excludedUndated, result.excludedUndated);
  assert.equal(unbounded.records.some((item) => item.source === "pr_review_comment"), false);
});

test("deterministic, and the ledger makes reruns idempotent", () => {
  const { config, ledger } = fixture();
  const first = collect(config, { run: fakeGh }).records;
  assert.deepEqual(collect(config, { run: fakeGh }).records, first);
  writeFileSync(ledger, JSON.stringify({ evidence_ids: first.slice(0, 4).map((r) => r.id) }));
  const second = collect(config, { run: fakeGh });
  assert.deepEqual(second.records, first.slice(4));
  assert.equal(second.alreadyInLedger, 4);
});

test("a failing source is reported, not hidden", () => {
  const { config } = fixture();
  const run = (cmd, args) => { if (cmd === "gh") throw new Error("gh: not found"); return fakeGh(cmd, args); };
  const result = collect(config, { run });
  assert.deepEqual(result.unavailable, [{ source: "github", reason: "gh: not found" }]);
  assert.equal(result.records.length, 3);
});

test("only user messages count", () => {
  assert.equal(userText(JSON.stringify({ message: { role: "assistant", content: "I said" } })), null);
  assert.equal(userText("plain herdr log line"), "plain herdr log line");
});

test("Pi tool is read-only and works with no UI", async () => {
  const { root, config } = fixture();
  const tools = [];
  registerHarvestLessons({ registerTool: (t) => tools.push(t) });
  assert.deepEqual(tools.map((t) => t.name), ["agentic_harvest_lessons"]);
  const cfgPath = join(root, "harvest.json");
  writeFileSync(cfgPath, JSON.stringify({ ...config, repo: undefined }));
  const before = readFileSync(cfgPath, "utf8");
  const out = await tools[0].execute("1", { configPath: cfgPath, skip: ["github"] }, undefined, undefined, { cwd: root });
  assert.equal(out.details.ok, true);
  assert.equal(out.details.total, 3);
  assert.equal(readFileSync(cfgPath, "utf8"), before);
  const bad = await tools[0].execute("2", { configPath: join(root, "missing.json") }, undefined, undefined, { cwd: root });
  assert.equal(bad.details.status, "blocked");
});

test("Pi tool reads a relative ledger from the session directory", async () => {
  const { root, config } = fixture();
  const tools = [];
  registerHarvestLessons({ registerTool: (t) => tools.push(t) });
  const cfgPath = join(root, "harvest.json");
  writeFileSync(cfgPath, JSON.stringify({ ...config, repo: undefined, ledger: "ledger.json" }));
  const first = await tools[0].execute("1", { configPath: cfgPath, skip: ["github"] }, undefined, undefined, { cwd: root });
  writeFileSync(join(root, "ledger.json"), JSON.stringify({ evidence_ids: first.details.records.map((r) => r.id) }));
  const again = await tools[0].execute("2", { configPath: cfgPath, skip: ["github"] }, undefined, undefined, { cwd: root });
  assert.equal(again.details.total, 0);
  assert.equal(again.details.alreadyInLedger, 3);
});

test("session citations hide the home directory", () => {
  const { root, config } = fixture();
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    const { records } = collect({ ...config, sessionGlobs: ["~/sessions/*.jsonl"] }, { skip: ["github", "git"] });
    assert.equal(records.length, 1);
    assert.equal(records[0].ref, "~/sessions/s.jsonl:1");
  } finally {
    process.env.HOME = home;
  }
});
