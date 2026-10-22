// SPDX-License-Identifier: AGPL-3.0-only

// Merge policy for the driver. One owner-set value in the driver's own
// profile config decides whether an agent may ever run a pull-request merge:
//
//   human-merges-only (default)  The owner merges on GitHub. Agent merge
//                                commands are always refused.
//   agents-after-checks-and-review
//                                An agent may run `gh pr merge <ref>` only when
//                                every check on the PR head has passed and a
//                                Standards PASS and a Spec PASS are recorded
//                                for that exact head.
//
// The file lives at {PI_CODING_AGENT_DIR}/config/merge-policy.v1.json
// (fallback to the installed agent config directory). It is never read from the working tree, so
// a repository or a model cannot widen the policy. A missing file means the
// default; an unreadable or unknown value fails closed to the default.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MERGE_POLICY_SCHEMA = "pi-agentic-driver.merge-policy.v1";
export const HUMAN_MERGES_ONLY = "human-merges-only";
export const AGENTS_AFTER_CHECKS_AND_REVIEW = "agents-after-checks-and-review";
export const DEFAULT_MERGE_POLICY = HUMAN_MERGES_ONLY;
const POLICIES = new Set([HUMAN_MERGES_ONLY, AGENTS_AFTER_CHECKS_AND_REVIEW]);
const SHA = /^[0-9a-f]{40}$/;

export function profileDir(env = process.env) {
  const dir = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  return dir ? resolve(dir) : resolve(homedir(), ".pi", "agent");
}

export function mergePolicyPath(env = process.env) {
  return join(profileDir(env), "config", "merge-policy.v1.json");
}

export function sessionIdOf(ctx) {
  try { return String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId ?? "").trim(); } catch { return ""; }
}

export function reviewRecordPath(headSha, env = process.env) {
  if (!SHA.test(String(headSha))) throw new Error("review record needs a full commit SHA");
  return join(profileDir(env), "merge-reviews", `${headSha}.json`);
}

// Returns { policy, source }. source is "default", "config" or "invalid".
export function loadMergePolicy({ env = process.env, read = (p) => readFileSync(p, "utf8") } = {}) {
  let text;
  try { text = read(mergePolicyPath(env)); } catch (error) {
    return { policy: DEFAULT_MERGE_POLICY, source: error?.code === "ENOENT" ? "default" : "invalid" };
  }
  try {
    const data = JSON.parse(text);
    if (data?.schema === MERGE_POLICY_SCHEMA && POLICIES.has(data.policy)) return { policy: data.policy, source: "config" };
  } catch { /* fall through */ }
  return { policy: DEFAULT_MERGE_POLICY, source: "invalid" };
}

const MERGE_FORMS = [
  { pattern: /\bgh\s+pr\s+merge\b/, form: "gh" },
  { pattern: /\/pulls\/[^\s/]+\/merge\b/, form: "api" },
  { pattern: /\bmergePullRequest\b/, form: "graphql" },
];

function normalize(text) {
  return String(text ?? "").split(/\s+/)
    .map((t) => t.replace(/["'\\]/g, "").replace(/^.*\/gh$/, "gh"))
    .join(" ");
}

// Detects a pull-request merge in a shell command. ref is the PR argument of
// a simple `gh pr merge <ref>` call, or "" when none can be read safely.
// Forms that skip checks or branch protection. Refused under every policy.
const BYPASS_FORMS = [
  { pattern: /\bgh pr merge\b[^;&|\n]*\s--admin\b/, why: "--admin skips branch protection" },
  { pattern: /\bgh pr merge\b[^;&|\n]*\s--auto\b/, why: "--auto merges later, after the evidence was checked" },
  { pattern: /\/branches\/[^\s]+\/protection\b/, why: "changes branch protection", write: true },
  { pattern: /\/rulesets\b/, why: "changes repository rulesets", write: true },
  { pattern: /\b(?:enablePullRequestAutoMerge|mergeBranch|updateBranchProtectionRule|deleteBranchProtectionRule)\b/, why: "GraphQL merge or protection change" },
  { pattern: /\bbypass[_-]?(?:pull[_-]?request[_-]?)?(?:allowances|actors)\b/i, why: "edits protection bypass lists" },
];

export function detectBypass(command) {
  const text = normalize(command);
  // Reading protection or rulesets is fine; only writes are a bypass.
  const writes = /(?:^|\s)(?:-X|--method)(?:\s+|=)?(?:PUT|POST|PATCH|DELETE)\b|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/i.test(text);
  const hit = BYPASS_FORMS.find(({ pattern, write }) => pattern.test(text) && (!write || writes));
  return hit ? { bypass: true, why: hit.why } : { bypass: false };
}

export function detectMerge(command) {
  const raw = String(command ?? "");
  const text = normalize(raw);
  const bypass = detectBypass(raw);
  if (bypass.bypass) return { merge: true, form: "bypass", ref: "", why: bypass.why };
  const hit = MERGE_FORMS.find(({ pattern }) => pattern.test(text));
  if (!hit) return { merge: false };
  let ref = "";
  const compound = /[;&|>`\n]|\$\(/.test(raw);
  if (hit.form === "gh" && !compound) {
    const args = text.split(/\bgh pr merge\b/)[1].trim().split(" ").filter(Boolean);
    // A repository flag could point the merge at a different repository from
    // the one the evidence is read from, so it is never checkable.
    const repoFlag = args.some((a) => a === "-R" || a === "--repo" || a.startsWith("--repo=") || /^-R./.test(a));
    const positional = args.filter((a) => !a.startsWith("-"));
    if (!repoFlag && positional.length === 1 && /^(?:\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/.test(positional[0])) ref = positional[0];
  }
  return { merge: true, form: hit.form, ref };
}

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// Pure decision. evidence: { headSha, author, mergerSession,
//   checks: [{ state }],
//   review: { headSha, standards, spec, standardsReviewer, specReviewer, recordedBySession } }.
// A PASS counts only when its reviewer differs from the PR author and from the
// merging session, and the record was not written by the merging session.
export function evaluateMerge(policy, detection, evidence) {
  if (detection.form === "bypass") return { allow: false, reason: `refused under every merge policy: ${detection.why}` };
  if (policy !== AGENTS_AFTER_CHECKS_AND_REVIEW) {
    return { allow: false, reason: "merge policy is human-merges-only: the owner merges on GitHub" };
  }
  if (detection.form !== "gh" || !detection.ref) {
    return { allow: false, reason: "only a simple `gh pr merge <number|url>` can be checked against the merge policy" };
  }
  if (!evidence || evidence.error) return { allow: false, reason: `merge evidence unavailable: ${evidence?.error ?? "none"}` };
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  if (!checks.length) return { allow: false, reason: "no checks reported on the PR head; a required check (for example PR wording) must pass first" };
  const failing = checks.filter((c) => !PASSING.has(String(c.state ?? "").toUpperCase()));
  if (failing.length) return { allow: false, reason: `${failing.length} check(s) on the PR head have not passed` };
  const review = evidence.review;
  if (!review || review.headSha !== evidence.headSha) return { allow: false, reason: "no independent review recorded for the current PR head" };
  if (review.standards !== "PASS" || review.spec !== "PASS") return { allow: false, reason: "the recorded review for this head is not Standards PASS and Spec PASS" };
  const merger = String(evidence.mergerSession ?? "").trim();
  if (!merger) return { allow: false, reason: "the merging session has no id, so reviewer independence cannot be checked" };
  const author = String(evidence.author ?? "").trim().toLowerCase();
  if (!author) return { allow: false, reason: "the PR author is unknown, so reviewer independence cannot be checked" };
  if (String(review.recordedBySession ?? "") === merger) return { allow: false, reason: "the review was recorded by the merging session itself" };
  for (const axis of ["standards", "spec"]) {
    const who = String(review[`${axis}Reviewer`] ?? "").trim();
    if (!who) return { allow: false, reason: `no ${axis} reviewer identity recorded` };
    if (who === merger) return { allow: false, reason: `the ${axis} reviewer is the merging session` };
    if (who.toLowerCase() === author) return { allow: false, reason: `the ${axis} reviewer is the PR author` };
  }
  return { allow: true, reason: "checks passed and Standards and Spec PASS recorded for this head" };
}

// Default evidence source: GitHub through the existing gh login, plus the
// review record kept in the profile directory.
export function gatherMergeEvidence(ref, { run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 }), env = process.env, read = (p) => readFileSync(p, "utf8") } = {}) {
  try {
    const view = JSON.parse(run("gh", ["pr", "view", ref, "--json", "headRefOid,statusCheckRollup,author"]));
    const headSha = String(view.headRefOid ?? "");
    const author = String(view.author?.login ?? "");
    const checks = (view.statusCheckRollup ?? []).map((c) => ({ state: c.conclusion || c.state || "PENDING" }));
    let review;
    try { review = JSON.parse(read(reviewRecordPath(headSha, env))); } catch { review = undefined; }
    return { headSha, author, checks, review };
  } catch (error) {
    return { error: String(error?.message ?? error).split("\n")[0] };
  }
}

export function reviewRecord({ headSha, standards, spec, standardsReviewer, specReviewer, recordedBySession }) {
  if (!SHA.test(String(headSha))) return { ok: false, reason: "headSha must be a full 40-character commit SHA" };
  const verdict = (v) => (v === "PASS" || v === "FAIL" ? v : null);
  if (!verdict(standards) || !verdict(spec)) return { ok: false, reason: "standards and spec must each be PASS or FAIL" };
  const id = (v) => (typeof v === "string" ? v.trim() : "");
  if (!id(standardsReviewer) || !id(specReviewer)) return { ok: false, reason: "each verdict needs its reviewer identity or session id" };
  if (!id(recordedBySession)) return { ok: false, reason: "the recording session has no id" };
  if (id(standardsReviewer) === id(recordedBySession) || id(specReviewer) === id(recordedBySession)) {
    return { ok: false, reason: "a session cannot record its own review verdict" };
  }
  return { ok: true, record: {
    schema: "pi-agentic-driver.merge-review.v1", headSha, standards, spec,
    standardsReviewer: id(standardsReviewer), specReviewer: id(specReviewer), recordedBySession: id(recordedBySession),
  } };
}
