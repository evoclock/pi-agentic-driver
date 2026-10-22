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
test("fresh offline packed install loads all configured skills and imports", async () => {
  const scratch = mkdtempSync(join(repo, ".fresh-pack-install-"));
  try {
    const home = join(scratch, "home");
    const packs = join(scratch, "packs");
    const consumer = join(scratch, "consumer");
    mkdirSync(home);
    mkdirSync(packs);
    mkdirSync(consumer);
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
    assert.equal(expected.filter((name) => name.endsWith("-pi")).length, 54, "all pinned Pi ports must ship");
    assert.deepEqual(expected.filter((name) => !name.endsWith("-pi")).sort(),
      ["decision-to-spec", "harvest-lessons", "public-pr-wording", "pulse", "tasks"].sort(),
      "the packaged non-port skills must ship");
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
    assert.ok(existsSync(join(installed, "skills/decision-to-spec/SKILL.md")));
    const skillFile = join(installed, "skills/decision-to-spec/SKILL.md");
    writeFileSync(skillFile, readFileSync(skillFile, "utf8").replace(/^description:.*\r?\n/m, ""));
    await loader.reload();
    const refused = loader.getSkills();
    assert.ok(!refused.skills.some((skill) => skill.name === "decision-to-spec" && skill.filePath?.startsWith(installed + "/")));
    assert.ok(refused.diagnostics.some((d) => d.path?.startsWith(installed + "/") && /description is required/.test(d.message)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
