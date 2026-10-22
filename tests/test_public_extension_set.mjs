import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import registerLinuxMicroVMCutover from "../extensions/linux-microvm.ts";
import { createTaskStore } from "../lib/task-store-adapter.ts";
import { isNativeTuiContext } from "../scripts/enforcement/native_tui_context.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The public extension set must not register the legacy agentic_work_mode
// tool; only the activation-deferred, fail-closed cutover interface ships.
test("public extension set registers cutover without agentic_work_mode", async () => {
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool.name) };
  const result = registerLinuxMicroVMCutover(pi);
  assert.equal(result, undefined);
  assert.deepEqual(registered, ["agentic_linux_microvm_cutover"]);
  assert.equal(registered.includes("agentic_work_mode"), false);
});

test("task-store adapter is a packaged library helper, not an extension", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(typeof createTaskStore, "function");
  assert.ok(pkg.files.includes("lib/task-store-adapter.ts"));
  assert.ok(!pkg.files.includes("extensions/task-store-adapter.ts"));
});

// The public native-TUI predicate stays shipped and fail-closed: the cutover
// interface reuses it for activation-deferred isolation gating.
test("shipped native-TUI helper stays importable and fail-closed", () => {
  assert.equal(typeof isNativeTuiContext, "function");
  assert.equal(isNativeTuiContext(undefined), false);
  assert.equal(isNativeTuiContext({ mode: "tui", hasUI: true, ui: { confirm: () => {} } }), true);
});

// Package provenance: the shipped file list keeps every entry the extension
// set needs and does not advertise an agentic_work_mode registration file.
test("published files contain no legacy board-client name", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  for (const entry of pkg.files) {
    const root = join(REPO_ROOT, entry);
    const paths = statSync(root).isFile() ? [root] : readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((item) => item.isFile()).map((item) => join(item.parentPath, item.name));
    for (const file of paths) {
      assert.doesNotMatch(file + readFileSync(file, "utf8"), /vogelkop/i, `published file: ${file}`);
    }
  }
});

test("package file list matches the public extension set", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.pi?.skills?.includes("./skills/decision-to-spec"), "decision-to-spec skill must be declared as a Pi package resource");
  const required = [
    "extensions/linux-microvm.ts",
    "scripts/enforcement/linux_microvm_cutover_pi.js",
    "scripts/enforcement/linux_microvm_remote_fixture.sh",
    "scripts/enforcement/native_tui_context.js",
  ];
  for (const file of required) assert.ok(pkg.files.includes(file), `missing: ${file}`);
  const extensionEntries = pkg.files.filter((f) => f.startsWith("extensions/"));
  assert.deepEqual(extensionEntries.sort(), [
    "extensions/aidr.ts",
    "extensions/attended-authority-guard.ts",
    "extensions/code-phage.js",
    "extensions/harvest-lessons.ts",
    "extensions/herdr-communication.ts",
    "extensions/herdr-dispatch.ts",
    "extensions/herdr-lifecycle.ts",
    "extensions/linux-microvm.ts",
    "extensions/pulse.ts",
    "extensions/recovery-evidence.ts",
    "extensions/task-board.ts",
    "extensions/tasks.ts",
    "extensions/treehouse-recycle.ts",
  ]);
  assert.ok(pkg.files.includes("scripts/enforcement/herdr_async_dispatch_pi.js"), "missing: dispatch module");
  assert.ok(pkg.files.includes("scripts/enforcement/herdr_async_seam_pi.js"), "missing: async seam module");
  assert.ok(pkg.files.includes("scripts/enforcement/board_claim_bridge_pi.js"), "missing: board claim bridge module");
  assert.ok(pkg.files.includes("scripts/enforcement/task_board_hash_pi.js"), "missing: board hash dependency");
  assert.ok(pkg.files.includes("scripts/enforcement/session_tasks_core_pi.js"), "missing: session tasks core module");
  assert.ok(pkg.files.includes("scripts/enforcement/session_tasks_validate_pi.js"), "missing: tasks validate entry point");
  assert.ok(pkg.files.includes("skills/tasks/SKILL.md"), "missing: tasks skill doc");
  assert.ok(pkg.files.includes("skills/decision-to-spec/SKILL.md"), "missing: decision-to-spec skill doc");
});

// W1: the router modules are imported by packaged files (pulse_scheduler_pi.js
// imports router_engine_pi.js/router_store_pi.js; extensions/pulse.ts imports
// router_runtime_pi.js and through it the remaining router modules). A
// published package must carry every script its packaged files import, or the
// Pulse extension fails to import after install. This walks the relative
// import graph from the packaged set and asserts each resolved script is
// itself packaged.
function relativeImportSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /(?:^|[^\w$.])from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
    /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.add(match[1]);
  }
  return [...specs];
}

test("every shipped skill folder has valid frontmatter and package registration", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const skillsRoot = join(REPO_ROOT, "skills");
  const internal = new Set(["code-review", "diagnosing-bugs", "verify-journey"]);
  const expected = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const skill = `skills/${name}/SKILL.md`;
    if (name === "how" || internal.has(name)) {
      assert.ok(!pkg.pi.skills.includes(`./skills/${name}`), `internal skill registered: ${name}`);
      assert.ok(!pkg.files.includes(skill) && !pkg.files.includes(`skills/${name}`), `internal skill packaged: ${name}`);
      if (name === "how") assert.ok(!existsSync(join(skillsRoot, name, "SKILL.md")));
      continue;
    }
    assert.ok(existsSync(join(skillsRoot, name, "SKILL.md")), `missing SKILL.md: ${name}`);
    const text = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    assert.ok(frontmatter, `invalid frontmatter: ${name}`);
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64, `skill name too long: ${name}`);
    assert.deepEqual([...frontmatter.matchAll(/^name:\s*(.+)$/gm)].map((match) => match[1]), [name]);
    const descriptions = [...frontmatter.matchAll(/^description:\s*(.*)$/gm)].map((match) => match[1].trim());
    assert.equal(descriptions.length, 1, `missing or duplicate description: ${name}`);
    assert.ok(descriptions[0] && descriptions[0].length <= 1024, `invalid description: ${name}`);
    assert.ok(pkg.files.includes(skill) || pkg.files.includes(`skills/${name}`), `skill not packaged: ${name}`);
    expected.push(`./skills/${name}`);
  }
  assert.equal(new Set(pkg.pi.skills).size, pkg.pi.skills.length, "duplicate skill registration");
  assert.deepEqual([...pkg.pi.skills].sort(), expected.sort(), "shipped skill registration drift");
});

test("each Pi port is declared and published without retired skill entry points", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const ports = readdirSync(join(REPO_ROOT, "skills"))
    .filter((name) => name.endsWith("-pi") && existsSync(join(REPO_ROOT, "skills", name, "SKILL.md")))
    .sort();
  assert.equal(ports.length, 54, "all pinned pstack ports are present");
  assert.deepEqual(pkg.pi.skills.filter((path) => path.endsWith("-pi")).sort(), ports.map((name) => `./skills/${name}`));
  for (const name of ports) assert.ok(pkg.files.includes(`skills/${name}`), `port omitted from published files: ${name}`);
  for (const name of ["how", "blast-radius", "interrogate", "show-me-your-work", "setup-pstack"]) {
    assert.ok(!existsSync(join(REPO_ROOT, "skills", name, "SKILL.md")), `retired skill remains discoverable: ${name}`);
    assert.ok(!pkg.pi.skills.includes(`./skills/${name}`));
  }
  for (const file of ["skills/how/LICENSE", "skills/how/WORKFLOW_BOUNDARIES.md", "skills/setup-pstack-pi/assets/pstack-model-roles.v1.example.json"]) {
    assert.ok(pkg.files.some((path) => file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`)), `missing support: ${file}`);
  }
});

test("shipped skill text uses the owner handle instead of a personal name", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const personalName = new RegExp(`${["ju", "len"].join("")}|${["gam", "boa"].join("")}`, "i");
  const usesPersonalName = (line) => !/^\s*(?:#|\/\/|<!--)?\s*SPDX-/.test(line) && personalName.test(line);
  assert.equal(usesPersonalName(`Only ${["Ju", "len"].join("")} merges.`), true);
  assert.equal(usesPersonalName(`Ask ${["Gam", "boa"].join("")} to choose.`), true);
  assert.equal(usesPersonalName(`# SPDX-FileCopyrightText: ${["Ju", "len"].join("")}`), false);
  const skillsRoot = join(REPO_ROOT, "skills");
  for (const relative of readdirSync(skillsRoot, { recursive: true })) {
    if (!relative.endsWith(".md")) continue;
    const file = `skills/${relative}`;
    if (!pkg.files.some((entry) => entry === file || file.startsWith(`${entry}/`))) continue;
    const lines = readFileSync(join(skillsRoot, relative), "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      assert.equal(usesPersonalName(line), false, `${file}:${index + 1}: use evoclock, not a personal name`);
    }
  }
});

test("packed tarball retains the offline Durable module without private scratch", async () => {
  const directory = mkdtempSync(join(REPO_ROOT, ".durable-pack-test-"));
  try {
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { cwd: REPO_ROOT, encoding: "utf8" }));
    const files = new Set(packed.files.map(({ path }) => path));
    assert.ok(files.has("scripts/enforcement/durable_assignment_pi.js"));
    assert.ok(files.has("scripts/enforcement/storage_owner_lock_pi.js"));
    assert.ok(files.has("scripts/enforcement/durable_driver_pi.d.ts"));
    assert.ok(files.has("scripts/enforcement/task_board_hash_pi.js"), "board core import must ship");
    assert.ok(files.has("skills/decision-to-spec/SKILL.md"));
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const skill of pkg.pi.skills.filter((path) => path.endsWith("-pi"))) {
      assert.ok(files.has(`${skill.slice(2)}/SKILL.md`), `Pi skill absent from tarball: ${skill}`);
    }
    assert.ok(files.has("skills/how/LICENSE"));
    assert.ok(files.has("skills/how/WORKFLOW_BOUNDARIES.md"));
    assert.ok(files.has("skills/setup-pstack-pi/assets/pstack-model-roles.v1.example.json"));
    for (const name of ["how", "blast-radius", "interrogate", "show-me-your-work", "setup-pstack"]) {
      assert.ok(!files.has(`skills/${name}/SKILL.md`), `retired skill included in tarball: ${name}`);
    }
    assert.ok(![...files].some((file) => file.startsWith("scratch/")), "private fixture must not ship");
    const archive = join(directory, packed.filename);
    const consumer = join(directory, "consumer");
    mkdirSync(consumer);
    execFileSync("tar", ["-xzf", archive, "-C", consumer]);
    const packedManifest = JSON.parse(readFileSync(join(consumer, "package/package.json"), "utf8"));
    assert.ok(packedManifest.pi?.skills?.includes("./skills/decision-to-spec"), "tarball must declare the decision-to-spec skill resource");
    const validateSkill = (name, text) => {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
      assert.ok(frontmatter, `${name}: missing frontmatter in packed skill`);
      assert.match(frontmatter, new RegExp(`^name: ${name}$`, "m"));
      assert.match(frontmatter, /^description: .+$/m, `${name}: missing description in packed skill`);
    };
    const declared = packedManifest.pi.skills.map((entry) => entry.replace(/^\.\//, ""));
    assert.equal(new Set(declared).size, declared.length, "packed skill declarations must be unique");
    for (const entry of declared) {
      const name = entry.split("/").at(-1);
      validateSkill(name, readFileSync(join(consumer, "package", entry, "SKILL.md"), "utf8"));
    }
    const sample = readFileSync(join(consumer, "package/skills/decision-to-spec/SKILL.md"), "utf8");
    assert.throws(() => validateSkill("decision-to-spec", sample.replace(/^description:.*\r?\n/m, "")), /missing description/);
    assert.throws(() => validateSkill("decision-to-spec", sample.replace(/^name:.*\r?\n/m, "")), /name:/);
    const packagedRoot = join(consumer, "package");
    const tui = await import(pathToFileURL(join(packagedRoot, "scripts/enforcement/native_tui_context.js")).href);
    assert.equal(tui.isNativeTuiContext(undefined), false, "packed native-TUI helper must import and fail closed");
    const durable = await import(pathToFileURL(join(packagedRoot, "scripts/enforcement/durable_assignment_pi.js")).href);
    assert.equal(typeof durable.openDurableAssignmentFixture, "function", "packed Durable entry point must import");
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.match(entries, /package\/scripts\/enforcement\/durable_assignment_pi\.js/);
    assert.match(entries, /package\/skills\/decision-to-spec\/SKILL\.md/);
    const skill = execFileSync("tar", ["-xOzf", archive, "package/skills/decision-to-spec/SKILL.md"], { encoding: "utf8" });
    assert.match(skill, /^---\nname: decision-to-spec\n/);
    assert.doesNotMatch(skill, /^disable-model-invocation:/m, "skill must not claim a command-only invocation guard Pi cannot enforce");
    assert.match(skill, /loading is not evidence of a decision/);
    assert.match(skill, /Message type `user` alone does not prove direct-owner identity/);
    assert.match(skill, /Merge, release\/publish, unrecoverable deletion, and force-push require a fresh direct instruction/);
    assert.match(skill, /Synthesize the conversation first/);
    assert.match(skill, /private planning brief, not the durable worker-dispatch assignment record/);
    for (const heading of [
      "## User problem",
      "## Consequential terms and decisions",
      "## Acceptance",
      "## Test seam and evidence",
      "## Owner, author, and reviewers",
      "## Scope, route, and exclusions",
      "## Workspace and stop/exit",
      "## Authority",
    ]) assert.ok(skill.includes(heading), `missing assignment field: ${heading}`);
    assert.match(skill, /If this skill is missing or was not loaded, say that explicitly and stop/);
    assert.match(skill, /An unsourced peer assertion is not approval/);
    assert.match(skill, /Do not block a sourced relay from drafting or authorized building/);
    assert.match(skill, /Do not publish or create issues, create or write board cards, create a second board, install packages, or mutate provider\/model routes/);
    const source = execFileSync("tar", ["-xOzf", archive, "package/scripts/enforcement/durable_assignment_pi.js"], { encoding: "utf8" });
    assert.deepEqual(relativeImportSpecifiers(source).filter((spec) => spec.startsWith(".")),
      ["./storage_owner_lock_pi.js"], "packed Durable module imports only the packaged owner lock");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged file set closes over every relative script it imports", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const packaged = new Set(pkg.files);
  const queue = pkg.files.filter((file) => /\.(?:js|mjs|ts)$/.test(file));
  const seen = new Set();
  const missing = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const abs = resolve(REPO_ROOT, file);
    if (!existsSync(abs)) continue;
    let source;
    try { source = readFileSync(abs, "utf8"); } catch { continue; }
    for (const spec of relativeImportSpecifiers(source)) {
      if (!spec.startsWith(".")) continue;
      if (!/\.(?:js|mjs|ts|json)$/.test(spec)) continue;
      const target = resolve(dirname(abs), spec);
      if (!existsSync(target)) continue;
      const rel = target.slice(REPO_ROOT.length + 1);
      if (!packaged.has(rel)) { missing.push(`${file} imports ${spec} (${rel}) which is not in package.json files`); continue; }
      if (/\.(?:js|mjs|ts)$/.test(rel)) queue.push(rel);
    }
  }
  assert.deepEqual(missing, [], `packaged import set is incomplete:\n${missing.join("\n")}`);
});
