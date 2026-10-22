// SPDX-License-Identifier: AGPL-3.0-only

// PR review gate. Three enforced checks on a pull request, run in CI on every
// push, review, review comment and PR comment:
//
//   1. review-freeze   An approval counts only for the commit it was given on.
//                      Any push after approval moves the head, so the check
//                      fails until a fresh approval lands on the new head.
//                      When the PR author is the repo's sole maintainer (GitHub
//                      does not let authors approve their own PRs), no approval
//                      is required: their merge is the final sign-off. Any
//                      approval that is given must still be on the current head.
//                      With two or more maintainers, or when the maintainer list
//                      is unknown, an approval on head is required as usual.
//   2. comment-tags    Every review comment starts with [question] or
//                      [work-request]. A question needs a reply. A work request
//                      needs a reply that names a commit on this PR made after
//                      the request.
//   3. journey-claims  A claim that a whole user journey works (end to end,
//                      full flow, and so on) is rejected unless the same text
//                      carries "Evidence-SHA: <head sha>" and an evidence link.
//
// Pure evaluation lives in evaluatePrReviewGate(); the CLI only gathers data
// with `gh api` (or reads a JSON snapshot) and sets the exit code.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TAG_QUESTION = "question";
export const TAG_WORK_REQUEST = "work-request";
const TAG_RE = /^\s*\[(question|work-request)\]/i;
const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
const EVIDENCE_SHA_RE = /Evidence-SHA:\s*([0-9a-f]{40})\b/gi;
const EVIDENCE_LINK_RE = /Evidence:\s*(https?:\/\/\S+|\S+\.(?:log|txt|json|md|png|jpg|gif|mp4|webm|html))/i;

// Phrases that claim a whole journey works. Kept narrow so ordinary test
// results ("unit tests pass") do not trip it.
export const JOURNEY_CLAIM_PATTERNS = [
  /\b(?:whole|full|entire|complete)\s+(?:user\s+)?(?:journey|flow|workflow|path)\s+(?:now\s+)?(?:works|passes|is\s+working|succeeds)\b/i,
  /\b(?:user\s+)?journey\s+(?:now\s+)?(?:works|passes|is\s+working)\b/i,
  /\bworks\s+end[\s-]to[\s-]end\b/i,
  /\bend[\s-]to[\s-]end\s+(?:now\s+)?(?:works|passes|is\s+working|verified|confirmed)\b/i,
  /\be2e\s+(?:now\s+)?(?:works|passes|is\s+green|verified)\b/i,
];

export function tagOf(body) {
  const m = TAG_RE.exec(body ?? "");
  return m ? m[1].toLowerCase() : null;
}

export function hasJourneyClaim(text) {
  return JOURNEY_CLAIM_PATTERNS.some((re) => re.test(text ?? ""));
}

function evidenceFor(text, headSha) {
  const shas = [...(text ?? "").matchAll(EVIDENCE_SHA_RE)].map((m) => m[1].toLowerCase());
  return { onHead: shas.includes(headSha), anySha: shas.length > 0, link: EVIDENCE_LINK_RE.test(text ?? "") };
}

const time = (s) => (s ? Date.parse(s) : NaN);

// ---- check 1: review freeze -------------------------------------------------
// True only when the maintainer list is known, has exactly one login, and that
// login is the PR author. Unknown (null) or larger lists stay strict.
export function isSoleMaintainerAuthored({ author, maintainers }) {
  if (!Array.isArray(maintainers)) return false;
  const unique = [...new Set(maintainers.map((m) => m.toLowerCase()))];
  const a = (author ?? "").toLowerCase();
  return a !== "" && unique.length === 1 && unique[0] === a;
}

export function checkReviewFreeze({ headSha, reviews, author, maintainers }) {
  const failures = [];
  // Latest decisive review per reviewer; COMMENTED reviews do not change state.
  const latest = new Map();
  for (const r of reviews) {
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
    const prev = latest.get(r.user);
    if (!prev || time(r.submitted_at) >= time(prev.submitted_at)) latest.set(r.user, r);
  }
  const approvals = [...latest.values()].filter((r) => r.state === "APPROVED");
  const onHead = approvals.filter((r) => r.commit_id === headSha);
  const stale = approvals.filter((r) => r.commit_id !== headSha);
  const blocking = [...latest.values()].filter((r) => r.state === "CHANGES_REQUESTED");
  for (const r of stale) {
    failures.push(`approval by ${r.user} was given on ${short(r.commit_id)}, head is now ${short(headSha)}: a fresh review on the new head is needed`);
  }
  for (const r of blocking) failures.push(`${r.user} requested changes on ${short(r.commit_id)}`);
  const soleMaintainer = isSoleMaintainerAuthored({ author, maintainers });
  if (!soleMaintainer && onHead.length === 0 && stale.length === 0) failures.push(`no approval on head ${short(headSha)} yet`);
  const result = { name: "review-freeze", ok: failures.length === 0, failures };
  if (soleMaintainer) result.note = `author ${author} is the sole maintainer: no approval required, their merge is the sign-off`;
  return result;
}

// ---- check 2: comment tags -------------------------------------------------
export function checkCommentTags({ reviewComments, reviews, issueComments, commits, author }) {
  const failures = [];
  const commitTimes = new Map();
  for (const c of commits) commitTimes.set(c.sha.toLowerCase(), time(c.date));
  const commitAfter = (text, since) => {
    for (const m of (text ?? "").matchAll(SHA_RE)) {
      const ref = m[0].toLowerCase();
      for (const [sha, t] of commitTimes) if (sha.startsWith(ref) && t >= since) return sha;
    }
    return null;
  };

  // Inline threads: the root carries the tag, replies resolve it.
  const replies = new Map();
  for (const c of reviewComments) {
    if (c.in_reply_to_id) {
      if (!replies.has(c.in_reply_to_id)) replies.set(c.in_reply_to_id, []);
      replies.get(c.in_reply_to_id).push(c);
    }
  }
  const items = [];
  for (const c of reviewComments) {
    if (c.in_reply_to_id || c.user === author) continue;
    items.push({ where: `review comment ${c.id}`, ...c, answers: replies.get(c.id) ?? [] });
  }
  // Review summaries: answered by a PR comment that says "Re: review <id>".
  for (const r of reviews) {
    if (!r.body?.trim() || r.user === author) continue;
    const answers = issueComments.filter((ic) => new RegExp(`\\bRe:\\s*review\\s+${r.id}\\b`, "i").test(ic.body ?? ""));
    items.push({ where: `review ${r.id}`, ...r, created_at: r.submitted_at, answers });
  }

  for (const it of items) {
    const tag = tagOf(it.body);
    if (!tag) {
      failures.push(`${it.where} by ${it.user} has no [question] or [work-request] tag`);
      continue;
    }
    const answers = it.answers.filter((a) => a.user !== it.user && time(a.created_at) >= time(it.created_at));
    if (tag === TAG_QUESTION && answers.length === 0) failures.push(`${it.where} is a question with no reply`);
    if (tag === TAG_WORK_REQUEST) {
      const since = time(it.created_at);
      const linked = answers.some((a) => commitAfter(a.body, since));
      if (!linked) failures.push(`${it.where} is a work request with no reply naming a follow-up commit on this PR`);
    }
  }
  return { name: "comment-tags", ok: failures.length === 0, failures };
}

// ---- check 3: journey claims -----------------------------------------------
export function checkJourneyClaims({ headSha, body, reviews, issueComments, reviewComments }) {
  const failures = [];
  const texts = [
    { where: "PR body", body },
    ...issueComments.map((c) => ({ where: `PR comment ${c.id}`, body: c.body })),
    ...reviews.map((r) => ({ where: `review ${r.id}`, body: r.body })),
    ...reviewComments.map((c) => ({ where: `review comment ${c.id}`, body: c.body })),
  ];
  for (const t of texts) {
    if (!hasJourneyClaim(t.body)) continue;
    const ev = evidenceFor(t.body, headSha);
    if (!ev.onHead) {
      failures.push(ev.anySha
        ? `${t.where} claims a whole journey works but its Evidence-SHA is not the head ${short(headSha)}`
        : `${t.where} claims a whole journey works with no "Evidence-SHA: ${headSha}"`);
    } else if (!ev.link) {
      failures.push(`${t.where} claims a whole journey works but attaches no "Evidence: <link or file>"`);
    }
  }
  return { name: "journey-claims", ok: failures.length === 0, failures };
}

export function evaluatePrReviewGate(pr) {
  const norm = normalise(pr);
  if (norm.draft) {
    return { ok: true, skipped: "draft PR: checks run once it is ready for review", checks: [] };
  }
  const checks = [checkReviewFreeze(norm), checkCommentTags(norm), checkJourneyClaims(norm)];
  return { ok: checks.every((c) => c.ok), checks };
}

function normalise(pr) {
  if (!/^[0-9a-f]{40}$/i.test(pr.headSha ?? "")) throw new Error("headSha must be a 40-character commit SHA");
  return {
    headSha: pr.headSha.toLowerCase(),
    draft: Boolean(pr.draft),
    author: pr.author,
    maintainers: Array.isArray(pr.maintainers)
      ? pr.maintainers.filter((m) => typeof m === "string" && m.trim() !== "").map((m) => m.trim())
      : null,
    body: pr.body ?? "",
    reviews: (pr.reviews ?? []).map((r) => ({ ...r, commit_id: r.commit_id?.toLowerCase() })),
    reviewComments: pr.reviewComments ?? [],
    issueComments: pr.issueComments ?? [],
    commits: pr.commits ?? [],
  };
}

function short(sha) {
  return (sha ?? "unknown").slice(0, 7);
}

// ---- data gathering ---------------------------------------------------------
function ghApi(path) {
  const out = execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const pages = JSON.parse(out);
  return Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : pages[0] ?? pages;
}

// Maintainers: an explicit list wins; otherwise collaborators with maintain or
// admin permission. If that API is not readable, the list is unknown (null)
// and the freeze stays strict.
export function gatherMaintainers(repo, api = ghApi, configured = null) {
  if (Array.isArray(configured) && configured.length > 0) return configured;
  try {
    // Filter on each collaborator's own permission flags rather than trusting
    // the endpoint's permission filter, so admins and maintainers both count.
    const users = api(`repos/${repo}/collaborators?affiliation=all`);
    if (!Array.isArray(users)) return null;
    return users.filter((u) => u?.permissions?.admin || u?.permissions?.maintain).map((u) => u.login).filter(Boolean);
  } catch {
    return null;
  }
}

export function gatherFromGitHub(repo, number, api = ghApi, configuredMaintainers = null) {
  const base = `repos/${repo}/pulls/${number}`;
  const pull = api(base);
  const login = (u) => u?.login ?? null;
  return {
    headSha: pull.head.sha,
    draft: pull.draft,
    author: login(pull.user),
    maintainers: gatherMaintainers(repo, api, configuredMaintainers),
    body: pull.body ?? "",
    reviews: api(`${base}/reviews`).map((r) => ({ id: r.id, user: login(r.user), state: r.state, commit_id: r.commit_id, body: r.body, submitted_at: r.submitted_at })),
    reviewComments: api(`${base}/comments`).map((c) => ({ id: c.id, user: login(c.user), body: c.body, in_reply_to_id: c.in_reply_to_id ?? null, created_at: c.created_at })),
    issueComments: api(`repos/${repo}/issues/${number}/comments`).map((c) => ({ id: c.id, user: login(c.user), body: c.body, created_at: c.created_at })),
    commits: api(`${base}/commits`).map((c) => ({ sha: c.sha, date: c.commit.committer?.date ?? c.commit.author?.date })),
  };
}

export function formatResult(result) {
  if (result.skipped) return `PR review gate: skipped (${result.skipped})`;
  const lines = [`PR review gate: ${result.ok ? "PASS" : "FAIL"}`];
  for (const c of result.checks) {
    lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
    if (c.note) lines.push(`       note: ${c.note}`);
    for (const f of c.failures) lines.push(`       - ${f}`);
  }
  return lines.join("\n");
}

function main(argv) {
  const args = Object.fromEntries(argv.reduce((acc, a, i) => (a.startsWith("--") ? [...acc, [a.slice(2), argv[i + 1]]] : acc), []));
  // Optional maintainer list from --maintainers or PR_GATE_MAINTAINERS (comma-separated).
  const listed = (args.maintainers ?? process.env.PR_GATE_MAINTAINERS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const pr = args.snapshot
    ? { ...JSON.parse(readFileSync(args.snapshot, "utf8")), ...(listed.length ? { maintainers: listed } : {}) }
    : gatherFromGitHub(args.repo ?? process.env.GITHUB_REPOSITORY, args.pr ?? process.env.PR_NUMBER, ghApi, listed.length ? listed : null);
  const result = evaluatePrReviewGate(pr);
  console.log(formatResult(result));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`PR review gate: error: ${err.message}`);
    process.exitCode = 2;
  }
}
