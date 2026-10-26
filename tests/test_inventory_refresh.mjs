import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import inventoryRefresh, { isInventoriedPath, writtenPaths } from "../extensions/inventory-refresh.ts";

test("the package ships the hook script and the Pi extension", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("scripts/inventory_refresh.sh"));
  assert.ok(pkg.files.includes("extensions/inventory-refresh.ts"));
  assert.ok(pkg.pi.extensions.includes("./extensions"));
});

function fakePi() {
  const pi = { handlers: {} };
  pi.on = (name, handler) => {
    pi.handlers[name] = handler;
  };
  return pi;
}

test("tool_result for write and edit spawns once and does not block", () => {
  const spawned = [];
  const pi = fakePi();
  const result = inventoryRefresh(pi, {
    spawnRefresh: (target) => spawned.push(target),
    readFirstLine: () => { throw new Error("extension filter should not read a typed file"); },
  });
  assert.equal(result, undefined);
  assert.deepEqual(Object.keys(pi.handlers), ["tool_result"]);
  for (const toolName of ["write", "edit", "Write", "Edit", "apply_patch"]) {
    spawned.length = 0;
    const returned = pi.handlers.tool_result({ toolName, input: { path: "/repo/src/app.ts" }, isError: false });
    assert.equal(returned, undefined);
    assert.deepEqual(spawned, ["/repo/src/app.ts"]);
  }
});

test("file_path and Claude-style tool_input are accepted", () => {
  const spawned = [];
  const pi = fakePi();
  inventoryRefresh(pi, { spawnRefresh: (target) => spawned.push(target) });
  pi.handlers.tool_result({ toolName: "edit", input: { file_path: "lib/util.mjs" } });
  pi.handlers.tool_result({ toolName: "write", tool_input: { path: "lib/other.py" } });
  assert.deepEqual(spawned, ["lib/util.mjs", "lib/other.py"]);
});

test("read, bash, and a failed write do not spawn or throw", () => {
  const spawned = [];
  const pi = fakePi();
  inventoryRefresh(pi, {
    spawnRefresh: () => spawned.push("spawned"),
  });
  assert.doesNotThrow(() => {
    pi.handlers.tool_result(null);
    pi.handlers.tool_result({ toolName: "read", input: { path: "a.py" } });
    pi.handlers.tool_result({ toolName: "bash", input: { command: "echo hi > a.py" } });
    pi.handlers.tool_result({ toolName: "write", input: { path: "a.py" }, isError: true });
    pi.handlers.tool_result({ toolName: "write", input: {} });
  });
  assert.deepEqual(spawned, []);
});

test("a spawn failure does not fail the tool result", () => {
  const pi = fakePi();
  inventoryRefresh(pi, {
    spawnRefresh: () => { throw new Error("refresh unavailable"); },
  });
  assert.doesNotThrow(() => pi.handlers.tool_result({ toolName: "write", input: { path: "a.py" } }));
});

test("path filters match the shell hook", () => {
  const directory = mkdtempSync(join(tmpdir(), "inventory-refresh-"));
  try {
    const script = join(directory, "agent-bridge");
    writeFileSync(script, "#!/usr/bin/env python3\n");
    const node = join(directory, "tool");
    writeFileSync(node, "#!/usr/bin/env node\n");
    assert.equal(isInventoriedPath(join(directory, "2021.12", "worker.py")), true);
    assert.equal(isInventoriedPath(join(directory, "TASKS.md")), true);
    assert.equal(isInventoriedPath(join(directory, "docs", "HANDOVER.md")), true);
    assert.equal(isInventoriedPath(join(directory, "README.md")), false);
    assert.equal(isInventoriedPath(join(directory, "Main.PY")), false);
    assert.equal(isInventoriedPath(script), true);
    assert.equal(isInventoriedPath(node), false);
    assert.equal(isInventoriedPath(join(directory, "missing-shebang")), false);
    assert.deepEqual(writtenPaths({ input: { file_path: "a.ts" } }), ["a.ts"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the default spawn refreshes the edited file's repository", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inventory-refresh-repo-"));
  try {
    execFileSync("git", ["init", "-q", directory]);
    const source = join(directory, "src");
    mkdirSync(source);
    const file = join(source, "app.ts");
    writeFileSync(file, "export function deliver() { return 1 }\n");
    execFileSync("git", ["-C", directory, "add", "src/app.ts"]);
    const pi = fakePi();
    inventoryRefresh(pi);
    const returned = pi.handlers.tool_result({ toolName: "edit", input: { path: file } });
    assert.equal(returned, undefined);
    const inventory = join(directory, "pipeline_output", "codebase_inventory.jsonl");
    let text = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        text = readFileSync(inventory, "utf8");
        break;
      } catch {
        await delay(100);
      }
    }
    assert.match(text, /"path":"src\/app.ts"/);
    assert.match(text, /"name":"deliver"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
