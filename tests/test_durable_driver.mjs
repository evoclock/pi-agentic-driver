// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDurableDriver, DURABLE_DRIVER_PROTOCOL } from "../scripts/enforcement/durable_driver_pi.js";
import { Harness } from "@earendil-works/pi-durable";

const moduleUrl = new URL("../scripts/enforcement/durable_driver_pi.js", import.meta.url).href;
function directory() { return realpathSync(mkdtempSync(join(tmpdir(), "production-driver-"))); }
function tidy(dir) {
  // Retain storage evidence in the caller-owned scratch directory rather than deleting it.
  renameSync(dir, `${dir}-retained`);
}
function child(dir, script) {
  return new Promise((resolveChild, reject) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `
      import { openDurableDriver } from ${JSON.stringify(moduleUrl)};
      const driver = await openDurableDriver({ directory: ${JSON.stringify(dir)} });
      ${script}
    `], { cwd: globalThis.process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    process.stdout.on("data", (data) => { out += data; });
    process.stderr.on("data", (data) => { err += data; });
    process.on("error", reject);
    process.on("close", (code, signal) => resolveChild({ code, signal, out, err }));
  });
}

test("production run survives kill: finished step is not repeated; unknown external action is held", async () => {
  const dir = directory();
  try {
    const first = await child(dir, `
      const admission = await driver.start({ runId: "case1", steps: [
        { id: "prepare", kind: "internal" }, { id: "publish", kind: "external" }, { id: "confirm", kind: "internal" }] });
      await driver.resume("case1");
      const before = await driver.status("case1");
      await driver.report("case1", { stepId: "prepare", requestKey: before.steps[0].requestKey });
      const intent = await driver.resume("case1");
      console.log(JSON.stringify({ admission, intent }));
      globalThis.process.kill(globalThis.process.pid, "SIGKILL");
    `);
    assert.equal(first.signal, "SIGKILL", first.err);
    const { admission, intent } = JSON.parse(first.out.trim());
    assert.equal(intent.steps[0].state, "finished");
    assert.equal(intent.steps[1].state, "intent");
    const driver = await openDurableDriver({ directory: dir });
    try {
      assert.equal(driver.schema, DURABLE_DRIVER_PROTOCOL);
      assert.deepEqual(await driver.start({ runId: "case1", steps: [
        { id: "prepare", kind: "internal" }, { id: "publish", kind: "external" }, { id: "confirm", kind: "internal" }] }), admission);
      const resumed = await driver.resume("case1");
      assert.equal(resumed.state, "held");
      assert.deepEqual(resumed.steps.map((step) => step.state), ["finished", "held", "pending"]);
      assert.equal((await driver.resume("case1")).state, "held");
      await assert.rejects(driver.report("case1", { stepId: "publish", requestKey: resumed.steps[1].requestKey,
        receipt: { requestKey: resumed.steps[1].requestKey, verified: true, reference: "proof" } }), /not active/);
      await driver.reconcile("case1", { stepId: "publish", requestKey: resumed.steps[1].requestKey, verified: false });
      assert.equal((await driver.status("case1")).state, "held");
      await driver.reconcile("case1", { stepId: "publish", requestKey: resumed.steps[1].requestKey,
        verified: true, reference: "observed-external-reference" });
      await driver.reconcile("case1", { stepId: "publish", requestKey: resumed.steps[1].requestKey,
        verified: true, reference: "observed-external-reference" });
      const next = await driver.resume("case1");
      assert.deepEqual(next.steps.map((step) => step.state), ["finished", "finished", "ready"]);
      await driver.report("case1", { stepId: "confirm", requestKey: next.steps[2].requestKey });
      assert.equal((await driver.status("case1")).state, "finished");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("worker invocation persists one intent, correlates the goal and never dispatches twice", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      let calls = 0;
      const transport = { async invoke({ goal, requestId, requestKey }) {
        calls++;
        assert.equal(goal, "already compacted goal");
        assert.equal(requestId, "outer:1");
        assert.match(requestKey, /^[a-f0-9]{64}$/);
        return { result: { kind: "verified" }, verified: true, reference: "omb-saved-result:outer:1" };
      } };
      const input = { requestId: "outer:1", goal: "already compacted goal", transport,
        signal: new AbortController().signal };
      const first = await driver.invokeWorker(input);
      assert.equal(first.state, "finished");
      assert.deepEqual(first.result, { kind: "verified" });
      assert.equal((await driver.invokeWorker(input)).state, "finished");
      assert.equal(calls, 1);
      await assert.rejects(driver.invokeWorker({ ...input, goal: "changed" }), /identity conflict/);
      assert.equal((await driver.status(first.runId)).steps[0].receipt.reference, "omb-saved-result:outer:1");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("worker abort cancels the ledger without reporting an unverified completion", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      const abort = new AbortController();
      const outcome = await driver.invokeWorker({ requestId: "outer:abort", goal: "goal", signal: abort.signal,
        transport: { async invoke() {
          abort.abort();
          return { verified: true, reference: "late-result", result: "late" };
        } } });
      assert.equal(outcome.state, "cancelled");
      assert.equal((await driver.status(outcome.runId)).state, "cancelled");
      assert.equal((await driver.invokeWorker({ requestId: "outer:abort", goal: "goal",
        signal: new AbortController().signal,
        transport: { async invoke() { throw new Error("must not replay"); } } })).state, "held");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("worker crash parks an invocation rather than replaying its transport", async () => {
  const dir = directory();
  try {
    const first = await child(dir, `
      await driver.invokeWorker({ requestId: "outer:2", goal: "opaque carry", signal: new AbortController().signal,
        transport: { async invoke() { console.log("INTENT_COMMITTED");
          globalThis.process.kill(globalThis.process.pid, "SIGKILL"); } } });
    `);
    assert.equal(first.signal, "SIGKILL", first.err);
    assert.match(first.out, /INTENT_COMMITTED/);
    const driver = await openDurableDriver({ directory: dir });
    try {
      let calls = 0;
      const input = { requestId: "outer:2", goal: "opaque carry", signal: new AbortController().signal,
        transport: { async invoke() { calls++; throw new Error("must not replay"); } } };
      const held = await driver.invokeWorker(input);
      assert.equal(held.state, "held");
      assert.equal(calls, 0);
      await driver.reconcile(held.runId, { stepId: held.step.id, requestKey: held.step.requestKey,
        verified: true, reference: "omb-observed-result" });
      assert.equal((await driver.invokeWorker(input)).state, "finished");
      assert.equal(calls, 0);
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("repeated resume on a live intent does not park its receipt", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      await driver.start({ runId: "live", steps: [{ id: "send", kind: "external" }] });
      const intent = await driver.resume("live");
      assert.equal((await driver.resume("live")).steps[0].state, "intent");
      await driver.report("live", { stepId: "send", requestKey: intent.steps[0].requestKey,
        receipt: { requestKey: intent.steps[0].requestKey, verified: true, reference: "sent" } });
      assert.equal((await driver.status("live")).state, "finished");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("held unsent intent requires explicit proof to release under a fresh key", async () => {
  const dir = directory();
  try {
    const first = await child(dir, `
      await driver.start({ runId: "unsent", steps: [{ id: "send", kind: "external" }] });
      console.log(JSON.stringify(await driver.resume("unsent")));
      globalThis.process.kill(globalThis.process.pid, "SIGKILL");
    `);
    assert.equal(first.signal, "SIGKILL", first.err);
    const intent = JSON.parse(first.out.trim());
    let driver = await openDurableDriver({ directory: dir });
    try {
      assert.equal((await driver.resume("unsent")).state, "held");
      const identity = { stepId: "send", requestKey: intent.steps[0].requestKey };
      await driver.reconcile("unsent", { ...identity, verified: false });
      assert.equal((await driver.resume("unsent")).state, "held");
      for (const evidence of [{}, { verifiedNotSent: false, reference: "unknown" },
        { verifiedNotSent: true, reference: "" }, { verifiedNotSent: true, reference: "x".repeat(513) },
        { verifiedNotSent: true, reference: "proof", extra: true }]) {
        await assert.rejects(driver.release("unsent", { ...identity, ...evidence }), /not-sent proof required/);
        assert.deepEqual(await driver.status("unsent"), await driver.resume("unsent"));
        assert.equal((await driver.status("unsent")).state, "held");
      }
      await assert.rejects(driver.release("unsent", { ...identity, requestKey: "wrong",
        verifiedNotSent: true, reference: "proof" }), /unknown held intent/);
      const released = await driver.release("unsent", { stepId: "send", requestKey: intent.steps[0].requestKey,
        verifiedNotSent: true, reference: "host-send-log-absence" });
      assert.equal(released.steps[0].state, "intent");
      assert.notEqual(released.steps[0].requestKey, intent.steps[0].requestKey);
      assert.deepEqual(released.steps[0].releases, [{ requestKey: intent.steps[0].requestKey,
        reference: "host-send-log-absence" }]);
      await assert.rejects(driver.report("unsent", { stepId: "send", requestKey: intent.steps[0].requestKey,
        receipt: { requestKey: intent.steps[0].requestKey, verified: true, reference: "old" } }), /step identity conflict/);
      await assert.rejects(driver.reconcile("unsent", { ...identity, verified: true, reference: "old" }), /unknown external intent/);
      await assert.rejects(driver.release("unsent", { stepId: "send", requestKey: released.steps[0].requestKey,
        verifiedNotSent: true, reference: "proof" }), /unknown held intent/);
      assert.equal((await driver.resume("unsent")).steps[0].state, "intent");
      await driver.close();
      driver = await openDurableDriver({ directory: dir });
      const reopened = await driver.resume("unsent");
      assert.equal(reopened.state, "held");
      assert.equal(reopened.steps[0].requestKey, released.steps[0].requestKey);
      assert.deepEqual(reopened.steps[0].releases, released.steps[0].releases);
      await driver.reconcile("unsent", { stepId: "send", requestKey: reopened.steps[0].requestKey,
        verified: true, reference: "new-attempt-observed" });
      assert.equal((await driver.status("unsent")).state, "finished");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("terminal history does not exhaust live-run capacity", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      for (let n = 0; n < 64; n++) {
        const id = `past-${n}`;
        await driver.start({ runId: id, steps: [{ id: "done", kind: "internal" }] });
        const ready = await driver.resume(id);
        await driver.report(id, { stepId: "done", requestKey: ready.steps[0].requestKey });
      }
      await driver.start({ runId: "next", steps: [{ id: "send", kind: "external" }] });
      assert.equal((await driver.status("past-0")).state, "finished");
      assert.equal((await driver.resume("next")).steps[0].state, "intent");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("64 live runs still refuse another admission while preserving idempotent starts", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      const plan = { runId: "live-0", steps: [{ id: "send", kind: "external" }] };
      const first = await driver.start(plan);
      for (let n = 1; n < 64; n++) {
        await driver.start({ runId: `live-${n}`, steps: plan.steps });
      }
      assert.deepEqual(await driver.start(plan), first);
      const intent = await driver.resume("live-0");
      await driver.reconcile("live-0", { stepId: "send", requestKey: intent.steps[0].requestKey, verified: false });
      assert.equal((await driver.status("live-0")).state, "held");
      await assert.rejects(driver.start({ runId: "overflow", steps: plan.steps }), /run capacity reached/);
      await driver.cancel("live-0");
      await driver.start({ runId: "overflow", steps: plan.steps });
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("changed-plan starts reject without changing the admitted run", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      const steps = [{ id: "prepare", kind: "internal" }, { id: "send", kind: "external" }];
      const plan = { runId: "identity", steps };
      const admission = await driver.start(plan);
      const ready = await driver.resume(plan.runId);
      for (const changed of [steps.slice(1), [...steps].reverse(),
        [{ id: "prepare", kind: "external" }, steps[1]]]) {
        await assert.rejects(driver.start({ ...plan, steps: changed }), /run identity conflict/);
        assert.deepEqual(await driver.status(plan.runId), ready);
        assert.deepEqual(await driver.start(plan), admission);
      }
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("invalid and empty plans reject without admitting a run", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      const step = { id: "work", kind: "internal" };
      for (const [input, error] of [
        [undefined, /invalid durable identity/],
        [null, /invalid durable identity/],
        [{}, /invalid durable identity/],
        [{ runId: "", steps: [step] }, /invalid durable identity/],
        [{ runId: "__proto__", steps: [step] }, /invalid durable identity/],
        [{ runId: "invalid" }, /invalid step plan/],
        [{ runId: "invalid", steps: {} }, /invalid step plan/],
        [{ runId: "invalid", steps: [] }, /invalid step plan/],
        [{ runId: "invalid", steps: Array.from({ length: 65 }, (_, n) => ({ id: `step-${n}`, kind: "internal" })) }, /invalid step plan/],
        [{ runId: "invalid", steps: [null] }, /invalid durable identity/],
        [{ runId: "invalid", steps: [{ id: "bad/id", kind: "internal" }] }, /invalid durable identity/],
        [{ runId: "invalid", steps: [{ id: "work", kind: "unknown" }] }, /invalid or repeated step/],
        [{ runId: "invalid", steps: [step, step] }, /invalid or repeated step/],
        [{ runId: "invalid", steps: [step], extra: true }, /unsupported plan field/],
        [{ runId: "invalid", steps: [{ ...step, extra: true }] }, /unsupported plan field/],
      ]) {
        await assert.rejects(driver.start(input), error);
      }
      assert.equal(await driver.status("invalid"), null);
      await driver.start({ runId: "invalid", steps: [step] });
      assert.equal((await driver.resume("invalid")).steps[0].state, "ready");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("unsafe and noncanonical directories refuse before creating storage", async () => {
  const dir = directory();
  try {
    // Keep the dot suffix: join() would normalize away the noncanonical spelling.
    await assert.rejects(openDurableDriver({ directory: `${dir}/.` }), /canonical storage directory required/);
    assert.deepEqual(readdirSync(dir), []);
    chmodSync(dir, 0o755);
    await assert.rejects(openDurableDriver({ directory: dir }), /private same-owner storage directory required/);
    assert.deepEqual(readdirSync(dir), []);
    chmodSync(dir, 0o700);
    const driver = await openDurableDriver({ directory: dir });
    await driver.close();
  } finally { tidy(dir); }
});

test("second concurrent opener refuses without disrupting the current owner", async () => {
  const dir = directory();
  try {
    let driver = await openDurableDriver({ directory: dir });
    try {
      await driver.start({ runId: "owner", steps: [{ id: "work", kind: "internal" }] });
      const ready = await driver.resume("owner");
      await assert.rejects(openDurableDriver({ directory: dir }), /storage owner is still active/);
      const refused = await child(dir, 'await driver.close(); console.log("unexpected second owner");');
      assert.equal(refused.code, 1, refused.err);
      assert.equal(refused.signal, null);
      assert.equal(refused.out, "");
      assert.match(refused.err, /storage owner is still active/);
      assert.deepEqual(await driver.status("owner"), ready);
      await driver.report("owner", { stepId: "work", requestKey: ready.steps[0].requestKey });
      await driver.close();
      driver = await openDurableDriver({ directory: dir });
      assert.equal((await driver.status("owner")).state, "finished");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("driver imports the neutral owner lock without loading the assignment fixture", () => {
  const source = readFileSync(new URL("../scripts/enforcement/durable_driver_pi.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/storage_owner_lock_pi\.js"/);
  assert.doesNotMatch(source, /from "\.\/durable_assignment_pi\.js"/);
});

test("public consumer declarations and neutral lock ship in the package", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const file of ["scripts/enforcement/storage_owner_lock_pi.js", "scripts/enforcement/durable_driver_pi.d.ts"]) {
    assert.ok(manifest.files.includes(file));
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").length > 0);
  }
});

test("driver and test carry SPDX source headers", () => {
  for (const file of ["../scripts/enforcement/durable_driver_pi.js", "./test_durable_driver.mjs"]) {
    const header = readFileSync(new URL(file, import.meta.url), "utf8").split("\n").slice(0, 2).join("\n");
    assert.match(header, /SPDX-FileCopyrightText:/);
    assert.match(header, /SPDX-License-Identifier: AGPL-3.0-only/);
  }
});

test("admission returns ledger correlation identities, not registration tasks", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      const receipt = await driver.start({ runId: "correlation", steps: [{ id: "work", kind: "internal" }] });
      const record = await driver.status("correlation");
      assert.equal(record.schema, DURABLE_DRIVER_PROTOCOL);
      assert.equal(record.steps[0].correlationId, receipt.stepIds[0]);
      assert.equal(Object.hasOwn(record.steps[0], "taskId"), false);
      assert.deepEqual(await driver.start({ runId: "correlation", steps: [{ id: "work", kind: "internal" }] }), receipt);
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("close failure releases the exclusive owner while preserving the error", async () => {
  const dir = directory();
  const original = Harness.open;
  try {
    Harness.open = async (...args) => {
      const harness = await original(...args);
      const close = harness.close.bind(harness);
      harness.close = async (...closeArgs) => {
        await close(...closeArgs);
        throw new Error("injected close failure");
      };
      return harness;
    };
    const driver = await openDurableDriver({ directory: dir });
    await assert.rejects(driver.close(), /injected close failure/);
    Harness.open = original;
    const reopened = await openDurableDriver({ directory: dir });
    await reopened.close();
  } finally { Harness.open = original; tidy(dir); }
});

test("valid toString identity is admitted without inherited-object conflict", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      const plan = { runId: "toString", steps: [{ id: "work", kind: "internal" }] };
      const receipt = await driver.start(plan);
      assert.deepEqual(await driver.start(plan), receipt);
      assert.equal((await driver.status("toString")).runId, "toString");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("unknown valid run returns null", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try { assert.equal(await driver.status("missing"), null); }
    finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("cancelled run cannot reconcile a step into finished state", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      await driver.start({ runId: "cancelled-reconcile", steps: [{ id: "send", kind: "external" }] });
      const intent = await driver.resume("cancelled-reconcile");
      await driver.cancel("cancelled-reconcile");
      await assert.rejects(driver.reconcile("cancelled-reconcile", {
        stepId: "send", requestKey: intent.steps[0].requestKey, verified: true, reference: "sent",
      }), /cancelled run/);
      assert.equal((await driver.status("cancelled-reconcile")).steps[0].state, "intent");
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});

test("cancel parks a run without replaying an intent", async () => {
  const dir = directory();
  try {
    const driver = await openDurableDriver({ directory: dir });
    try {
      await driver.start({ runId: "cancelled", steps: [{ id: "send", kind: "external" }] });
      const intent = await driver.resume("cancelled");
      assert.equal(intent.steps[0].state, "intent");
      await driver.cancel("cancelled");
      assert.equal((await driver.resume("cancelled")).state, "cancelled");
      await assert.rejects(driver.report("cancelled", { stepId: "send", requestKey: intent.steps[0].requestKey,
        receipt: { requestKey: intent.steps[0].requestKey, verified: true, reference: "x" } }), /not active/);
    } finally { await driver.close(); }
  } finally { tidy(dir); }
});
