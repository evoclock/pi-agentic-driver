import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import registerLinuxMicroVMCutover from "../extensions/linux-microvm.ts";
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

// The public native-TUI predicate stays shipped and fail-closed: the cutover
// interface reuses it for activation-deferred isolation gating.
test("shipped native-TUI helper stays importable and fail-closed", () => {
  assert.equal(typeof isNativeTuiContext, "function");
  assert.equal(isNativeTuiContext(undefined), false);
  assert.equal(isNativeTuiContext({ mode: "tui", hasUI: true, ui: { confirm: () => {} } }), true);
});

// Package provenance: the shipped file list keeps every entry the extension
// set needs and does not advertise an agentic_work_mode registration file.
test("package file list matches the public extension set", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
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
    "extensions/herdr-communication.ts",
    "extensions/herdr-dispatch.ts",
    "extensions/herdr-lifecycle.ts",
    "extensions/linux-microvm.ts",
    "extensions/pulse.ts",
    "extensions/task-board.ts",
    "extensions/tasks.ts",
  ]);
  assert.ok(pkg.files.includes("scripts/enforcement/herdr_async_dispatch_pi.js"), "missing: dispatch module");
  assert.ok(pkg.files.includes("scripts/enforcement/herdr_async_seam_pi.js"), "missing: async seam module");
  assert.ok(pkg.files.includes("scripts/enforcement/board_claim_bridge_pi.js"), "missing: board claim bridge module");
  assert.ok(pkg.files.includes("scripts/enforcement/session_tasks_core_pi.js"), "missing: session tasks core module");
  assert.ok(pkg.files.includes("scripts/enforcement/session_tasks_validate_pi.js"), "missing: tasks validate entry point");
  assert.ok(pkg.files.includes("skills/tasks/SKILL.md"), "missing: tasks skill doc");
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
