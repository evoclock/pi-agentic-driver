import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMergePolicy, detectMerge, evaluateMerge, gatherMergeEvidence, reviewRecord,
  mergePolicyPath, DEFAULT_MERGE_POLICY, HUMAN_MERGES_ONLY, AGENTS_AFTER_CHECKS_AND_REVIEW, MERGE_POLICY_SCHEMA,
} from "../scripts/enforcement/merge_policy.js";
import { guardToolCall, registerAttendedAuthorityGuard } from "../scripts/enforcement/attended_authority_guard.js";

const SHA = "a".repeat(40);
const HEADLESS = { mode: "rpc", hasUI: false };
const TUI = { mode: "tui", hasUI: true, ui: { confirm: async () => true } };
const merge = (command) => ({ toolName: "bash", input: { command } });

function profile(policyJson) {
  const dir = mkdtempSync(join(tmpdir(), "merge-policy-"));
  if (policyJson !== undefined) {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "merge-policy.v1.json"), typeof policyJson === "string" ? policyJson : JSON.stringify(policyJson));
  }
  return { PI_CODING_AGENT_DIR: dir };
}

test("default is human-merges-only when no config exists", () => {
  assert.equal(DEFAULT_MERGE_POLICY, HUMAN_MERGES_ONLY);
  assert.deepEqual(loadMergePolicy({ env: profile() }), { policy: HUMAN_MERGES_ONLY, source: "default" });
});

test("config selects either value from the profile directory only", () => {
  for (const policy of [HUMAN_MERGES_ONLY, AGENTS_AFTER_CHECKS_AND_REVIEW]) {
    assert.deepEqual(loadMergePolicy({ env: profile({ schema: MERGE_POLICY_SCHEMA, policy }) }), { policy, source: "config" });
  }
  assert.match(mergePolicyPath({ PI_CODING_AGENT_DIR: "/p" }), /\/p\/config\/merge-policy\.v1\.json$/);
});

test("unknown, malformed or schema-less config fails closed to the default", () => {
  for (const bad of ["{not json", { schema: MERGE_POLICY_SCHEMA, policy: "anyone" }, { policy: AGENTS_AFTER_CHECKS_AND_REVIEW }]) {
    assert.deepEqual(loadMergePolicy({ env: profile(bad) }), { policy: HUMAN_MERGES_ONLY, source: "invalid" });
  }
});

test("merge commands are detected in common shapes", () => {
  assert.deepEqual(detectMerge("gh pr merge 12 --squash"), { merge: true, form: "gh", ref: "12" });
  assert.equal(detectMerge("/opt/bin/gh 'pr' merge 12").ref, "12");
  assert.equal(detectMerge("gh pr merge").ref, "");
  for (const flag of ["--repo o/r", "-R o/r", "--repo=o/r", "-Ro/r"]) assert.equal(detectMerge(`gh pr merge 12 ${flag}`).ref, "", flag);
  assert.equal(detectMerge("gh pr merge https://github.com/o/r/pull/12 --squash").ref, "https://github.com/o/r/pull/12");
  assert.equal(detectMerge("gh pr merge 12 && echo done").ref, "");
  assert.equal(detectMerge("gh api -X PUT repos/o/r/pulls/12/merge").form, "api");
  assert.equal(detectMerge("gh api graphql -f query='mutation{mergePullRequest(input:{})}'").form, "graphql");
  assert.equal(detectMerge("gh pr view 12").merge, false);
});

const green = {
  headSha: SHA, author: "evoclock", mergerSession: "merger-1",
  checks: [{ state: "SUCCESS" }, { state: "SKIPPED" }],
  review: { headSha: SHA, standards: "PASS", spec: "PASS", standardsReviewer: "rev-a", specReviewer: "rev-b", recordedBySession: "coord-2" },
};
const { mergerSession: _m, ...greenFromGithub } = green;
const gh = detectMerge("gh pr merge 12");

test("human-merges-only refuses even with full evidence", () => {
  assert.equal(evaluateMerge(HUMAN_MERGES_ONLY, gh, green).allow, false);
});

test("agents setting allows only with passing checks and a PASS/PASS review of the same head", () => {
  assert.equal(evaluateMerge(AGENTS_AFTER_CHECKS_AND_REVIEW, gh, green).allow, true);
  const cases = [
    { ...green, checks: [] },
    { ...green, checks: [{ state: "FAILURE" }] },
    { ...green, checks: [{ state: "PENDING" }] },
    { ...green, review: undefined },
    { ...green, review: { ...green.review, headSha: "b".repeat(40) } },
    { ...green, review: { ...green.review, spec: "FAIL" } },
    { error: "gh: not logged in" },
    { ...green, mergerSession: "" },
    { ...green, author: "" },
    { ...green, review: { ...green.review, recordedBySession: "merger-1" } },
    { ...green, review: { ...green.review, standardsReviewer: "merger-1" } },
    { ...green, review: { ...green.review, specReviewer: "EVOCLOCK" } },
    { ...green, review: { ...green.review, specReviewer: "" } },
  ];
  for (const evidence of cases) assert.equal(evaluateMerge(AGENTS_AFTER_CHECKS_AND_REVIEW, gh, evidence).allow, false, JSON.stringify(evidence));
  assert.equal(evaluateMerge(AGENTS_AFTER_CHECKS_AND_REVIEW, detectMerge("gh api -X PUT repos/o/r/pulls/1/merge"), green).allow, false);
});

test("evidence reads PR head, checks and the profile review record", () => {
  const env = profile();
  mkdirSync(join(env.PI_CODING_AGENT_DIR, "merge-reviews"));
  writeFileSync(join(env.PI_CODING_AGENT_DIR, "merge-reviews", `${SHA}.json`), JSON.stringify(green.review));
  const run = (cmd, args) => {
    assert.deepEqual([cmd, ...args], ["gh", "pr", "view", "12", "--json", "headRefOid,statusCheckRollup,author"]);
    return JSON.stringify({ headRefOid: SHA, author: { login: "evoclock" }, statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "PENDING" }] });
  };
  const evidence = gatherMergeEvidence("12", { run, env });
  assert.deepEqual(evidence.checks, [{ state: "SUCCESS" }, { state: "PENDING" }]);
  assert.equal(evidence.review.spec, "PASS");
  assert.equal(evidence.author, "evoclock");
  assert.match(gatherMergeEvidence("12", { run: () => { throw new Error("boom"); }, env }).error, /boom/);
});

for (const [label, ctx] of [["headless bot", HEADLESS], ["direct Pi use", TUI]]) {
  test(`guard applies the policy without a prompt in ${label}`, async () => {
    let prompted = false;
    const context = { ...ctx, sessionManager: { getSessionId: () => "merger-1" }, ui: { confirm: async () => { prompted = true; return true; } } };
    const human = await guardToolCall(merge("gh pr merge 12"), context, { context, loadMergePolicy: () => ({ policy: HUMAN_MERGES_ONLY, source: "default" }) });
    assert.equal(human.block, true);
    assert.match(human.reason, /needs-owner-approval: .*human-merges-only, default/);
    const agents = { context, loadMergePolicy: () => ({ policy: AGENTS_AFTER_CHECKS_AND_REVIEW, source: "config" }) };
    assert.equal(await guardToolCall(merge("gh pr merge 12"), context, { ...agents, gatherMergeEvidence: () => greenFromGithub }), undefined);
    const self = await guardToolCall(merge("gh pr merge 12"), context, { ...agents, gatherMergeEvidence: () => ({ ...greenFromGithub, review: { ...green.review, recordedBySession: "merger-1" } }) });
    assert.match(self.reason, /recorded by the merging session/);
    const admin = await guardToolCall(merge("gh pr merge 12 --admin"), context, { ...agents, gatherMergeEvidence: () => greenFromGithub });
    assert.match(admin.reason, /refused under every merge policy: --admin/);
    const red = await guardToolCall(merge("gh pr merge 12"), context, { ...agents, gatherMergeEvidence: () => ({ ...green, checks: [{ state: "FAILURE" }] }) });
    assert.match(red.reason, /needs-owner-approval: .*have not passed/);
    assert.equal(prompted, false);
  });
}

test("non-merge commands keep the existing guard behaviour", async () => {
  const blocked = await guardToolCall(merge("git push origin x"), HEADLESS, { context: HEADLESS, loadMergePolicy: () => { throw new Error("must not load"); } });
  assert.equal(blocked.block, true);
  assert.equal(await guardToolCall(merge("gh pr view 12"), HEADLESS, { context: HEADLESS }), undefined);
});

test("bypass forms are refused under both policy values", () => {
  for (const command of [
    "gh pr merge 12 --admin",
    "gh pr merge 12 --squash --admin",
    "gh pr merge 12 --auto",
    "gh pr merge 12 --auto --admin",
    "gh api -X PUT repos/o/r/branches/main/protection --input p.json",
    "gh api -X DELETE repos/o/r/branches/main/protection/enforce_admins",
    "gh api --method POST repos/o/r/rulesets -f name=x",
    "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{})}'",
    "gh api graphql -f query='mutation{mergeBranch(input:{})}'",
    "gh api graphql -f query='mutation{updateBranchProtectionRule(input:{})}'",
  ]) {
    const detection = detectMerge(command);
    assert.equal(detection.form, "bypass", command);
    for (const policy of [HUMAN_MERGES_ONLY, AGENTS_AFTER_CHECKS_AND_REVIEW]) {
      const decision = evaluateMerge(policy, detection, green);
      assert.equal(decision.allow, false, `${policy}: ${command}`);
      assert.match(decision.reason, /every merge policy/);
    }
  }
  assert.equal(detectMerge("gh api repos/o/r/branches/main/protection").merge, false);
  assert.equal(detectMerge("gh api repos/o/r/rulesets").merge, false);
});

test("review record tool validates and writes only verdicts for a full SHA", async () => {
  const ids = { standardsReviewer: "rev-a", specReviewer: "rev-b", recordedBySession: "coord-2" };
  assert.equal(reviewRecord({ ...ids, headSha: "abc", standards: "PASS", spec: "PASS" }).ok, false);
  assert.equal(reviewRecord({ ...ids, headSha: SHA, standards: "OK", spec: "PASS" }).ok, false);
  assert.equal(reviewRecord({ ...ids, headSha: SHA, standards: "PASS", spec: "PASS", specReviewer: "" }).ok, false);
  assert.equal(reviewRecord({ ...ids, headSha: SHA, standards: "PASS", spec: "PASS", recordedBySession: "" }).ok, false);
  assert.match(reviewRecord({ ...ids, headSha: SHA, standards: "PASS", spec: "PASS", standardsReviewer: "coord-2" }).reason, /own review/);
  const writes = [];
  const tools = [];
  registerAttendedAuthorityGuard({ on() {}, registerTool: (t) => tools.push(t) }, { writeReviewRecord: (p, text) => writes.push([p, text]) });
  const tool = tools.find((t) => t.name === "agentic_merge_review_record");
  const host = { sessionManager: { getSessionId: () => "coord-2" } };
  const result = await tool.execute("id", { headSha: SHA, standards: "PASS", spec: "PASS", standardsReviewer: "rev-a", specReviewer: "rev-b" }, undefined, undefined, host);
  assert.equal(result.details.recorded, true);
  assert.equal(result.details.recordedBySession, "coord-2");
  const self = await tool.execute("id", { headSha: SHA, standards: "PASS", spec: "PASS", standardsReviewer: "coord-2", specReviewer: "rev-b" }, undefined, undefined, host);
  assert.equal(self.details.recorded, false);
  const noSession = await tool.execute("id", { headSha: SHA, standards: "PASS", spec: "PASS", standardsReviewer: "rev-a", specReviewer: "rev-b" }, undefined, undefined, {});
  assert.equal(noSession.details.recorded, false);
  assert.match(writes[0][0], new RegExp(`merge-reviews/${SHA}\\.json$`));
  assert.equal(JSON.parse(writes[0][1]).spec, "PASS");
});
