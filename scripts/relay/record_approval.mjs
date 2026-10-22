#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { recordApproval } from "../enforcement/approval_ledger_pi.js";
const [profile, inputFile] = process.argv.slice(2);
if (!profile || !inputFile) { console.error("Usage: record_approval.mjs <profile-dir> <approval-json-file>"); process.exitCode = 2; }
else {
  try { const entry = await recordApproval(profile, JSON.parse(readFileSync(inputFile, "utf8"))); console.log(entry.id); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
