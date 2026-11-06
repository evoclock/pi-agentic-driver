import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as guard from "../scripts/enforcement/attended_authority_guard.js";

const schema = "pi-agentic-driver.interactive-safeguards.v1";
const defaults = { enableAllInteractiveConfirmations: false, enabledCommands: [] };
const config = (settings) => ({ schema, ...settings });
const event = (command) => ({ toolName: "bash", input: { command } });
const loaded = (settings = defaults, source = "config") => ({ settings, source });
const opts = (settings = defaults, source = "config") => ({ loadInteractiveSafeguards: () => loaded(settings, source) });
const tui = (answer = false) => {
  const calls = [];
  return { calls, context: { mode: "tui", hasUI: true, ui: {
    confirm: async (...args) => { calls.push(args); return answer; },
    notify: async (...args) => calls.push(args),
  } } };
};

// Why: no profile means no interactive guard, even when a destructive call is headless.
test("missing configuration leaves interactive confirmations off", async () => {
  const { context, calls } = tui();
  const options = opts(defaults, "default");
  assert.equal(await guard.guardToolCall(event("git push origin main"), context, options), undefined);
  assert.equal(await guard.guardToolCall(event("git push origin main"), { mode: "rpc" }, options), undefined);
  assert.equal(calls.length, 0);
});

// Why: global opt-in restores attended confirmation and headless refusal, not forbidden operations.
test("package-wide enable prompts for bash and writes, and refuses headless calls", async () => {
  const { context, calls } = tui();
  const options = { ...opts({ enableAllInteractiveConfirmations: true, enabledCommands: [] }),
    loadMergePolicy: () => ({ policy: "human-merges-only", source: "fixture" }) };
  for (const input of [event("git push origin main"), { toolName: "write", input: { path: ".env" } }]) {
    assert.equal((await guard.guardToolCall(input, context, options)).block, true);
  }
  assert.equal(calls.length, 2);
  assert.match((await guard.guardToolCall(event("git push origin main"), { mode: "rpc" }, options)).reason, /fail-closed/);
  assert.equal((await guard.guardToolCall(event("herdr agent list"), context, options)).block, true);
  assert.equal((await guard.guardToolCall(event("gh pr merge 123"), context, options)).block, true);
  assert.equal((await guard.guardToolCall(event("cat approvals/ledger.json"), context, options)).block, true);
  assert.equal(calls.length, 2);
});

// Why: each named command opts in individually; one enabled prefix must not enable unrelated operations.
for (const [name, command] of [
  ["git push", "git push --force origin main"],
  ["git reset", "git reset --hard HEAD"],
  ["git clean", "git clean -fd"],
  ["git restore", "git restore file.txt"],
  ["git rebase", "git rebase main"],
]) {
  test(`individual enable: ${name}`, async () => {
    const { context, calls } = tui();
    const options = opts({ enableAllInteractiveConfirmations: false, enabledCommands: [name] });
    assert.equal((await guard.guardToolCall(event(command), context, options)).block, true);
    assert.equal(await guard.guardToolCall(event("git stash pop"), context, options), undefined);
    assert.equal(calls.length, 1);
  });
}

// Why: match only a simple invocation, and allow tool-specific opt-ins without enabling everything.
test("per-command enable rejects compound syntax and can select write/edit", async () => {
  const { context, calls } = tui();
  const options = opts({ enableAllInteractiveConfirmations: false, enabledCommands: ["git push", "write"] });
  assert.equal((await guard.guardToolCall(event('git "push" origin main'), context, options)).block, true);
  assert.equal(await guard.guardToolCall(event("git push origin main && git reset --hard HEAD"), context, options), undefined);
  assert.equal(await guard.guardToolCall(event("git push origin main > log.txt"), context, options), undefined);
  assert.equal((await guard.guardToolCall({ toolName: "write", input: { path: ".env" } }, context, options)).block, true);
  assert.equal(await guard.guardToolCall({ toolName: "edit", input: { path: ".env" } }, context, options), undefined);
  assert.equal(calls.length, 2);
});

// Why: agents must not silently edit an opted-in profile or any other profile config file.
test("profile config write/edit is blocked regardless of opt-in or target existence", async () => {
  const profileEnv = { PI_CODING_AGENT_DIR: "/fixture/profile" };
  const { context, calls } = tui(true);
  for (const settings of [defaults, { enableAllInteractiveConfirmations: true, enabledCommands: [] }]) {
    for (const toolName of ["write", "edit"]) {
      for (const path of [
        "/fixture/profile/config/interactive-safeguards.v1.json",
        "/fixture/profile/config/other.json",
        "/fixture/profile/config/../config/interactive-safeguards.v1.json",
      ]) {
        const result = await guard.guardToolCall({ toolName, input: { path } }, context,
          { ...opts(settings), profileEnv, existsSync: () => false });
        assert.equal(result.block, true, `${toolName}: ${path}`);
        assert.match(result.reason, /user profile config writes/);
      }
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(await guard.guardToolCall({ toolName: "write", input: { path: "/fixture/profile/config-next/file.json" } }, context,
    { ...opts(defaults), profileEnv }), undefined);
});

// Why: malformed or old disable settings cannot activate the new guard or leak config content.
test("invalid settings keep the opt-in off and warn without exposing profile text", async () => {
  const missing = guard.loadInteractiveSafeguards({ env: { PI_CODING_AGENT_DIR: "/fixture" }, read: () => {
    const error = new Error("missing"); error.code = "ENOENT"; throw error;
  } });
  assert.equal(missing.source, "default");
  const { context, calls } = tui();
  for (const data of [
    { enableAllInteractiveConfirmations: "true" },
    { enabledCommands: "git push" },
    { enabledCommands: ["git push; rm -rf"] },
    { enabledCommands: ["git push", "git push"] },
    { disableAllInteractiveConfirmations: true },
  ]) {
    const result = guard.loadInteractiveSafeguards({ env: { PI_CODING_AGENT_DIR: "/fixture" }, read: () => JSON.stringify(config(data)) });
    assert.equal(result.source, "invalid");
    assert.equal(await guard.guardToolCall(event("git push origin main"), context, { loadInteractiveSafeguards: () => result }), undefined);
  }
  assert.equal(calls.length, 5);
  assert.ok(calls.every((args) => args[1] === "warning" && !String(args).includes("rm -rf")));
});

// Why: the packaged template must not turn on the guard without a deliberate user edit.
test("shipped example keeps confirmation off", () => {
  const file = process.env.SAFEGUARD_CONFIG_FILE || fileURLToPath(new URL("../config/interactive-safeguards.v1.example.json", import.meta.url));
  const text = existsSync(file) ? readFileSync(file, "utf8") : JSON.stringify(config({ enableAllInteractiveConfirmations: true }));
  const result = guard.loadInteractiveSafeguards({ env: { PI_CODING_AGENT_DIR: "/fixture" }, read: () => text });
  assert.equal(result.source, "config");
  assert.equal(result.settings.enableAllInteractiveConfirmations, false);
});

// Why: model-supplied fields cannot change the user profile's opt-in setting.
test("registered handler ignores model-supplied enable flags", async () => {
  let handler;
  const pi = { on: (name, callback) => { if (name === "tool_call") handler = callback; }, registerTool() {} };
  guard.registerAttendedAuthorityGuard(pi, opts(defaults, "default"));
  const { context, calls } = tui();
  assert.equal(await handler({ ...event("git push origin main"), input: { command: "git push origin main", enableAllInteractiveConfirmations: true } }, context), undefined);
  assert.equal(calls.length, 0);
});
