// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only

// Background inventory refresh for Pi write/edit results.
//
// Pi built-ins report tool_result with toolName "write" or "edit" and
// input.path (extensions.md). Claude-style file_path and the patch names
// already treated as edits in this repo are accepted too. The handler
// returns immediately: it never awaits the refresh, never returns an
// isError patch, and swallows spawn failures so the tool result stands.

import { spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOOK_SCRIPT = fileURLToPath(new URL("../scripts/inventory_refresh.sh", import.meta.url));
const CODE_EXTENSIONS = [".py", ".sh", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts"];
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "multiedit",
  "search_replace",
  "str_replace",
]);

export function basename(target) {
  const slash = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return slash >= 0 ? target.slice(slash + 1) : target;
}

function defaultReadFirstLine(target) {
  const fd = openSync(target, "r");
  try {
    const buffer = Buffer.alloc(256);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, count).toString("utf8").split(/\n/, 1)[0];
  } finally {
    closeSync(fd);
  }
}

export function isInventoriedPath(target, readFirstLine = defaultReadFirstLine) {
  if (typeof target !== "string" || target.length === 0) return false;
  const base = basename(target);
  if (base === "TASKS.md" || base === "HANDOVER.md") return true;
  if (CODE_EXTENSIONS.some((extension) => base.endsWith(extension))) return true;
  if (base.includes(".")) return false;
  let first = "";
  try {
    first = String(readFirstLine(target) ?? "");
  } catch {
    return false;
  }
  const line = first.replace(/\r$/, "").toLowerCase();
  return line.startsWith("#!") && (line.includes("python") || line.includes("sh"));
}

export function writtenPaths(event) {
  const found = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) found.push(value);
  };
  for (const bag of [event?.input, event?.tool_input]) {
    if (!bag || typeof bag !== "object") continue;
    push(bag.path);
    push(bag.file_path);
    push(bag.filePath);
  }
  return [...new Set(found)];
}

function defaultSpawnRefresh(target) {
  const child = spawn("bash", [HOOK_SCRIPT, target], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

export default function inventoryRefresh(pi, options = {}) {
  const spawnRefresh = options.spawnRefresh ?? defaultSpawnRefresh;
  const readFirstLine = options.readFirstLine ?? defaultReadFirstLine;
  if (typeof pi?.on !== "function") return undefined;
  pi.on("tool_result", (event) => {
    try {
      const name = String(event?.toolName ?? "").toLowerCase();
      if (!WRITE_TOOLS.has(name) || event?.isError === true || event?.is_error === true) return undefined;
      for (const target of writtenPaths(event)) {
        if (isInventoriedPath(target, readFirstLine)) spawnRefresh(target);
      }
    } catch {
      // Best-effort refresh. The tool result is unchanged.
    }
    return undefined;
  });
  return undefined;
}
