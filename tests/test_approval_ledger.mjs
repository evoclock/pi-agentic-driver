import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { recordApproval, verifyApprovals, authorizeApproval, recordApprovalUse, approvalPaths, withApprovalLock, reserveApprovalUse } from "../scripts/enforcement/approval_ledger_pi.js";

function fixture() {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(join(process.cwd(), "scratch/relay-ledger-"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/relay-authority.v1.json"), JSON.stringify({ relayers: [{ relayer: "bot", channel: "chat", maxTier: 2 }] }));
  return root;
}
const input = () => ({ kind: "relay", relayer: "bot", channel: "chat", sourceMessageId: "42", quote: "Approve tab", quotedQuestion: "May I spawn?", givenAt: new Date(Date.now() - 1000).toISOString(), tier: 1, scope: { repo: "example", actions: ["spawn"], models: ["local/example"], roles: ["worker"] }, maxUses: 1 });
test("ledger verifies linked entries and rejects edited, deleted and reordered records", async () => {
  const root = fixture();
  await recordApproval(root, input()); await recordApproval(root, input());
  const file = approvalPaths(root).ledger;
  assert.equal(verifyApprovals(file).length, 2);
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  writeFileSync(file, `${lines[0]}\n`);
  assert.throws(() => verifyApprovals(file), /head mismatch/);
  writeFileSync(file, "");
  assert.throws(() => verifyApprovals(file), /head mismatch/);
  writeFileSync(file, `${lines[1]}\n${lines[0]}\n`);
  assert.throws(() => verifyApprovals(file));
  writeFileSync(file, `${lines[0].replace("Approve tab", "Approve merge")}\n${lines[1]}\n`);
  assert.throws(() => verifyApprovals(file));
});
test("standing entries default to seven days and do not outlive revocation", async () => {
  const root = fixture();
  const entry = await recordApproval(root, { ...input(), kind: "standing" });
  assert.ok(Date.parse(entry.expiresAt) > Date.now() + 6 * 86400000);
  const configPath = join(root, "config/relay-authority.v1.json");
  writeFileSync(configPath, JSON.stringify({ relayers: [{ relayer: "bot", channel: "chat", maxTier: 2 }], revokedIds: [entry.id] }));
  assert.throws(() => authorizeApproval(root, entry.id, { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" }));
});
test("writer lock refuses live PID and reclaims aged dead PID", async () => {
  const root = fixture(); const { lock } = approvalPaths(root);
  mkdirSync(join(root, "approvals"));
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 90000); utimesSync(lock, old, old);
  await assert.rejects(withApprovalLock(root, () => true), /lock unavailable/);
  writeFileSync(lock, JSON.stringify({ pid: 99999999 })); utimesSync(lock, old, old);
  assert.equal(await withApprovalLock(root, () => "reclaimed"), "reclaimed");
});
test("untrusted relayers, expired entries, and Tier 3 relay attempts fail closed", async () => {
  const root = fixture();
  await assert.rejects(recordApproval(root, { ...input(), relayer: "unknown" }), /untrusted/);
  await assert.rejects(recordApproval(root, { ...input(), tier: 3 }), /untrusted/);
  const entry = await recordApproval(root, { ...input(), expiresAt: new Date(Date.now() + 1000).toISOString() });
  const request = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  assert.throws(() => authorizeApproval(root, entry.id, request, new Date(Date.now() + 2000)), /does not cover/);
  for (const action of ["merge", "force-push", "publish", "ledger-edit"]) {
    assert.throws(() => authorizeApproval(root, entry.id, { ...request, tier: 3, action }), /does not cover/);
  }
});
test("concurrent reservations spend a single-use approval once", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  const request = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  const results = await Promise.allSettled([reserveApprovalUse(root, entry.id, request), reserveApprovalUse(root, entry.id, request)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
});
test("scope, relayer, expiry and use limit fail closed", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  const check = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  assert.equal(authorizeApproval(root, entry.id, check).id, entry.id);
  assert.throws(() => authorizeApproval(root, entry.id, { ...check, role: "other" }));
  assert.throws(() => authorizeApproval(root, entry.id, { ...check, tier: 3 }));
  await recordApprovalUse(root, entry.id, "spawn", "example", "reserved");
  assert.throws(() => authorizeApproval(root, entry.id, check));
});
test("an explicit empty roles or models list covers any role or model", async () => {
  const root = fixture();
  const anyRole = await recordApproval(root, { ...input(), scope: { ...input().scope, roles: [] } });
  const anyModel = await recordApproval(root, { ...input(), scope: { ...input().scope, models: [] } });
  const check = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  assert.equal(authorizeApproval(root, anyRole.id, { ...check, role: "any-new-role" }).id, anyRole.id);
  assert.throws(() => authorizeApproval(root, anyRole.id, { ...check, model: "local/other" }), /does not cover/);
  assert.equal(authorizeApproval(root, anyModel.id, { ...check, model: "local/other" }).id, anyModel.id);
  assert.throws(() => authorizeApproval(root, anyModel.id, { ...check, role: "other" }), /does not cover/);
  // Repository and action still bind an any-role grant.
  assert.throws(() => authorizeApproval(root, anyRole.id, { ...check, role: "x", repository: "elsewhere" }), /does not cover/);
  assert.throws(() => authorizeApproval(root, anyRole.id, { ...check, role: "x", action: "merge" }), /does not cover/);
});
test("a missing roles or models field still fails closed", async () => {
  const root = fixture();
  const { roles, ...noRoles } = input().scope;
  const { models, ...noModels } = input().scope;
  const a = await recordApproval(root, { ...input(), scope: noRoles });
  const b = await recordApproval(root, { ...input(), scope: noModels });
  const check = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  assert.throws(() => authorizeApproval(root, a.id, check), /does not cover/);
  assert.throws(() => authorizeApproval(root, b.id, check), /does not cover/);
  // The recorder must not turn an omitted field into an any-grant.
  assert.equal(a.scope.roles, undefined);
  assert.equal(b.scope.models, undefined);
});
