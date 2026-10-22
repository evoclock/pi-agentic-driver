// SPDX-License-Identifier: AGPL-3.0-only
// Relayed approval records are attestations by configured relayers, not proof of owner identity.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, openSync, closeSync, mkdirSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const validDate = (value) => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
export function approvalPaths(profile) {
  if (!profile) throw new Error("profile directory required");
  return { ledger: join(profile, "approvals/approvals.v1.jsonl"), head: join(profile, "approvals/head.v1.json"), lock: join(profile, "approvals/writer.lock"), uses: join(profile, "approvals/uses.v1.jsonl"), relayers: join(profile, "config/relay-authority.v1.json") };
}
export function verifyApprovals(file, headFile = join(file, "../head.v1.json")) {
  for (const candidate of [file, headFile]) {
    try { if (!lstatSync(candidate).isFile()) throw new Error("approval file must be regular"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { readFileSync(headFile, "utf8"); } catch (headError) { if (headError.code === "ENOENT") return []; throw headError; }
    throw new Error("approval ledger missing but head exists");
  }
  if (raw && !raw.endsWith("\n")) throw new Error("incomplete approval ledger");
  const entries = [];
  let previous = null;
  const ids = new Set();
  for (const line of raw.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    const { hash, ...body } = entry;
    if (entry.schema !== "relay-approval.v1" || entry.prevHash !== previous || hash !== digest(JSON.stringify(body)) || ids.has(entry.id)) throw new Error("approval chain invalid");
    ids.add(entry.id);
    previous = hash;
    entries.push(entry);
  }
  let head;
  try { head = JSON.parse(readFileSync(headFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (head ? head.count !== entries.length || head.lastHash !== previous : entries.length !== 0) throw new Error("approval head mismatch");
  return entries;
}
// O_EXCL prevents competing writers. A lock is stale only when both aged and
// its PID is demonstrably gone; uncertainty fails closed.
export async function withApprovalLock(profile, operation) {
  const { lock } = approvalPaths(profile);
  mkdirSync(join(profile, "approvals"), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    let fd;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const snapshot = statSync(lock);
      if (Date.now() - snapshot.mtimeMs > 60000) {
        let owner;
        try { owner = JSON.parse(readFileSync(lock, "utf8")); } catch { /* incomplete lock: fail closed */ }
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (probe) {
            if (probe.code === "ESRCH" && statSync(lock).ino === snapshot.ino) { unlinkSync(lock); continue; }
          }
        }
      }
      await sleep(100);
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return await operation();
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  throw new Error("approval writer lock unavailable");
}
export async function recordApproval(profile, input) {
  const paths = approvalPaths(profile);
  const config = JSON.parse(readFileSync(paths.relayers, "utf8"));
  const allowed = new Set(["kind", "relayer", "channel", "sourceMessageId", "quote", "quotedQuestion", "givenAt", "scope", "tier", "expiresAt", "maxUses"]);
  if (!input || Object.keys(input).some((key) => !allowed.has(key))) throw new Error("unexpected approval field");
  if (!Number.isInteger(input.tier) || input.tier < 1 || input.tier > 2 || !config.relayers?.some((r) => r.relayer === input.relayer && r.channel === input.channel && r.maxTier >= input.tier)) throw new Error("untrusted relayer or tier");
  if (!["relay", "direct", "standing"].includes(input.kind) || !input.quote?.trim() || !input.quotedQuestion?.trim() || !input.sourceMessageId?.trim() || !validDate(input.givenAt) || !input.scope?.repo || !Array.isArray(input.scope.actions)) throw new Error("incomplete approval");
  const scope = input.scope;
  if (typeof scope.repo !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(scope.repo)
      || Object.keys(scope).some((key) => !["repo", "actions", "paths", "prs", "branches", "models", "roles"].includes(key))
      || ["actions", "paths", "prs", "branches", "models", "roles"].some((key) => scope[key] !== undefined && (!Array.isArray(scope[key]) || scope[key].some((value) => typeof value !== "string" || !value.trim())))) throw new Error("invalid approval scope");
  const now = new Date();
  if (Date.parse(input.givenAt) > now.getTime() || (input.expiresAt && (!validDate(input.expiresAt) || Date.parse(input.expiresAt) <= now.getTime()))) throw new Error("invalid approval time");
  const expiresAt = input.expiresAt ?? (input.kind === "standing" ? new Date(now.getTime() + 7 * 86400000).toISOString() : null);
  if (input.maxUses != null && (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1)) throw new Error("invalid use limit");
  return withApprovalLock(profile, () => {
    const entries = verifyApprovals(paths.ledger, paths.head);
    const body = { ...input, scope: { paths: [], prs: [], branches: [], models: [], roles: [], ...input.scope }, schema: "relay-approval.v1", id: randomUUID(), prevHash: entries.at(-1)?.hash ?? null, recordedAt: now.toISOString(), expiresAt };
    const entry = { ...body, hash: digest(JSON.stringify(body)) };
    appendFileSync(paths.ledger, JSON.stringify(entry) + "\n", { flag: "a", mode: 0o600 });
    writeFileSync(paths.head, JSON.stringify({ count: entries.length + 1, lastHash: entry.hash }) + "\n", { mode: 0o600 });
    return entry;
  });
}
export function authorizeApproval(profile, id, { tier, repository, action, model, role, path, pr, branch }, now = new Date()) {
  const paths = approvalPaths(profile);
  const entries = verifyApprovals(paths.ledger);
  const entry = entries.find((item) => item.id === id);
  const config = JSON.parse(readFileSync(paths.relayers, "utf8"));
  const trusted = config.relayers?.some((r) => r.relayer === entry?.relayer && r.channel === entry?.channel && r.maxTier >= tier);
  const scope = entry?.scope;
  const used = (() => { try { return readFileSync(paths.uses, "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((use) => use.ledgerId === id && use.result === "reserved").length; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } })();
  if (!entry || config.revokedIds?.includes(id) || tier > 2 || entry.tier < tier || !trusted || !scope || scope.repo !== repository || (tier === 2 && !entry.quote.includes(repository)) || !scope.actions?.includes(action) || (model && !scope.models?.includes(model)) || (role && !scope.roles?.includes(role)) || (path && !scope.paths?.includes(path)) || (pr && !scope.prs?.includes(pr)) || (branch && !scope.branches?.includes(branch)) || (entry.expiresAt && Date.parse(entry.expiresAt) <= now.getTime()) || (entry.maxUses != null && used >= entry.maxUses)) throw new Error("approval does not cover action");
  return entry;
}
// The header names candidate records only. Each requested action is checked
// against stored scope; prose in the request does not add permissions.
export function checkRelayRequests(profile, header, requests) {
  const match = /^\[relay:v1 ledger=([a-f0-9-]{36}(?:,[a-f0-9-]{36})*) relayer=([a-z][a-z0-9-]*)\]$/.exec(header ?? "");
  return requests.map((request) => {
    if (match && request.tier < 3) {
      for (const id of match[1].split(",")) {
        try {
          const entry = authorizeApproval(profile, id, request);
          if (entry.relayer === match[2]) return { status: "covered", ledgerId: id, tier: request.tier };
        } catch { /* No record covers this particular action. */ }
      }
    }
    return { status: "needs-owner", tier: request.tier, missing: [request.action], relayablePhrase: `Approve ${request.action} for ${request.repository}`, nextStep: request.tier === 3 ? "Request direct owner approval at the action boundary." : "Relay the scoped approval with its source and record it." };
  });
}
export async function reserveApprovalUse(profile, ledgerId, request, operation) {
  return withApprovalLock(profile, async () => {
    const entry = authorizeApproval(profile, ledgerId, request);
    appendFileSync(approvalPaths(profile).uses, JSON.stringify({ use: randomUUID(), ledgerId, action: request.action, target: request.repository, result: "reserved", at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return operation ? operation(entry) : entry;
  });
}
export async function recordApprovalUse(profile, ledgerId, action, target, result) {
  return withApprovalLock(profile, () => {
    const path = approvalPaths(profile).uses;
    appendFileSync(path, JSON.stringify({ use: randomUUID(), ledgerId, action, target, result, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  });
}
