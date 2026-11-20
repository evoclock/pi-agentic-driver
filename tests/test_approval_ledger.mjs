import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { recordApproval, verifyApprovals, authorizeApproval, recordApprovalUse, approvalGrantStatus, approvalPaths, withApprovalLock, reserveApprovalUse } from "../scripts/enforcement/approval_ledger_pi.js";

function fixture() {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(join(process.cwd(), "scratch/relay-ledger-"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/relay-authority.v1.json"), JSON.stringify({ relayers: [{ relayer: "bot", channel: "chat", maxTier: 2 }] }));
  writeFileSync(join(root, "config/herdr-worker-repositories.v1.json"), JSON.stringify({ schema: "agentic-driver.herdr-worker-repositories.v1", repositories: ["example", "second"] }));
  return root;
}
const input = () => ({ kind: "relay", relayer: "bot", channel: "chat", sourceMessageId: "42", quote: "Approve tab", quotedQuestion: "May I spawn?", givenAt: new Date(Date.now() - 1000).toISOString(), tier: 1, scope: { repo: "example", actions: ["spawn"], models: ["local/example"], roles: ["worker"] }, maxUses: 1 });
// Why: a missing or altered approval record must not retain its former authority.
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
// Why: standing permission must expire and honor revocation.
test("standing entries default to seven days and do not outlive revocation", async () => {
  const root = fixture();
  const entry = await recordApproval(root, { ...input(), kind: "standing" });
  assert.ok(Date.parse(entry.expiresAt) > Date.now() + 6 * 86400000);
  const configPath = join(root, "config/relay-authority.v1.json");
  writeFileSync(configPath, JSON.stringify({ relayers: [{ relayer: "bot", channel: "chat", maxTier: 2 }], revokedIds: [entry.id] }));
  assert.throws(() => authorizeApproval(root, entry.id, { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" }));
});
// Why: competing writers must not alter approval history concurrently.
test("writer lock refuses live PID and reclaims aged dead PID", async () => {
  const root = fixture(); const { lock } = approvalPaths(root);
  mkdirSync(join(root, "approvals"));
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 90000); utimesSync(lock, old, old);
  await assert.rejects(withApprovalLock(root, () => true), /lock unavailable/);
  writeFileSync(lock, JSON.stringify({ pid: 99999999 })); utimesSync(lock, old, old);
  assert.equal(await withApprovalLock(root, () => "reclaimed"), "reclaimed");
});
// Why: relayed authority must not override trust, expiry, or owner-held effects.
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
// Why: simultaneous starts must not reuse a single-use grant.
test("concurrent reservations spend a single-use approval once", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  const request = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  const results = await Promise.allSettled([reserveApprovalUse(root, entry.id, request), reserveApprovalUse(root, entry.id, request)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
});
// Why: a grant only covers its recorded scope, trusted relayer, and remaining uses.
test("scope, relayer, expiry and use limit fail closed", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  const check = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  assert.equal(authorizeApproval(root, entry.id, check).id, entry.id);
  assert.throws(() => authorizeApproval(root, entry.id, { ...check, role: "other" }));
  assert.throws(() => authorizeApproval(root, entry.id, { ...check, tier: 3 }));
  await reserveApprovalUse(root, entry.id, check);
  assert.throws(() => authorizeApproval(root, entry.id, check));
});
// Why: an outcome without a reservation identity can settle an unrelated use, so it must be refused.
test("terminal approval outcome requires its reserved use", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  await reserveApprovalUse(root, entry.id, { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" });
  await assert.rejects(recordApprovalUse(root, entry.id, "spawn", "example", "spawned"), /reserved use/);
});
// Why: each reservation admits at most one terminal, including under concurrent writers.
test("a reserved use settles once without changing legacy ledger lines", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  const original = readFileSync(approvalPaths(root).ledger, "utf8");
  const request = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  const { useId } = await reserveApprovalUse(root, entry.id, request);
  const legacy = JSON.stringify({ use: "old-unlinked-outcome", ledgerId: entry.id, action: "spawn", target: "example", result: "spawned", at: new Date().toISOString() }) + "\n";
  appendFileSync(approvalPaths(root).uses, legacy);
  await assert.rejects(recordApprovalUse(root, entry.id, "spawn", "second", "spawned", useId), /reserved use/);
  await recordApprovalUse(root, entry.id, "spawn", "example", "spawned", useId);
  await assert.rejects(recordApprovalUse(root, entry.id, "spawn", "example", "spawned", useId), /already settled/);
  assert.equal(readFileSync(approvalPaths(root).ledger, "utf8"), original);
  assert.deepEqual(readFileSync(approvalPaths(root).uses, "utf8").trim().split("\n").map((line) => JSON.parse(line).use), [useId, "old-unlinked-outcome", useId]);
  assert.equal(readFileSync(approvalPaths(root).uses, "utf8").includes(legacy), true);
});
// Why: a path cannot inherit repository scope without verified same-repository worktree evidence.
test("empty path scope refuses arbitrary path and forged worktree evidence", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  const request = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker", path: "/tmp/foreign-slot" };
  assert.throws(() => authorizeApproval(root, entry.id, request), /approval does not cover action/);
  assert.throws(() => authorizeApproval(root, entry.id, { ...request, worktreeTarget: { worktreePath: request.path, repositoryPath: "/tmp/example" } }), /approval does not cover action/);
});

// Why: a partial outcome must close a reservation exactly once without returning single-use grant capacity.
test("partial terminal use is attributable and never refunds a reserved approval", async () => {
  const root = fixture(); const entry = await recordApproval(root, input());
  const request = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  const { useId } = await reserveApprovalUse(root, entry.id, request);
  await recordApprovalUse(root, entry.id, "spawn", "example", "partial", useId, "tab_created");
  const uses = readFileSync(approvalPaths(root).uses, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(uses.map((use) => use.result), ["reserved", "partial"]);
  assert.equal(uses[1].partial, "tab_created");
  await assert.rejects(recordApprovalUse(root, entry.id, "spawn", "example", "spawned", useId), /already settled/);
  assert.throws(() => authorizeApproval(root, entry.id, request), /approval does not cover action/);
});
// Why: all grant views use one closed derived status and reservations remain spent after settlement.
test("grant status has active, used-up, expired and revoked states", async () => {
  const root = fixture(); const entry = await recordApproval(root, { ...input(), kind: "standing" });
  const request = { tier: 1, repository: "example", action: "spawn", model: "local/example", role: "worker" };
  assert.equal(approvalGrantStatus(entry, [], []), "active");
  const { useId } = await reserveApprovalUse(root, entry.id, request);
  await recordApprovalUse(root, entry.id, "spawn", "example", "spawned", useId);
  const uses = readFileSync(approvalPaths(root).uses, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(approvalGrantStatus(entry, [], uses), "used-up");
  assert.equal(approvalGrantStatus(entry, [], uses, new Date(Date.now() + 9 * 86400000)), "expired");
  assert.equal(approvalGrantStatus(entry, [entry.id], uses), "revoked");
});
// Why: deliberate empty lists have defined wildcard meaning without widening other fields.
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
// Why: one recorded standing grant must never extend to a repository or effect outside its snapshot.
test("a standing spawn grant covers only enumerated repositories without registry membership", async () => {
  const root = fixture();
  const scope = { repo: "*", repositories: ["example", "unregistered"], actions: ["spawn"], models: [], roles: [] };
  writeFileSync(join(root, "config/herdr-worker-repositories.v1.json"), "not a registry");
  let entry;
  await assert.doesNotReject(async () => { entry = await recordApproval(root, { ...input(), kind: "standing", scope }); });
  const request = { tier: 1, repository: "unregistered", action: "spawn", model: "local/another", role: "another-bot" };
  assert.equal(authorizeApproval(root, entry.id, request).id, entry.id);
  assert.throws(() => authorizeApproval(root, entry.id, { ...request, repository: "new-repository" }), /does not cover/);
  assert.throws(() => authorizeApproval(root, entry.id, { ...request, action: "publish" }), /does not cover/);
  assert.throws(() => authorizeApproval(root, entry.id, { ...request, tier: 2 }), /does not cover/);
  assert.throws(() => authorizeApproval(root, entry.id, request, new Date(Date.now() + 8 * 86400000)), /does not cover/);
  const configPath = join(root, "config/relay-authority.v1.json");
  writeFileSync(configPath, JSON.stringify({ relayers: [{ relayer: "bot", channel: "chat", maxTier: 2 }], revokedIds: [entry.id] }));
  assert.throws(() => authorizeApproval(root, entry.id, request), /does not cover/);
});
// Why: a grouped grant must not turn the repository selector into an unrestricted wildcard.
test("grouped grants reject unbounded, forged, or non-spawn scope", async () => {
  const root = fixture();
  const scope = { repo: "*", repositories: ["example"], actions: ["spawn"], models: [], roles: [] };
  for (const patch of [
    { kind: "relay" },
    { tier: 2 },
    { scope: { ...scope, repositories: [] } },
    { scope: { ...scope, repositories: ["*"] } },
    { scope: { ...scope, repositories: ["Invalid-Name"] } },
    { scope: { ...scope, actions: ["spawn", "merge"] } },
    { scope: { ...scope, models: undefined } },
  ]) {
    await assert.rejects(recordApproval(root, { ...input(), kind: "standing", scope, ...patch }));
  }
});
// Why: omitted scope fields must never be mistaken for intentional wildcards.
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
