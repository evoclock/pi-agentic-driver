import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordApproval, checkRelayRequests } from "../scripts/enforcement/approval_ledger_pi.js";
import { executeHerdrSpawnWorker, executeHerdrRegisterRepository, registerHerdrLifecycleInterface } from "../scripts/enforcement/herdr_lifecycle_pi.js";
import { guardToolCall, needsOwner } from "../scripts/enforcement/attended_authority_guard.js";
const fixtureDir = resolve(fileURLToPath(new URL("./fixtures/relay-incident-2026-10-19/", import.meta.url)));
const names = ["alpha", "beta", "gamma", "agent-skill-vault"];
const model = "fixture/example";
const owner = "example-owner";
function setup() {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(join(process.cwd(), "scratch/incident-"));
  const coordinator = join(root, "coordinator");
  const profile = join(root, "profile");
  mkdirSync(coordinator); mkdirSync(join(profile, "config"), { recursive: true });
  for (const name of names) {
    const dir = join(root, name); mkdirSync(dir); execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${owner}/${name}.git`]);
  }
  writeFileSync(join(profile, "config/relay-authority.v1.json"), JSON.stringify({ githubOwner: owner, relayers: [{ relayer: "bot", channel: "chat", maxTier: 2 }], denyRepositories: ["vogelkop-*", "self-healing-swarm"] }));
  writeFileSync(join(coordinator, "config-placeholder"), "");
  writeFileSync(join(profile, "config/herdr-worker-repositories.v1.json"), JSON.stringify({ schema: "agentic-driver.herdr-worker-repositories.v1", repositories: names.slice(0, 3) }));
  const log = join(root, "herdr.log");
  process.env.PI_CODING_AGENT_DIR = profile; process.env.HERDR_PANE_ID = "w1:p0"; process.env.FAKE_HERDR_LOG = log;
  const fake = join(root, "fake-herdr.mjs");
  writeFileSync(fake, readFileSync(join(fixtureDir, "fake-herdr.mjs"))); chmodSync(fake, 0o755);
  const context = { cwd: coordinator, hasUI: false };
  const options = {
    testExecutablePath: fake,
    listModels: "provider model\nfixture example\nfixture other\n",
    modelsPath: join(root, "absent-models"),
    routePolicy: {
      schema: "agentic-driver.model-route-policy.v1",
      routes: ["example", "other"].map((name) => ({
        provider: "fixture", model: name, family: name, subscription: true, gateway: false, aliases: [],
      })),
      bannedPairs: [],
      budgets: {},
    },
  };
  const approval = (name, tier = 1, action = "spawn") => ({ kind: "relay", relayer: "bot", channel: "chat", sourceMessageId: name, quote: `Approve ${action} ${name}`, quotedQuestion: `May I ${action} ${name}?`, givenAt: new Date(Date.now() - 1000).toISOString(), tier, scope: { repo: name, actions: [action], models: [model], roles: [name] } });
  return { root, profile, log, context, options, approval };
}
const params = (name, ledgerId) => ({ placement: "tab", role: name, model, repository: name, ...(ledgerId ? { authority: { ledgerId } } : {}) });
test("relay preflight is registered and returns per-action owner requests", async () => {
  const f = setup(); const tools = new Map();
  registerHerdrLifecycleInterface({ registerTool(tool) { tools.set(tool.name, tool); } });
  assert.ok(tools.has("agentic_relay_check_request"));
  const result = await tools.get("agentic_relay_check_request").execute("fixture", { header: "no header", requests: [{ tier: 1, repository: "alpha", action: "spawn" }] });
  assert.match(JSON.stringify(result), /needs-owner/);
});
test("incident A: missing approvals yield four relayable refusals without Herdr mutation", async () => {
  const f = setup();
  const request = readFileSync(join(fixtureDir, "request.txt"), "utf8");
  assert.doesNotMatch(request, /^\[relay:v1 ledger=/);
  const results = checkRelayRequests(f.profile, request.split("\n")[0], names.map((name) => ({ tier: name === "agent-skill-vault" ? 2 : 1, repository: name, action: name === "agent-skill-vault" ? "register" : "spawn", model, role: name })));
  assert.equal(results.length, 4);
  assert.ok(results.every((result) => result.status === "needs-owner" && result.relayablePhrase));
  assert.equal(existsSync(f.log) ? readFileSync(f.log, "utf8").includes('"tab","create"') : false, false);
});
test("incident B: four scoped approvals and Tier 2 registry onboarding permit four tabs", async () => {
  const f = setup(); const approvals = [];
  const registry = await recordApproval(f.profile, f.approval("agent-skill-vault", 2, "register"));
  const onboard = await executeHerdrRegisterRepository({ name: "agent-skill-vault", ledgerId: registry.id }, f.context, { runGh: () => ({ status: 0, stdout: JSON.stringify({ nameWithOwner: `${owner}/agent-skill-vault`, visibility: "PRIVATE" }) }) });
  assert.equal(onboard.status, "registered", JSON.stringify(onboard));
  assert.equal(readdirSync(join(f.profile, "config")).filter((item) => item.endsWith(".bak")).length, 1);
  assert.match(readFileSync(join(f.profile, "approvals/uses.v1.jsonl"), "utf8"), /"result":"registered"/);
  for (const name of names) approvals.push(await recordApproval(f.profile, f.approval(name)));
  const checked = checkRelayRequests(f.profile, `[relay:v1 ledger=${approvals.map((entry) => entry.id).join(",")} relayer=bot]`, names.map((name) => ({ tier: 1, repository: name, action: "spawn", model, role: name })));
  assert.ok(checked.every((result) => result.status === "covered"));
  let confirmations = 0;
  f.context.mode = "tui"; f.context.hasUI = true;
  f.context.ui = { confirm: () => { confirmations++; return true; } };
  for (let i = 0; i < names.length; i++) {
    const result = await executeHerdrSpawnWorker(params(names[i], approvals[i].id), f.context, f.options);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(confirmations, 0);
  assert.equal(readFileSync(f.log, "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((argv) => argv[0] === "tab" && argv[1] === "create").length, 4);
  assert.equal(readFileSync(join(f.profile, "approvals/uses.v1.jsonl"), "utf8").split("\n").filter((line) => line.includes('"result":"spawned"')).length, 4);
  assert.equal(await guardToolCall({ toolName: "bash", input: { command: "git rm scoped-file.txt" } }, f.context), undefined);
  const body = join(f.root, "pr-body.md");
  writeFileSync(body, "## What changed\nI simplified the private review.\n\n## Why\nI want approved work to proceed.\n\n## How verified\nI checked the behavior.\n\n## Notes for agents\n- Keep the scoped approval with the request.\n");
  const lint = spawnSync("python3", [join(process.cwd(), "skills/public-pr-wording/pr_wording_lint.py"), "--title", "Improve the private review flow", "--body-file", body], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});
test("scoped approval passes through to the worker without a second confirmation", async () => {
  const f = setup();
  const entry = await recordApproval(f.profile, f.approval("alpha"));
  assert.equal(f.context.hasUI, false);
  assert.equal(f.context.ui, undefined);
  const result = await executeHerdrSpawnWorker(params("alpha", entry.id), f.context, f.options);
  assert.equal(result.status, "spawned", JSON.stringify(result));
  assert.equal(result.authorityCreated, false);
  assert.equal(JSON.parse(readFileSync(f.log, "utf8").split("\n").find((line) => line.includes('"tab","create"')))[2], "--workspace");
  assert.match(readFileSync(join(f.profile, "approvals/uses.v1.jsonl"), "utf8"), /"result":"spawned"/);
});
test("headless spawn without authority keeps native confirmation refusal", async () => {
  const f = setup();
  const result = await executeHerdrSpawnWorker(params("alpha"), f.context, f.options);
  assert.equal(result.code, "native_confirmation_required");
  assert.equal(existsSync(f.log), false);
});
test("valid authority does not bypass registry, realpath, worktree or Git common-dir checks", async () => {
  for (const kind of ["unregistered", "symlink", "worktree", "external-common"]) {
    const f = setup();
    const name = kind === "unregistered" ? "agent-skill-vault" : kind === "symlink" ? "linked" : kind === "worktree" ? "detached" : "external-common";
    if (kind === "symlink") symlinkSync(join(f.root, "alpha"), join(f.root, name));
    if (kind === "worktree") {
      execFileSync("git", ["-C", join(f.root, "alpha"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
      execFileSync("git", ["-C", join(f.root, "alpha"), "worktree", "add", "-q", "-b", "fixture-branch", join(f.root, name)]);
    }
    if (kind === "external-common") {
      const target = join(f.root, name);
      execFileSync("git", ["init", "-q", target]);
      writeFileSync(join(target, ".git/commondir"), join(f.root, "alpha/.git"));
      const common = execFileSync("git", ["-C", target, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
      assert.notEqual(resolve(target, common), join(target, ".git"));
      assert.equal(execFileSync("git", ["-C", target, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), target);
    }
    if (kind !== "unregistered") {
      const file = join(f.profile, "config/herdr-worker-repositories.v1.json");
      const registry = JSON.parse(readFileSync(file, "utf8"));
      registry.repositories.push(name);
      writeFileSync(file, JSON.stringify(registry));
    }
    const entry = await recordApproval(f.profile, f.approval(name));
    const result = await executeHerdrSpawnWorker(params(name, entry.id), f.context, f.options);
    assert.equal(result.ok, false, `${kind}: ${JSON.stringify(result)}`);
    assert.ok(["repository_untrusted", "repository_not_git_root"].includes(result.code), `${kind}: ${JSON.stringify(result)}`);
    assert.equal(existsSync(f.log), false, `${kind}: Herdr must not be called`);
    const uses = join(f.profile, "approvals/uses.v1.jsonl");
    assert.equal(existsSync(uses), false, `${kind}: no use or reservation is recorded`);
  }
});
test("spawn scope mismatch refuses without layout mutation", async () => {
  const f = setup();
  const entry = await recordApproval(f.profile, f.approval("alpha"));
  for (const mismatch of [{ repository: "beta" }, { model: "fixture/other" }, { role: "other" }]) {
    const result = await executeHerdrSpawnWorker({ ...params("alpha", entry.id), ...mismatch }, f.context, f.options);
    assert.equal(result.status, "needs-owner", JSON.stringify(result));
  }
  assert.equal(existsSync(f.log) ? readFileSync(f.log, "utf8").includes('"tab","create"') : false, false);
});
test("incident C: merge remains Tier 3 despite relay", async () => {
  const f = setup();
  const entry = await recordApproval(f.profile, f.approval("agent-skill-vault"));
  const [result] = checkRelayRequests(f.profile, `[relay:v1 ledger=${entry.id} relayer=bot]`, [{ tier: 3, repository: "agent-skill-vault", action: "merge #14" }]);
  assert.equal(result.status, "needs-owner"); assert.equal(result.tier, 3);
  assert.equal(existsSync(f.log), false);
});
test("registration rejects missing authority, denied names, foreign ownership and public visibility", async () => {
  const f = setup();
  const register = (name, ledgerId, response) => executeHerdrRegisterRepository({ name, ledgerId }, f.context, { runGh: () => ({ status: 0, stdout: JSON.stringify(response) }) });
  assert.equal((await register("agent-skill-vault", "missing", { nameWithOwner: `${owner}/agent-skill-vault`, visibility: "PRIVATE" })).status, "needs-owner");
  const entry = await recordApproval(f.profile, f.approval("agent-skill-vault", 2, "register"));
  assert.equal((await register("agent-skill-vault", entry.id, { nameWithOwner: "other/agent-skill-vault", visibility: "PRIVATE" })).status, "needs-owner");
  assert.equal((await register("agent-skill-vault", entry.id, { nameWithOwner: `${owner}/agent-skill-vault`, visibility: "PUBLIC" })).tier, 3);
  assert.equal((await register("self-healing-swarm", entry.id, { nameWithOwner: `${owner}/self-healing-swarm`, visibility: "PRIVATE" })).status, "needs-owner");
  assert.equal((await register("Vogelkop-test", entry.id, { nameWithOwner: `${owner}/Vogelkop-test`, visibility: "PRIVATE" })).status, "needs-owner");
  assert.equal((await register("vogelkop-test", entry.id, { nameWithOwner: `${owner}/vogelkop-test`, visibility: "PRIVATE" })).tier, 3);
});
test("registration refuses a missing configured GitHub owner before mutation", async () => {
  const f = setup();
  const file = join(f.profile, "config/relay-authority.v1.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  delete config.githubOwner;
  writeFileSync(file, JSON.stringify(config));
  const entry = await recordApproval(f.profile, f.approval("agent-skill-vault", 2, "register"));
  const result = await executeHerdrRegisterRepository({ name: "agent-skill-vault", ledgerId: entry.id }, f.context);
  assert.equal(result.status, "needs-owner");
  assert.match(result.reason, /configured GitHub owner/);
  assert.equal(existsSync(join(f.profile, "approvals/uses.v1.jsonl")), false);
  assert.equal(existsSync(f.log), false);
});
test("registration rejects a worktree and an out-of-scope approval", async () => {
  const f = setup();
  const detached = join(f.root, "detached");
  execFileSync("git", ["-C", join(f.root, "alpha"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  execFileSync("git", ["-C", join(f.root, "alpha"), "worktree", "add", "-q", "-b", "fixture-branch", detached]);
  const entry = await recordApproval(f.profile, f.approval("detached", 2, "register"));
  const response = { runGh: () => ({ status: 0, stdout: JSON.stringify({ nameWithOwner: `${owner}/detached`, visibility: "PRIVATE" }) }) };
  assert.equal((await executeHerdrRegisterRepository({ name: "detached", ledgerId: entry.id }, f.context, response)).status, "needs-owner");
  const wrong = await recordApproval(f.profile, f.approval("alpha", 2, "register"));
  assert.equal((await executeHerdrRegisterRepository({ name: "beta", ledgerId: wrong.id }, f.context, response)).status, "needs-owner");
});
test("concurrent registration keeps one registry entry", async () => {
  const f = setup();
  const entry = await recordApproval(f.profile, f.approval("agent-skill-vault", 2, "register"));
  const options = { runGh: () => ({ status: 0, stdout: JSON.stringify({ nameWithOwner: `${owner}/agent-skill-vault`, visibility: "PRIVATE" }) }) };
  const results = await Promise.all([
    executeHerdrRegisterRepository({ name: "agent-skill-vault", ledgerId: entry.id }, f.context, options),
    executeHerdrRegisterRepository({ name: "agent-skill-vault", ledgerId: entry.id }, f.context, options),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["already-registered", "registered"]);
  const registry = JSON.parse(readFileSync(join(f.profile, "config/herdr-worker-repositories.v1.json"), "utf8"));
  assert.equal(registry.repositories.filter((name) => name === "agent-skill-vault").length, 1);
});
test("registration rejects a symlinked sibling", async () => {
  const f = setup();
  symlinkSync(join(f.root, "alpha"), join(f.root, "linked"));
  const entry = await recordApproval(f.profile, f.approval("linked", 2, "register"));
  assert.equal((await executeHerdrRegisterRepository({ name: "linked", ledgerId: entry.id }, f.context)).status, "needs-owner");
});
test("refusals remain relayable without directing the owner to a machine", async () => {
  const f = setup();
  const spawn = await executeHerdrSpawnWorker(params("alpha", "missing"), f.context, f.options);
  const register = await executeHerdrRegisterRepository({ name: "self-healing-swarm", ledgerId: "missing" }, f.context);
  const bash = await guardToolCall({ toolName: "bash", input: { command: "cat approvals/head.v1.json" } }, f.context);
  for (const result of [spawn, register, needsOwner(1, ["spawn"], "alpha"), bash]) {
    assert.equal(result.status, "needs-owner", JSON.stringify(result));
    assert.ok(result.relayablePhrase);
    assert.doesNotMatch(JSON.stringify(result), /instruct me directly|come to the machine/i);
  }
  assert.match(bash.reason, /agentic_relay_check_request/);
});
test("a repository-only ledger grant does not cover a new worktree target", async () => {
  const f = setup();
  const repo = join(f.root, "alpha");
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
  const target = join(f.root, "pool", "slot", "alpha");
  mkdirSync(join(f.root, "pool", "slot"), { recursive: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "slot", target]);
  const leaseId = "0123456789abcdef0123456789abcdef";
  f.options.treehouseStatus = () => JSON.stringify([{ name: "1", path: target, status: "leased", lease_id: leaseId, lease_holder: "fixture" }]);
  // This grant names repository, action, model and role, but no path. It must
  // never be inferred to cover the unrecorded worktree target.
  const repoOnly = await recordApproval(f.profile, f.approval("alpha"));
  const refused = await executeHerdrSpawnWorker({ ...params("alpha", repoOnly.id), worktreePath: target }, f.context, f.options);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, "approval_missing");
  assert.equal(refused.status, "needs-owner");
  const log = existsSync(f.log) ? readFileSync(f.log, "utf8") : "";
  assert.equal(log.includes('"tab","create"'), false, "no layout mutation under an unbound grant");

  // A grant that records the exact target path does cover it.
  const pathBound = await recordApproval(f.profile, {
    ...f.approval("alpha"),
    scope: { ...f.approval("alpha").scope, paths: [target] },
  });
  const accepted = await executeHerdrSpawnWorker({ ...params("alpha", pathBound.id), worktreePath: target }, f.context, f.options);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.worktreePath, target);
  assert.equal(accepted.leaseId, leaseId);
});
for (const revokedAuthority of ["lease", "registry"]) {
  test(`${revokedAuthority} revocation during final approval writer-lock wait preserves agent_started partial`, async () => {
    const f = setup();
    const repo = join(f.root, "alpha");
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
    const target = join(f.root, "pool", "slot", "alpha");
    mkdirSync(join(f.root, "pool", "slot"), { recursive: true });
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "slot", target]);
    let leased = true;
    f.options.treehouseStatus = () => JSON.stringify(leased
      ? [{ path: target, status: "leased", lease_id: "0123456789abcdef0123456789abcdef" }]
      : []);
    const grant = await recordApproval(f.profile, {
      ...f.approval("alpha"),
      scope: { ...f.approval("alpha").scope, paths: [target] },
    });
    const lock = join(f.profile, "approvals/writer.lock");
    const uses = join(f.profile, "approvals/uses.v1.jsonl");
    let revoked = false;
    let auditPendingWhenRevoked = false;
    f.options.runProcess = (spec) => {
      const stdout = execFileSync(spec.executable, spec.argv, { ...spec.spawnOptions, encoding: "utf8" });
      if (spec.argv[0] === "pane" && spec.argv[1] === "get") {
        // Hold the synthetic writer lock across the final synchronous check.
        // The timer runs only once the awaited audit write yields on the lock.
        writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        setTimeout(() => {
          auditPendingWhenRevoked = existsSync(lock)
            && !readFileSync(uses, "utf8").includes('"result":"spawned"');
          if (revokedAuthority === "lease") leased = false;
          else {
            const registryPath = join(f.profile, "config/herdr-worker-repositories.v1.json");
            const registry = JSON.parse(readFileSync(registryPath, "utf8"));
            registry.repositories = registry.repositories.filter((name) => name !== "alpha");
            writeFileSync(registryPath, JSON.stringify(registry));
          }
          revoked = true;
          renameSync(lock, `${lock}.retained`);
        }, 20);
      }
      return { code: 0, stdout, stderr: "" };
    };

    const result = await executeHerdrSpawnWorker({ ...params("alpha", grant.id), worktreePath: target }, f.context, f.options);
    assert.equal(revoked, true, "revocation must happen before the receipt");
    assert.equal(auditPendingWhenRevoked, true, "revocation must happen during the audit lock wait");
    const audit = readFileSync(uses, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(audit.map((entry) => entry.result), ["reserved", "spawned"], "the awaited audit write completed");
    assert.ok(audit.every((entry) => entry.ledgerId === grant.id));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.status, "partial");
    assert.equal(result.partial, "agent_started");
    assert.equal(result.code, revokedAuthority === "lease" ? "worktree_target_changed" : "repository_untrusted");
    assert.equal(result.paneId, "w1:p1");
    assert.equal(result.tabId, "w1:t1");
    assert.match(result.cleanup, /worker agent is live/);
    const calls = readFileSync(f.log, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(calls.map((argv) => argv.slice(0, 2)), [
      ["agent", "list"], ["workspace", "list"], ["pane", "list"], ["tab", "create"], ["agent", "start"], ["agent", "get"], ["pane", "get"],
    ], "no retry or automatic cleanup after the agent starts");
  });
}

for (const observation of ["common-dir", "origin"]) {
  test(`registration ${observation} observation ignores inherited Git configuration`, async () => {
    const f = setup();
    const name = "agent-skill-vault";
    const entry = await recordApproval(f.profile, f.approval(name, 2, "register"));
    const pollution = observation === "common-dir"
      ? { GIT_COMMON_DIR: join(f.root, "foreign-common") }
      : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://github.com/foreign/.insteadOf", GIT_CONFIG_VALUE_0: `https://github.com/${owner}/` };
    const before = Object.fromEntries(Object.keys(pollution).map((key) => [key, process.env[key]]));
    const options = { runGh: () => ({ status: 0, stdout: JSON.stringify({ nameWithOwner: `${owner}/${name}`, visibility: "PRIVATE" }) }) };
    Object.assign(process.env, pollution);
    try {
      const result = await executeHerdrRegisterRepository({ name, ledgerId: entry.id }, f.context, options);
      assert.equal(result.status, "registered", JSON.stringify(result));
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    // Sanitizing inherited configuration must not weaken the stored-origin check.
    execFileSync("git", ["-C", join(f.root, name), "remote", "set-url", "origin", "https://github.com/foreign/wrong.git"]);
    const refused = await executeHerdrRegisterRepository({ name, ledgerId: entry.id }, f.context, options);
    assert.equal(refused.code, "registration_refused");
    assert.equal(refused.reason, "verified origin and non-worktree clone");
    assert.equal(existsSync(f.log), false);
  });

  test(`registration ${observation} observation is bounded and refuses before mutation`, async () => {
    const f = setup();
    const name = "agent-skill-vault";
    const entry = await recordApproval(f.profile, f.approval(name, 2, "register"));
    const registryPath = join(f.profile, "config/herdr-worker-repositories.v1.json");
    const registryBefore = readFileSync(registryPath, "utf8");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const blockedArgs = observation === "common-dir" ? "rev-parse --git-common-dir" : "remote get-url origin";
    const probeSeen = join(f.root, "blocked-git-probe");
    const fakeGit = join(f.root, "git");
    writeFileSync(fakeGit, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.slice(2).join(" ") === ${JSON.stringify(blockedArgs)}) {
  writeFileSync(${JSON.stringify(probeSeen)}, "observed");
  setInterval(() => {}, 1000);
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: "utf8", env: process.env });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}
`);
    chmodSync(fakeGit, 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${f.root}:${before}`;
    let ghCalls = 0;
    try {
      const result = await executeHerdrRegisterRepository({ name, ledgerId: entry.id }, f.context, {
        runGh: () => { ghCalls++; return { status: 0, stdout: JSON.stringify({ nameWithOwner: `${owner}/${name}`, visibility: "PRIVATE" }) }; },
      });
      assert.equal(readFileSync(probeSeen, "utf8"), "observed", "the blocked Git probe was exercised");
      assert.equal(result.code, "registration_refused", JSON.stringify(result));
      assert.equal(result.status, "needs-owner");
      assert.equal(result.reason, "verified origin and non-worktree clone");
      assert.equal(ghCalls, 0, "failed local Git evidence cannot reach GitHub verification");
      assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
      assert.equal(existsSync(join(f.profile, "approvals/uses.v1.jsonl")), false);
      assert.equal(existsSync(f.log), false);
    } finally {
      process.env.PATH = before;
    }
  });
}

for (const drift of ["origin", "clone", "git-directory", "owner", "excluded", "visibility", "none"]) {
  test(`registration reservation wait revalidates ${drift} before registry mutation`, async () => {
    const f = setup();
    const name = "agent-skill-vault";
    const root = join(f.root, name);
    const registryPath = join(f.profile, "config/herdr-worker-repositories.v1.json");
    const before = readFileSync(registryPath, "utf8");
    const entry = await recordApproval(f.profile, f.approval(name, 2, "register"));
    const lock = join(f.profile, "approvals/writer.lock");
    const uses = join(f.profile, "approvals/uses.v1.jsonl");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    let changed = false;
    let pending = false;
    let ghCalls = 0;
    setTimeout(() => {
      pending = existsSync(lock) && !existsSync(uses) && readFileSync(registryPath, "utf8") === before;
      if (drift === "origin") execFileSync("git", ["-C", root, "remote", "set-url", "origin", "https://github.com/foreign/wrong.git"]);
      if (drift === "clone" || drift === "git-directory") {
        const replaced = drift === "clone" ? root : join(root, ".git");
        renameSync(replaced, `${replaced}.retained`);
        execFileSync("git", ["init", "-q", root]);
        execFileSync("git", ["-C", root, "remote", "add", "origin", `https://github.com/${owner}/${name}.git`]);
      }
      if (drift === "owner" || drift === "excluded") {
        const file = join(f.profile, "config/relay-authority.v1.json");
        const config = JSON.parse(readFileSync(file, "utf8"));
        if (drift === "owner") config.githubOwner = "different-owner";
        else config.denyRepositories.push(name);
        writeFileSync(file, JSON.stringify(config));
      }
      changed = true;
      renameSync(lock, `${lock}.retained`);
    }, 20);
    const result = await executeHerdrRegisterRepository({ name, ledgerId: entry.id }, f.context, {
      runGh: () => {
        ghCalls++;
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: `${owner}/${name}`, visibility: drift === "visibility" && changed ? "PUBLIC" : "PRIVATE" }) };
      },
    });
    assert.equal(changed, true);
    assert.equal(pending, true, "drift occurs while reservation is pending, before membership/use effects");
    const registered = drift === "none";
    assert.equal(result.ok, registered, JSON.stringify(result));
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(registry.repositories.includes(name), registered);
    assert.equal(readdirSync(join(f.profile, "config")).filter((file) => file.endsWith(".bak")).length, registered ? 1 : 0);
    const audit = readFileSync(uses, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(audit.map((use) => use.result), registered ? ["reserved", "registered"] : ["reserved"], "a refused reserved attempt must never record registration");
    if (!registered) {
      assert.equal(result.code, "registration_refused");
      assert.equal(result.status, "needs-owner");
      assert.equal(readFileSync(registryPath, "utf8"), before);
    }
    if (registered || drift === "visibility") assert.equal(ghCalls, 2, "current exact-owner/private evidence is checked after the wait");
    assert.equal(existsSync(f.log), false);
  });
}

test("agent write to approvals is blocked even with a native UI", async () => {
  const result = await guardToolCall({ toolName: "write", input: { path: "approvals/head.v1.json" } }, { hasUI: true, ui: { confirm: () => true } });
  assert.equal(result.block, true);
  const cli = await guardToolCall({ toolName: "bash", input: { command: "node scripts/relay/record_approval.mjs profile input.json" } }, {});
  assert.equal(cli.block, true);
  assert.equal(cli.status, "needs-owner");
});
