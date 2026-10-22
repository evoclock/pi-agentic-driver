#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { verifyApprovals, approvalPaths } from "../enforcement/approval_ledger_pi.js";
const [profile, repositoryRoot, paneId, relayer, ids, requestFile] = process.argv.slice(2);
if (!profile || !repositoryRoot || !paneId || !/^[a-z][a-z0-9-]*$/.test(relayer ?? "") || !ids || !requestFile) {
  console.error("Usage: send_request.mjs <profile> <repo-root> <pane-id> <relayer> <id[,id]> <request-file>"); process.exitCode = 2;
} else {
  try {
    const requested = ids.split(",");
    const entries = verifyApprovals(approvalPaths(profile).ledger);
    if (!requested.length || requested.some((id) => !/^[a-f0-9-]{36}$/.test(id) || !entries.some((entry) => entry.id === id && entry.relayer === relayer))) throw new Error("unknown or mismatched ledger id");
    const text = `[relay:v1 ledger=${ids} relayer=${relayer}]\n${readFileSync(requestFile, "utf8")}`;
    const scratch = resolve(repositoryRoot, "scratch");
    mkdirSync(scratch, { recursive: true });
    const file = join(scratch, `relay-request-${process.pid}.txt`);
    writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    for (const args of [["pane", "send-text", paneId, text], ["pane", "send-keys", paneId, "enter"]]) {
      const result = spawnSync("herdr", args, { encoding: "utf8", timeout: 15000 });
      if (result.status !== 0) throw new Error(`Herdr handoff failed: ${result.stderr || result.error?.message || result.status}; request preserved at ${file}`);
    }
    console.log(file);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
