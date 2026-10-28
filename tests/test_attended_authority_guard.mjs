import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBashCommand,
  classifyWriteCall,
  guardToolCall,
  registerAttendedAuthorityGuard,
  GUARD_SCHEMA,
  recordDecisionEvidence,
} from "../scripts/enforcement/attended_authority_guard.js";
import { isNativeTuiContext } from "../scripts/enforcement/native_tui_context.js";

const TUI = {
  mode: "tui",
  hasUI: true,
  ui: { confirm: async () => true },
};

test("safe reads, builds, and tests pass through", () => {
  for (const command of [
    "cat README.md",
    "ls -la",
    "grep -rn guard src",
    "node --check extensions/code-phage.js",
    "node --test tests/test_attended_authority_guard.mjs",
    "npm test",
    "git status",
    "git log --oneline -3",
    "git diff",
    "python3 -m pytest tests/",
    "make build",
  ]) {
    assert.deepEqual(classifyBashCommand(command), { destructive: false }, command);
  }
});

test("destructive shell operations are classified", () => {
  for (const [command, kind] of [
    ["rm -rf build/", "recursive or forced file deletion"],
    ["rm -f notes.txt", "recursive or forced file deletion"],
    ["dd if=/dev/zero of=disk", "irreversible disk or file operation"],
    ["echo hi > existing.txt", "file overwrite via redirection to existing.txt"],
  ]) {
    const verdict = classifyBashCommand(command);
    assert.equal(verdict.destructive, true, command);
    assert.equal(verdict.kind, kind, command);
  }
});

test("destructive Git operations are classified", () => {
  for (const [command, kind] of [
    ["git push --force origin main", "forced Git push"],
    ["git push origin main", "Git push"],
    ["git reset --hard HEAD~1", "hard Git reset"],
    ["git clean -fd", "Git clean"],
    ["git stash drop", "Git stash mutation"],
    ["git rebase -i main", "Git history rewrite"],
    ["git commit --amend", "Git history rewrite"],
    ["git branch -D feat/x", "protected branch deletion"],
  ]) {
    const verdict = classifyBashCommand(command);
    assert.equal(verdict.destructive, true, command);
    assert.equal(verdict.kind, kind, command);
  }
});

test("a destructive payload cannot hide behind a safe prefix", () => {
  assert.equal(classifyBashCommand("git status && rm -rf /").destructive, true);
  assert.equal(classifyBashCommand("cat f | rm -rf x").destructive, true);
});

test("quoted destructive tokens are still classified (F1 regression)", () => {
  assert.equal(classifyBashCommand("rm '-rf' build/").destructive, true);
  assert.equal(classifyBashCommand('git "push" origin main').destructive, true);
  assert.equal(classifyBashCommand("rm '-rf' build/").kind, "recursive or forced file deletion");
  assert.equal(classifyBashCommand('git "push" origin main').kind, "Git push");
});

test("embedded and split quoting cannot hide destructive tokens", () => {
  assert.equal(classifyBashCommand("r'm' '-rf' build/").destructive, true);
  assert.equal(classifyBashCommand('git pu"sh" origin main').destructive, true);
  assert.equal(classifyBashCommand("\\rm -rf build/").destructive, true);
});

test("arbitrary-code interpreter forms are classified even when quoted (F1 regression)", () => {
  assert.equal(classifyBashCommand("node '-e' 'process.exit(1)'").destructive, true);
  assert.equal(classifyBashCommand('node --eval "1+1"').destructive, true);
  assert.equal(classifyBashCommand("python3 '-c' 'print(1)'").destructive, true);
  assert.equal(classifyBashCommand("npx some-unpublished-pkg").destructive, true);
});

test("scope: plain rm and non-push git reads are not guard targets", () => {
  // Plain `rm file` (no -r/-f) is intentionally outside the guard's scope:
  // the guard targets recursive/forced deletion and irreversible operations.
  assert.equal(classifyBashCommand("rm build/log.txt").destructive, false);
  // Conservative git-push policy: every push, forced or not, is destructive.
  assert.equal(classifyBashCommand("git push origin main").kind, "Git push");
  assert.equal(classifyBashCommand("git push --force origin main").kind, "forced Git push");
});

test("arbitrary-code interpreters are no longer safe prefixes (F1 regression)", () => {
  assert.equal(classifyBashCommand("node -e 'require(\"fs\").rmSync(\"x\", {recursive: true})'").destructive, true);
  assert.equal(classifyBashCommand("python3 -c 'import shutil; shutil.rmtree(\"x\")'").destructive, true);
  assert.equal(classifyBashCommand("npx some-unpublished-pkg").destructive, true);
});

test("write over an existing file is destructive; new file is not", () => {
  const exists = () => true;
  const missing = () => false;
  assert.equal(classifyWriteCall("write", { path: "a.txt" }, exists).destructive, true);
  assert.equal(classifyWriteCall("write", { path: "a.txt" }, missing).destructive, false);
  assert.equal(classifyWriteCall("edit", { path: ".env" }, exists).destructive, true);
  assert.equal(classifyWriteCall("read", { path: ".env" }, exists).destructive, false);
});

test("raw herdr agent start is forbidden fail-closed (no confirm)", async () => {
  for (const command of [
    "herdr agent start worker --kind pi --pane w1:p1 -- --model openai-codex/example-route",
    "/opt/homebrew/bin/herdr agent start foo --kind pi --pane w1:p2",
    "herdr agent start role-name",
    "env FOO=1 herdr agent start x --kind pi --pane w1:p1",
  ]) {
    const verdict = classifyBashCommand(command);
    assert.equal(verdict.destructive, true, command);
    assert.equal(verdict.forbidden, true, command);
    assert.match(verdict.kind, /raw herdr CLI/);
  }
  assert.equal(classifyBashCommand("herdr agent list").forbidden, true);
  assert.equal(classifyBashCommand("herdr pane list").forbidden, true);

  const tui = {
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => true },
  };
  const blocked = await guardToolCall(
    { toolName: "bash", input: { command: "herdr agent start x --kind pi --pane w1:p1" } },
    tui,
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /forbidden/);
  assert.match(blocked.reason, /agentic_herdr_spawn_worker/);
});

test("raw herdr terminal control and communication are forbidden without confirmation", async () => {
  for (const command of [
    "herdr agent prompt worker 'do this'",
    "herdr agent read worker",
    "herdr agent wait worker",
    "herdr agent send worker hello",
    "herdr pane send-keys w1:p1 Enter",
    "herdr pane read w1:p1",
    "env X=1 /opt/bin/herdr agent prompt worker hi",
    "herdr agent 'prompt' worker hi",
  ]) {
    const verdict = classifyBashCommand(command);
    assert.equal(verdict.forbidden, true, command);
    const result = await guardToolCall({ toolName: "bash", input: { command } }, TUI);
    assert.equal(result?.block, true, command);
  }
});

test("headless contexts refuse destructive operations fail-closed", async () => {
  const result = await guardToolCall(
    { toolName: "bash", input: { command: "git reset --hard" } },
    { mode: "rpc" },
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /fail-closed/);
  assert.ok(result.reason.includes(GUARD_SCHEMA));
});

test("native confirmation allows, denial blocks with a clear reason", async () => {
  const event = { toolName: "bash", input: { command: "git push --force" } };
  const allow = await guardToolCall(event, TUI);
  assert.equal(allow, undefined);

  const denying = {
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => false },
  };
  const blocked = await guardToolCall(event, denying);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /denied by user/);
});

test("denial does not terminate or retry the session", async () => {
  let calls = 0;
  const denying = { mode: "tui", hasUI: true, ui: { confirm: async () => { calls += 1; return false; } } };
  const event = { toolName: "bash", input: { command: "git clean -fd" } };
  const first = await guardToolCall(event, denying);
  const second = await guardToolCall(event, denying);
  assert.equal(first.block, true);
  assert.equal(second.block, true);
  assert.equal(calls, 2); // each new call is judged independently, no hidden auto-retry
  assert.equal(first.terminate, undefined);
});

test("safe tool calls never reach confirmation", async () => {
  let asked = 0;
  const counting = { ...TUI, ui: { confirm: async () => { asked += 1; return true; } } };
  assert.equal(await guardToolCall({ toolName: "read", input: { path: "x" } }, counting), undefined);
  assert.equal(await guardToolCall({ toolName: "bash", input: { command: "ls" } }, counting), undefined);
  assert.equal(asked, 0);
});

test("coordinator relay cannot bypass native confirmation for irreversible operations", async () => {
  let confirmations = 0;
  const context = { mode: "tui", hasUI: true, ui: { confirm: async () => { confirmations += 1; return false; } } };
  const relay = { relayer: "coordinator", quote: "Build the change", where: "fixture.invalid/message/1", when: "fixture-time" };
  for (const command of ["git push origin main", "git push --force origin main", "rm -rf scratch/generated"]) {
    const result = await guardToolCall({ toolName: "bash", input: { command, approval: relay } }, context);
    assert.equal(result.block, true, command);
  }
  assert.equal(confirmations, 3);
  assert.equal(await guardToolCall({ toolName: "bash", input: { command: "git diff", approval: relay } }, context), undefined);
  assert.equal(confirmations, 3, "ordinary read must not introduce approval churn");
  const headless = await guardToolCall({ toolName: "bash", input: { command: "git push origin main", approval: relay } }, { mode: "rpc" });
  assert.equal(headless.block, true);
  assert.match(headless.reason, /fail-closed/);
  assert.equal(confirmations, 3, "headless relay must not invoke native confirmation");
  const protectedWrite = await guardToolCall({ toolName: "write", input: { path: ".env", approval: relay } }, { mode: "rpc" });
  assert.equal(protectedWrite.block, true, "relay metadata must not bypass a protected write");
  assert.match(protectedWrite.reason, /fail-closed/);
});

test("decision evidence records a sourced relay without asserting identity or irreversible authority", async () => {
  const quote = "Please draft and build the assigned change";
  const evidence = recordDecisionEvidence({ kind: "relay", quote, relayer: "coordinator", where: "session record", when: "2026-10-17T10:00:00Z" });
  assert.equal(evidence.recordable, true);
  assert.equal(evidence.quote, quote);
  assert.equal(evidence.identityVerified, false);
  assert.equal(evidence.irreversibleAuthority, false);
  for (const missing of ["quote", "relayer", "where", "when"]) {
    const input = { kind: "relay", quote, relayer: "coordinator", where: "session record", when: "2026-10-17T10:00:00Z" };
    delete input[missing];
    assert.equal(recordDecisionEvidence(input).recordable, false, missing);
  }
  assert.equal(recordDecisionEvidence({ kind: "peer", quote, where: "session", when: "now" }).recordable, false);
  const withoutEvidence = await guardToolCall({ toolName: "bash", input: { command: "git push origin main" } }, { mode: "rpc" });
  const withEvidence = await guardToolCall({ toolName: "bash", input: { command: "git push origin main", decisionEvidence: evidence } }, { mode: "rpc" });
  assert.deepEqual(withEvidence, withoutEvidence, "model-supplied evidence must not affect the push guard");
});

test("model-supplied authority fields cannot grant passage", async () => {
  const event = {
    toolName: "bash",
    input: { command: "git reset --hard", authority: "granted", approved: true },
  };
  const result = await guardToolCall(event, { mode: "rpc" });
  assert.equal(result.block, true);
});

test("registration wires a non-authorizing decision evidence tool exactly once", async () => {
  const handlers = [];
  const tools = [];
  const pi = { on: (name, fn) => handlers.push([name, fn]), registerTool: (tool) => tools.push(tool) };
  assert.deepEqual(registerAttendedAuthorityGuard(pi), { registered: true, schema: GUARD_SCHEMA });
  assert.deepEqual(registerAttendedAuthorityGuard(pi), undefined);
  assert.deepEqual(handlers.map(([name]) => name), ["tool_call"]);
  assert.deepEqual(tools.map(({ name }) => name), ["agentic_decision_evidence", "agentic_merge_review_record"]);
  const params = { kind: "relay", quote: "Build this", relayer: "coordinator", where: "session", when: "2026-10-17T10:00:00Z" };
  const valid = await tools[0].execute("id", params);
  assert.equal(valid.details.recordable, true);
  assert.equal(valid.details.authorityCreated, false);
  assert.equal(valid.details.identityVerified, false);
  const missingSource = await tools[0].execute("id", { ...params, where: "" });
  assert.equal(missingSource.details.recordable, false);
});

test("native TUI predicate stays shared and fail-closed", () => {
  assert.equal(isNativeTuiContext(undefined), false);
  assert.equal(isNativeTuiContext({ mode: "tui", hasUI: true }), false);
});
