// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// diff-scope adapter — changed-range extraction for code-phage.
//
// Concept provenance: pi-simplify v0.2.3 (MIT, MattDevy/pi-extensions,
// commit 8fcf9b1) changed-file and changed-line extraction, adapted and
// extended: explicit added/deleted/renamed classification, both-side line
// ranges from `git diff --unified=0`, bounded output, and no prompt-based
// enforcement. This adapter performs read-only Git queries only; it never
// mutates the repository or stages anything.
import { spawnSync } from "node:child_process";

const MAX_DIFF_BYTES = 2_000_000;
const MAX_FILES = 512;
const MAX_HUNKS_PER_FILE = 512;

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_DIFF_BYTES,
    env: GIT_ENV,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: "", stderr: result.stderr || String(result.error || "git failed") };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

function parseNameStatus(stdout) {
  // --name-status -M output: "XY\tpath" or "XY\told -> new".
  const files = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0];
    const raw = parts.length > 2 ? parts.at(-1) : parts[1];
    const oldPath = parts.length > 2 ? parts[1] : undefined;
    files.push({
      status: status.startsWith("R") ? "renamed" : status,
      path: raw,
      oldPath,
    });
  }
  return files;
}

function parseRange(spec) {
  // "start,count" | "start" ; treat "0,0" as absent (no lines on that side).
  if (!spec) return null;
  const [startText, countText] = spec.split(",");
  const start = Number(startText);
  const count = countText === undefined ? 1 : Number(countText);
  if (!Number.isInteger(start) || !Number.isInteger(count) || count <= 0) return null;
  return { start, end: start + count - 1 };
}

function parseHunks(stdout) {
  // Map path -> { added: [ranges], removed: [ranges] } from -U0 output.
  // Each hunk contributes its range once, not once per changed line.
  const byFile = new Map();
  let currentPath = undefined;
  let current = undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git (?:"?a\/(.+?)) (?:"?b\/(.+?)"?)$/);
      currentPath = match ? match[2] : undefined;
      current = undefined;
      if (currentPath && !byFile.has(currentPath)) byFile.set(currentPath, { added: [], removed: [] });
      continue;
    }
    const hunk = line.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/);
    if (hunk) {
      if (!currentPath) continue;
      const entry = byFile.get(currentPath);
      if (!entry) continue;
      const added = parseRange(hunk[2]);
      const removed = parseRange(hunk[1]);
      if (added && !entry.added.some((r) => r.start === added.start && r.end === added.end)) entry.added.push(added);
      if (removed && !entry.removed.some((r) => r.start === removed.start && r.end === removed.end)) entry.removed.push(removed);
      current = { added, removed };
      continue;
    }
    if (!current || !currentPath) continue;
  }
  return byFile;
}

function capRanges(ranges, limitations, path, side) {
  if (ranges.length > MAX_HUNKS_PER_FILE) {
    limitations.push(`truncated ${side} ranges for ${path} at ${MAX_HUNKS_PER_FILE}`);
    return ranges.slice(0, MAX_HUNKS_PER_FILE);
  }
  return ranges;
}

export function changedRanges(root, ref = "HEAD") {
  const limitations = [];
  const names = git(root, ["diff", "--name-status", "-M", ref]);
  if (!names.ok) {
    return { status: "git-unavailable", files: [], limitations: ["git diff --name-status was unavailable; no changed-file scope was inferred."], ref };
  }
  // `git diff` never reports untracked files; discover them separately.
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  const rawPaths = parseNameStatus(names.stdout).map((file) => ({ ...file, untracked: false }));
  let untrackedPaths = [];
  if (untracked.ok) {
    untrackedPaths = untracked.stdout.split(/\r?\n/).filter(Boolean).map((path) => ({ status: "A", path, untracked: true }));
  } else {
    limitations.push("untracked-file discovery failed; untracked additions may be missing from the changed scope.");
  }
  const files = [...rawPaths, ...untrackedPaths];
  const totalFiles = files.length;
  const boundedFiles = files.slice(0, MAX_FILES);
  if (totalFiles > MAX_FILES) limitations.push(`truncated changed files at ${MAX_FILES}; ${totalFiles - MAX_FILES} file(s) are outside the bounded scope.`);
  const hunks = git(root, ["diff", "--unified=0", ref]);
  if (!hunks.ok) limitations.push("hunk-range query failed; added/removed line ranges may be incomplete for modified files.");
  const rangeMap = hunks.ok ? parseHunks(hunks.stdout) : new Map();
  const result = [];
  for (const file of boundedFiles) {
    const ranges = rangeMap.get(file.path) || { added: [], removed: [] };
    if (file.status === "A") {
      result.push({ ...file, classification: "added-file", added: [], removed: [], wholeCurrentFile: true });
    } else if (file.status === "D") {
      result.push({ ...file, classification: "deleted-file", added: [], removed: [], wholeCurrentFile: false, deleted: true });
    } else if (file.status === "renamed") {
      result.push({
        ...file,
        classification: "renamed",
        added: capRanges(ranges.added, limitations, file.path, "added"),
        removed: capRanges(ranges.removed, limitations, file.path, "removed"),
        wholeCurrentFile: false,
      });
    } else {
      result.push({
        ...file,
        classification: "modified",
        added: capRanges(ranges.added, limitations, file.path, "added"),
        removed: capRanges(ranges.removed, limitations, file.path, "removed"),
        wholeCurrentFile: false,
      });
    }
  }
  return { status: "observed", files: result, limitations, ref };
}
