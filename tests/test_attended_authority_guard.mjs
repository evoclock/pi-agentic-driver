import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBashCommand,
  classifyWriteCall,
  guardToolCall,
  registerAttendedAuthorityGuard,
  GUARD_SCHEMA,
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

test("model-supplied authority fields cannot grant passage", async () => {
  const event = {
    toolName: "bash",
    input: { command: "git reset --hard", authority: "granted", approved: true },
  };
  const result = await guardToolCall(event, { mode: "rpc" });
  assert.equal(result.block, true);
});

test("registration is idempotent and wires tool_call", () => {
  const handlers = [];
  const pi = { on: (name, fn) => handlers.push([name, fn]) };
  assert.deepEqual(registerAttendedAuthorityGuard(pi), { registered: true, schema: GUARD_SCHEMA });
  assert.deepEqual(registerAttendedAuthorityGuard(pi), undefined);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0][0], "tool_call");
});

test("native TUI predicate stays shared and fail-closed", () => {
  assert.equal(isNativeTuiContext(undefined), false);
  assert.equal(isNativeTuiContext({ mode: "tui", hasUI: true }), false);
});
