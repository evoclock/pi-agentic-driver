// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { openDurableAssignmentFixture as open, openDurableSeamStore } from "../scripts/enforcement/durable_assignment_pi.js";

const fixtureRoot = fileURLToPath(new URL("../scratch/durable-assignment-fixture/", import.meta.url));
mkdirSync(join(fixtureRoot, "evidence"), { recursive: true, mode: 0o700 });
const directory = () => mkdtempSync(join(fixtureRoot, "evidence/run-"));
const assignment = (changes = {}) => ({ requestId: "request-1", assignmentId: "assignment-1", envelopeRef: "fixture-envelope", artifact: "fixture-head", role: "worker", brief: "offline test", scope: ["fixture"], ...changes });
function fake() {
  return {
    schema: "fixture.fake-transport.v1", sends: [], report: undefined,
    async send(input) { this.sends.push(input); return { deliveryId: `delivery-${this.sends.length}` }; },
    async observe() { return this.report; },
  };
}
async function until(fixture, receipt, predicate) {
  for (let i = 0; i < 200; i++) {
    const record = await fixture.status(receipt);
    if (predicate(record)) return record;
    await sleep(10);
  }
  assert.fail(`fixture did not settle: ${JSON.stringify(await fixture.status(receipt))}`);
}
async function using(t, options = {}) {
  const transport = options.transport ?? fake();
  const dir = options.directory ?? directory();
  const fixture = await open({ directory: dir, transport, ...options });
  t.after(() => fixture.close());
  return { fixture, transport, dir };
}

test("admission returns without send; same identity survives reopen and conflicting reuse refuses", async (t) => {
  const { fixture, transport, dir } = await using(t);
  const receipt = await fixture.admit(assignment());
  assert.equal(transport.sends.length, 0);
  assert.equal((await fixture.status(receipt)).disposition, "admitted");
  await assert.rejects(fixture.admit(assignment({ brief: "changed" })), /identity conflict/);
  await fixture.close();
  const reopened = await open({ directory: dir, transport });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.admit(assignment()), receipt);
  assert.equal((await reopened.status(receipt)).disposition, "admitted");
});

test("single owner, missing storage, missing task definition and non-fake transport refuse", async (t) => {
  const { dir, transport } = await using(t);
  await assert.rejects(open({ directory: dir, transport }), /EEXIST/);
  await assert.rejects(open({ directory: join(dir, "absent"), transport }), /ENOENT/);
  await assert.rejects(open({ directory: dir, transport, registerTask: false }), /definition required/);
  await assert.rejects(open({ directory: dir, transport: {} }), /fake fixture transport required/);
  assert.equal(transport.sends.length, 0);
});

test("role idle and stale, foreign, out-of-order or oversized reports cannot settle this assignment", async (t) => {
  const { fixture, transport, dir } = await using(t);
  const receipt = await fixture.admit(assignment());
  fixture.resume();
  await until(fixture, receipt, (r) => r.disposition === "acknowledged");
  const exact = { deliveryId: "delivery-1", assignmentId: "assignment-1", artifact: "fixture-head", role: "worker", text: "reviewable artifact" };
  for (const report of [{ roleState: "idle" }, { ...exact, deliveryId: "old" }, { ...exact, assignmentId: "other" }, { ...exact, artifact: "old-head" }, { ...exact, role: "foreign" }, { ...exact, text: "x".repeat(16385) }]) {
    transport.report = report;
    await sleep(65);
    assert.equal((await fixture.status(receipt)).disposition, "acknowledged");
  }
  transport.report = exact;
  const record = await until(fixture, receipt, (r) => r.disposition === "reported");
  assert.deepEqual(record.report, exact);
  assert.equal(transport.sends.length, 1);
  // No owner completion or canonical board state exists in this adapter.
  assert.equal(receipt.nonAuthorizing, true);
  await fixture.close();
  const reopened = await open({ directory: dir, transport });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.status(receipt)).report, exact);
  reopened.resume(); await sleep(65);
  assert.equal(transport.sends.length, 1);
});

test("targeted cancel/hold survive restart without sending or affecting newer work", async (t) => {
  const { fixture, transport, dir } = await using(t);
  const old = await fixture.admit(assignment());
  const held = await fixture.admit(assignment({ requestId: "held", assignmentId: "held" }));
  const newer = await fixture.admit(assignment({ requestId: "new", assignmentId: "new" }));
  await fixture.control(old, "cancel");
  await fixture.control(held, "hold");
  await assert.rejects(fixture.control({ ...old, digest: "forged" }, "cancel"), /unknown fixture receipt/);
  await fixture.close();
  const reopened = await open({ directory: dir, transport });
  t.after(() => reopened.close());
  reopened.resume();
  await until(reopened, newer, (r) => r.disposition === "acknowledged");
  assert.equal((await reopened.status(old)).disposition, "cancelled");
  assert.equal((await reopened.status(held)).disposition, "held");
  assert.deepEqual(transport.sends.map((a) => a.assignmentId), ["new"]);
});

test("cancel during dispatch boundary prevents the not-yet-started send", async (t) => {
  const transport = fake();
  let fixture, receipt;
  ({ fixture } = await using(t, { transport, boundary: async (name) => { if (name === "after-intent") await fixture.control(receipt, "cancel"); } }));
  receipt = await fixture.admit(assignment());
  fixture.resume();
  await until(fixture, receipt, (r) => r.disposition === "cancelled");
  await sleep(65);
  assert.equal(transport.sends.length, 0);
});

test("cancellation during in-flight send preserves ack but never attributes a later report", async (t) => {
  const transport = fake();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  transport.send = async function(input) { this.sends.push(input); await gate; return { deliveryId: "in-flight" }; };
  const { fixture } = await using(t, { transport });
  const receipt = await fixture.admit(assignment());
  fixture.resume();
  await until(fixture, receipt, () => transport.sends.length === 1);
  await fixture.control(receipt, "cancel");
  release();
  const record = await until(fixture, receipt, (r) => r.deliveryId === "in-flight");
  assert.equal(record.disposition, "cancelled");
  assert.equal(record.report, undefined);
});

test("send/observation failures hold instead of retrying effects", async (t) => {
  const transport = fake();
  transport.send = async function(input) { this.sends.push(input); throw new Error("ambiguous ack"); };
  const { fixture } = await using(t, { transport });
  const receipt = await fixture.admit(assignment());
  fixture.resume();
  assert.equal((await until(fixture, receipt, (r) => r.disposition === "held")).reason, "delivery-unknown");
  fixture.resume(); await sleep(65);
  assert.equal(transport.sends.length, 1);
  const other = fake(); other.observe = async () => { throw new Error("read failure"); };
  const { fixture: observer } = await using(t, { transport: other });
  const r = await observer.admit(assignment()); observer.resume();
  assert.equal((await until(observer, r, (record) => record.disposition === "held")).reason, "observation-failed");
});

for (const [crashAt, sends, expected] of [["after-admit", 0, "acknowledged"], ["after-intent", 0, "held"], ["after-send", 1, "held"], ["after-ack", 1, "acknowledged"]]) {
  test(`real process exit at ${crashAt}: retained checkpoint and no ambiguous replay`, async (t) => {
    const dir = directory();
    const child = spawnSync(process.execPath, [join(fixtureRoot, "crash-runner.mjs"), dir, crashAt], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 73, child.stderr);
    const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    const sent = existsSync(join(dir, "sent.log")) ? readFileSync(join(dir, "sent.log"), "utf8").trim().split("\n").length : 0;
    assert.equal(sent, sends);
    const transport = fake();
    // Restart refuses a stale lock. The parent owns this exact fixture and has
    // observed child exit; it deliberately retains/quarantines only that lock.
    await assert.rejects(open({ directory: dir, transport }), /EEXIST/);
    renameSync(join(dir, "owner.lock"), join(dir, "exited-owner.lock"));
    const reopened = await open({ directory: dir, transport });
    t.after(() => reopened.close());
    reopened.resume();
    const record = await until(reopened, receipt, (r) => r.disposition === expected);
    assert.equal(transport.sends.length, crashAt === "after-admit" ? 1 : 0);
    if (expected === "held") assert.equal(record.reason, "delivery-unknown");
    if (crashAt === "after-ack") assert.equal(record.deliveryId, "delivery-1");
    assert.deepEqual(await reopened.admit(assignment()), receipt);
  });
}

const seamRecord = (changes = {}) => ({ id: "sub-offline-1", digest: "a".repeat(64), role: "worker", repository: fixtureRoot, createdAt: 1, phase: "pending", ...changes });

test("seam store commits one stable receipt across concurrent reservation and reopen", async (t) => {
  const dir = directory();
  const store = await openDurableSeamStore({ directory: dir });
  t.after(() => store.close());
  const results = await Promise.all([store.reserve("submission", seamRecord()), store.reserve("submission", seamRecord({ createdAt: 2 }))]);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.deepEqual(results[0].record, results[1].record);
  await store.update("submission", "sub-offline-1", "a".repeat(64), { phase: "accepted", deliveryId: "dlv-offline-1" });
  await store.close();
  const reopened = await openDurableSeamStore({ directory: dir });
  t.after(() => reopened.close());
  assert.equal((await reopened.get("submission", "sub-offline-1")).deliveryId, "dlv-offline-1");
  assert.equal((await reopened.reserve("submission", seamRecord())).created, false);
  await assert.rejects(reopened.reserve("submission", seamRecord({ digest: "b".repeat(64) })), /identity conflict/);
  await assert.rejects(reopened.update("submission", "sub-offline-1", "b".repeat(64), { phase: "accepted" }), /unknown seam identity/);
});

test("seam store refuses raw snapshots, prompts, unproved reports and mutable identities", async (t) => {
  const store = await openDurableSeamStore({ directory: directory() });
  t.after(() => store.close());
  for (const field of ["pre", "post", "sentPrompt", "prompt", "snapshot", "reportMarkers"]) {
    await assert.rejects(store.reserve("submission", seamRecord({ [field]: "must not persist" })), /unsupported seam field/);
  }
  await store.reserve("submission", seamRecord());
  await assert.rejects(store.update("submission", "sub-offline-1", "a".repeat(64), { role: "other" }), /immutable seam identity/);
  const delivery = seamRecord({ id: "dlv-offline-1", phase: undefined, state: "delivered" });
  delete delivery.phase;
  await store.reserve("delivery", delivery);
  await assert.rejects(store.update("delivery", delivery.id, delivery.digest, { report: "unproved" }), /proof required/);
  await store.update("delivery", delivery.id, delivery.digest, { state: "answered", report: "proven report", proof: "snapshot-backed-v1" });
  await assert.rejects(store.update("delivery", delivery.id, delivery.digest, { state: "answered", report: "replacement", proof: "snapshot-backed-v1" }), /immutable/);
  assert.equal((await store.get("delivery", delivery.id)).report, "proven report");
});

test("seam store refuses competing owners and preserves tombstones when full", async (t) => {
  const dir = directory();
  const store = await openDurableSeamStore({ directory: dir });
  t.after(() => store.close());
  await assert.rejects(openDurableSeamStore({ directory: dir }), /EEXIST/);
  for (let i = 0; i < 64; i++) await store.reserve("submission", seamRecord({ id: `sub-${i}` }));
  await assert.rejects(store.reserve("submission", seamRecord({ id: "sub-overflow" })), /capacity reached/);
  assert.equal((await store.get("submission", "sub-0")).phase, "pending");
  await store.close();
  await assert.rejects(store.get("submission", "sub-0"), /closed/);
});
