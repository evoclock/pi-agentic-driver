import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Unlike the tarball inventory test, this exercises npm's dependency placement
// and Pi's resource loader against a fresh installed consumer. Socket Firewall
// is mandatory; missing offline cache or missing sfw fails rather than skips.
// Why: the published archive must install in a clean consumer using only the locked offline dependency graph.
test("fresh offline packed install loads all configured skills and imports", async () => {
  const scratch = mkdtempSync(join(repo, ".fresh-pack-install-"));
  try {
    const home = join(scratch, "home");
    const packs = join(scratch, "packs");
    const consumer = join(scratch, "consumer");
    mkdirSync(home);
    mkdirSync(packs);
    mkdirSync(consumer);
    // A fresh consumer still needs a reproducible dependency graph. Without
    // the lock npm resolves newer transitive ranges that an offline cache
    // cannot promise to contain (even when this package pins pi-durable).
    const sourceManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
    const consumerManifest = {
      name: "packed-driver-consumer", version: "1.0.0", private: true,
      dependencies: sourceManifest.dependencies, devDependencies: sourceManifest.devDependencies,
    };
    lock.name = consumerManifest.name;
    lock.version = consumerManifest.version;
    lock.packages[""].name = consumerManifest.name;
    lock.packages[""].version = consumerManifest.version;
    writeFileSync(join(consumer, "package.json"), JSON.stringify(consumerManifest));
    writeFileSync(join(consumer, "package-lock.json"), JSON.stringify(lock));
    const userConfig = join(scratch, "user-npmrc");
    const globalConfig = join(scratch, "global-npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const env = {
      PATH: process.env.PATH || "",
      HOME: home,
      TMPDIR: scratch,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_cache: process.env.PI_PACKED_NPM_CACHE || join(homedir(), ".npm"),
      npm_config_offline: "true",
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packs], { cwd: repo, env, encoding: "utf8" }));
    const archive = join(packs, packed.filename);
    execFileSync("sfw", ["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", consumer, archive], {
      cwd: repo, env, encoding: "utf8", timeout: 120_000,
    });
    const installed = join(consumer, "node_modules/@evoclock/pi-agentic-driver");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const expected = manifest.pi.skills.map((entry) => entry.split("/").at(-1));
    const sourceSkills = sourceManifest.pi.skills.map((entry) => entry.split("/").at(-1));
    assert.deepEqual([...expected].sort(), sourceSkills.sort(), "the packed manifest must preserve package.json skill registration");
    assert.deepEqual(expected.filter((name) => name.endsWith("-pi")), ["correct-pi"], "only the native correction skill ships");
    const driverSkills = [
      "driver-mode",
      "driver-principle-boundary-only-authority",
      "driver-principle-cite-your-status",
      "driver-principle-dependency-policy",
      "driver-principle-evidence",
      "driver-principle-fail-loud",
      "driver-principle-working-memory-is-not-authority",
    ];
    assert.ok(driverSkills.every((name) => expected.includes(name)), "the packaged driver skills must ship");
    const loader = new DefaultResourceLoader({
      cwd: consumer,
      agentDir: home,
      settingsManager: SettingsManager.inMemory({ packages: [installed] }),
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const loaded = loader.getSkills();
    const shipped = loaded.skills.filter((skill) => skill.filePath?.startsWith(installed + "/"));
    assert.deepEqual(shipped.map((skill) => skill.name).sort(), expected.sort());
    assert.deepEqual(loaded.diagnostics.filter((d) => d.path?.startsWith(installed + "/")), []);

    const native = await import(pathToFileURL(join(installed, "scripts/enforcement/native_tui_context.js")).href);
    assert.equal(native.isNativeTuiContext(undefined), false);
    const durable = await import(pathToFileURL(join(installed, "scripts/enforcement/durable_assignment_pi.js")).href);
    assert.equal(typeof durable.openDurableAssignmentFixture, "function");
    const ledger = await import(pathToFileURL(join(installed, "scripts/enforcement/approval_ledger_pi.js")).href);
    const profile = join(scratch, "profile");
    mkdirSync(join(profile, "config"), { recursive: true });
    writeFileSync(join(profile, "config/relay-authority.v1.json"), JSON.stringify({ relayers: [{ relayer: "fixture", channel: "test", maxTier: 1 }] }));
    writeFileSync(join(profile, "config/herdr-worker-repositories.v1.json"), JSON.stringify({ schema: "agentic-driver.herdr-worker-repositories.v1", repositories: ["example"] }));
    await assert.doesNotReject(async () => {
      const grant = await ledger.recordApproval(profile, {
        kind: "standing", relayer: "fixture", channel: "test", sourceMessageId: "fixture",
        quote: "Approve example spawn", quotedQuestion: "May workers start?",
        givenAt: new Date(Date.now() - 1000).toISOString(), tier: 1,
        scope: { repo: "*", repositories: ["example"], actions: ["spawn"], models: [], roles: [] },
      });
      assert.equal(ledger.authorizeApproval(profile, grant.id, { tier: 1, repository: "example", action: "spawn", model: "fixture/model", role: "worker" }).id, grant.id);
    }, "the packed grant verifier must support registered repository snapshots");
    assert.ok(existsSync(join(installed, "skills/decision-to-spec/SKILL.md")));
    const skillFile = join(installed, "skills/decision-to-spec/SKILL.md");
    writeFileSync(skillFile, readFileSync(skillFile, "utf8").replace(/^description:.*\r?\n/m, ""));
    await loader.reload();
    const refused = loader.getSkills();
    assert.ok(!refused.skills.some((skill) => skill.name === "decision-to-spec" && skill.filePath?.startsWith(installed + "/")));
    assert.ok(refused.diagnostics.some((d) => d.path?.startsWith(installed + "/") && d.message.includes("description is required")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
