import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineCommands } from "../scripts/enforcement/machine_commands_pi.js";
import { openDurableDriver } from "../scripts/enforcement/durable_driver_pi.js";
import { createMachineRest, machineMcpMessage } from "../scripts/enforcement/machine_transports_pi.js";
import { WORKER_DISPATCH_TERMINAL_STATES } from "../scripts/enforcement/herdr_async_dispatch_pi.js";
import { writeCard, validateBoard, isDispatchable, readClaimsState, automationPolicyPath } from "../scripts/enforcement/task_board_core_pi.js";
import { openRouterStore, closeRouterStore, createReservation, claimReservation, getReservation, encodeReservationIdentity, reconcileReservationFromClaim } from "../scripts/enforcement/router_store_pi.js";

const authority = { source: "instruction", sessionOrReportId: "test-owner", quotedInstruction: "Complete this card" };
const registries = { roles: ["implementer"], capabilities: [] };
function board() {
  const dir = mkdtempSync(join(tmpdir(), "machine-command-"));
  const boardPath = join(dir, "TASKS.md");
  const card = (dependencies = []) => writeCard({ boardPath, registries, authority, input: {
    title: "Task", spec: "Spec", definitionOfDone: "DoD", stoppingPoint: "Review", scope: ["src/"], priority: "P2", dependencies,
  } });
  return { dir, boardPath, card };
}

// Why: every terminal reason must be accepted; a missing claim must not be mistaken for bad input.
test("journey finish accepts all machine terminal reasons", async () => {
  const b = board();
  try {
    const cmd = createMachineCommands({ boardPath: b.boardPath });
    for (const reason of [...WORKER_DISPATCH_TERMINAL_STATES, "expired", "reclaimed"]) {
      const result = await cmd["journey.finish"]({ envelopeId: "0".repeat(32), reason });
      assert.notEqual(result.code, "invalid-input", reason);
      assert.equal(result.status, "envelope-not-active", reason);
    }
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

// Why: the command must preserve the board's done and cancellation dependency gate.
test("card completion unlocks dependency only with done true and not cancelled", async () => {
  const b = board();
  try {
    const parent = b.card(); const child = b.card([parent.cardId]);
    assert.equal(parent.ok, true); assert.equal(child.ok, true);
    const cmd = createMachineCommands({ boardPath: b.boardPath, authorizeCard: async () => true });
    const cards = () => validateBoard(readFileSync(b.boardPath, "utf8"), registries).cards;
    const ready = () => isDispatchable(cards().find((c) => c.cardId === child.cardId), new Map(cards().map((c) => [c.cardId, c]))).dispatchable;
    assert.equal(ready(), false);
    assert.equal((await cmd["board.complete"]({ cardId: parent.cardId, authority })).ok, true);
    assert.equal(ready(), true, JSON.stringify(isDispatchable(cards().find((c) => c.cardId === child.cardId), new Map(cards().map((c) => [c.cardId, c]))).failedConditions));
    assert.equal((await cmd["board.cancel"]({ cardId: parent.cardId, authority })).ok, true);
    assert.equal(ready(), false);
    assert.equal((await cmd["board.reopen"]({ cardId: parent.cardId, authority })).ok, true);
    assert.equal(ready(), false);
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

// Why: failed spawn verification cannot release either half of a live assignment.
test("unverified holds live claim and reservation; paired settle is audited and idempotent", async () => {
  const b = board(); const routerStore = openRouterStore({ dbPath: join(b.dir, "router.db") });
  try {
    execFileSync("git", ["init", "-q"], { cwd: b.dir });
    execFileSync("git", ["-C", b.dir, "commit", "-q", "--allow-empty", "-m", "init"]);
    const card = b.card(); assert.equal(card.ok, true);
    writeFileSync(automationPolicyPath(b.boardPath), JSON.stringify({ roles: ["implementer"], placement: "container",
      maxConcurrent: 2, expiry: "2099-01-01", board: b.boardPath, riskCeiling: "low", acceptedRepositories: [b.dir] }));
    const identity = { decisionId: "d1", seatId: "seat", accountId: "acct", vectors: [{ windowId: "daily", unit: "messages", quantity: 1 }] };
    const reservationId = encodeReservationIdentity(identity);
    createReservation(routerStore, { reservationId, ...identity, now: new Date().toISOString() });
    const cmd = createMachineCommands({ boardPath: b.boardPath, routerStore, verifyMissing: async () => ({ verified: true }),
      verifySpawn: async () => ({ verified: false }), routeForClaim: () => ({ seatId: "seat", accountId: "acct", provider: "openai",
        model: "test/model", role: "implementer", effort: "default", containmentTier: "testudo", phase: "implement",
        routeDecisionDigest: "a".repeat(64), reservationId }) });
    const claimed = await cmd["board.claim"]({ cardId: card.cardId, role: "implementer" });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const envelopeId = claimed.envelope.envelopeId;
    assert.equal(claimReservation(routerStore, { reservationId, claimId: envelopeId, envelopeId, now: new Date().toISOString() }).ok, true);
    assert.equal((await cmd["reservation.verify"]({ envelopeId })).code, "unverified");
    assert.equal(readClaimsState(b.boardPath).state.claims.length, 1);
    assert.equal(getReservation(routerStore, reservationId).state, "claimed");
    const live = readClaimsState(b.boardPath).state.claims[0];
    const settled = await cmd["reservation.abandon"]({ envelopeId, idempotencyKey: "settle-one" });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(readClaimsState(b.boardPath).state.claims.length, 0);
    assert.equal(getReservation(routerStore, reservationId).state, "released");
    assert.equal((await cmd["reservation.abandon"]({ envelopeId, idempotencyKey: "settle-one" })).ok, true);
    assert.equal((await cmd["reservation.expire"]({ envelopeId, idempotencyKey: "other" })).ok, false);
    assert.equal(readClaimsState(b.boardPath).state.events.at(-1).action, "settle");
    assert.equal(reconcileReservationFromClaim(routerStore, { claim: live, now: new Date().toISOString() }).ok, false);
    assert.equal(getReservation(routerStore, reservationId).state, "released");
  } finally { closeRouterStore(routerStore); rmSync(b.dir, { recursive: true, force: true }); }
});

// Why: late verified evidence must not turn a cancelled run back into an active run.
test("durable cancel remains cancelled when a late verified receipt is recorded", async () => {
  const b = board(); const driver = await openDurableDriver({ directory: realpathSync(b.dir) });
  try {
    await driver.start({ runId: "cancelled-run", steps: [{ id: "send", kind: "external" }] });
    const intent = await driver.resume("cancelled-run");
    const cmd = createMachineCommands({ boardPath: b.boardPath, durable: { driver }, verifyReceipt: async () => true });
    assert.equal((await cmd["run.abort"]({ runId: "cancelled-run" })).state, "cancelled");
    const requestKey = intent.steps[0].requestKey;
    const late = await cmd["run.record-receipt"]({ runId: "cancelled-run", stepId: "send", requestKey,
      receipt: { requestKey, verified: true, reference: "observed-late" } });
    assert.equal(late.state, "cancelled");
    assert.equal(late.steps[0].state, "finished");
    assert.equal((await cmd["run.reconcile"]({ runId: "cancelled-run", evidence: { stepId: "send", requestKey, verified: true, reference: "observed-late" } })).state, "cancelled");
  } finally { await driver.close(); rmSync(b.dir, { recursive: true, force: true }); }
});

// Why: both transports must invoke the same command, not diverging lifecycle implementations.
test("REST and MCP dispatch the same command function", async () => {
  const calls = [];
  const commands = { "journey.finish": (args) => { calls.push(args); return { ok: true, status: args.reason }; } };
  const rest = createMachineRest(commands);
  try {
    const address = await rest.listen();
    assert.equal(address.address, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/commands/journey.finish`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "blocked" }),
    });
    assert.equal((await response.json()).status, "blocked");
    const mcp = await machineMcpMessage(commands, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "journey.finish", arguments: { reason: "blocked" } } });
    assert.equal(JSON.parse(mcp.result.content[0].text).status, "blocked");
    assert.deepEqual(calls, [{ reason: "blocked" }, { reason: "blocked" }]);
  } finally { await rest.close(); }
});
