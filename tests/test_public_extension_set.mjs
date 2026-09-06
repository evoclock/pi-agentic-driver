import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import registerLinuxMicroVMCutover from "../extensions/linux-microvm.ts";
import { isNativeTuiContext } from "../scripts/enforcement/native_tui_context.js";

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
    "extensions/code-phage.js",
    "extensions/herdr-communication.ts",
    "extensions/herdr-lifecycle.ts",
    "extensions/linux-microvm.ts",
  ]);
});
