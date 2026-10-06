// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
// Experimental OFFLINE fixture and seam store. Not registered with Pi or included in release files.
import { createHash } from "node:crypto";
import { mkdirSync, rmdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
const terminal = (record) => ({ status: "terminal", outcome: { status: "completed", result: { disposition: record.disposition } } });
const stopped = (record) => ["held", "cancelled", "reported"].includes(record.disposition);

function bind(input) {
  const fields = ["requestId", "assignmentId", "envelopeRef", "artifact", "role", "brief"];
  if (!input || fields.some((key) => typeof input[key] !== "string" || !input[key] || input[key].length > 4000)) {
    throw new Error("invalid fixture assignment");
  }
  if (!Array.isArray(input.scope) || !input.scope.length || input.scope.some((p) => typeof p !== "string" || !p || p.length > 4000)) {
    throw new Error("invalid fixture scope");
  }
  // A fixed field order, not caller object order. This is identity, NOT admission authority.
  const assignment = Object.fromEntries(fields.map((key) => [key, input[key]]));
  assignment.scope = [...new Set(input.scope)].sort();
  return { assignment, digest: createHash("sha256").update(JSON.stringify(assignment)).digest("hex") };
}

/** Opens only a private fixture directory. Existing lock (even stale) refuses;
 * after abrupt process death an operator must reconcile that exact lock separately.
 * Fake transport is injected test code, not an OS sandbox or trusted admission API.
 */
export async function openDurableAssignmentFixture({ directory, transport, boundary = async () => {}, registerTask = true }) {
  if (transport?.schema !== "fixture.fake-transport.v1" || typeof transport.send !== "function" || typeof transport.observe !== "function") {
    throw new Error("fake fixture transport required");
  }
  if (!registerTask) throw new Error("assignment task definition required");
  const { Harness, createRegistry, defineDoc, defineTask, defineExtension, openNodeSqliteStorage, createModels, BACKGROUND_CONTEXT: context, durablePackage } =
    await import(new URL("../../scratch/durable-assignment-fixture/runtime.mjs", import.meta.url));
  if (durablePackage.version !== "1.0.4") throw new Error("fixture requires pi-durable 1.0.4");
  // Owner supplies the already-created canonical private directory; no fallback.
  if (realpathSync(directory) !== directory) throw new Error("canonical fixture directory required");
  const info = statSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("private same-owner fixture directory required");
  const lock = join(directory, "owner.lock");
  mkdirSync(lock, { mode: 0o700 }); // Atomic exclusive process ownership; no optimistic stale recovery.
  let harness;
  try {
    const Records = defineDoc({ kind: "fixture.assignments", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ records: {} }) });
    const recordFor = async (tx, conversationId, key) => (await tx.doc(Records, conversationId)).records[key];
    const finish = async (task, runtime, ctx, disposition, reason) => {
      await runtime.commit(async (tx) => {
        const record = await recordFor(tx, runtime.conversationId, task.input.key);
        if (!stopped(record)) Object.assign(record, { disposition, reason });
        return terminal(record);
      }, ctx);
    };
    const Assignment = defineTask({
      name: "fixture.external-assignment", version: 1, initial: () => ({ phase: "admitted" }),
      phases: {
        admitted: async (task, runtime, ctx) => {
          let send = false;
          await runtime.commit(async (tx) => {
            const record = await recordFor(tx, runtime.conversationId, task.input.key);
            if (stopped(record)) return terminal(record);
            record.disposition = "dispatch-intent";
            send = true;
            return { status: "running", checkpoint: { phase: "intent" } };
          }, ctx);
          if (!send) return;
          await boundary("after-intent", task.input);
          const latest = (await runtime.snapshot(Records, runtime.conversationId, ctx)).records[task.input.key];
          if (stopped(latest)) {
            await finish(task, runtime, ctx, latest.disposition, latest.reason ?? "");
            return;
          }
          runtime.signal.throwIfAborted();
          // Transport is never invoked inside a commit. Only this invocation sends;
          // a new invocation at the persisted intent phase can only hold unknown.
          let ack;
          try {
            ack = await transport.send(task.input.assignment, runtime.signal);
          } catch {
            await finish(task, runtime, ctx, "held", "delivery-unknown");
            return;
          }
          await boundary("after-send", task.input);
          runtime.signal.throwIfAborted();
          if (typeof ack?.deliveryId !== "string" || !ack.deliveryId || ack.deliveryId.length > 512) {
            await finish(task, runtime, ctx, "held", "delivery-unknown");
            return;
          }
          await runtime.commit(async (tx) => {
            const record = await recordFor(tx, runtime.conversationId, task.input.key);
            // Cancellation/hold does not erase an ack received while send was in flight.
            record.deliveryId = ack.deliveryId;
            if (stopped(record)) return terminal(record);
            record.disposition = "acknowledged";
            return { status: "running", checkpoint: { phase: "observe", tick: 0 } };
          }, ctx);
          await boundary("after-ack", task.input);
        },
        intent: async (task, runtime, ctx) => finish(task, runtime, ctx, "held", "delivery-unknown"),
        observe: async (task, runtime, ctx) => {
          const snapshot = await runtime.snapshot(Records, runtime.conversationId, ctx);
          const record = snapshot.records[task.input.key];
          if (stopped(record)) { await finish(task, runtime, ctx, record.disposition, record.reason ?? ""); return; }
          await runtime.sleep(runtime.now() + 25, ctx);
          let report;
          try { report = await transport.observe(record.deliveryId, runtime.signal); }
          catch { await finish(task, runtime, ctx, "held", "observation-failed"); return; }
          await runtime.commit(async (tx) => {
            const current = await recordFor(tx, runtime.conversationId, task.input.key);
            if (stopped(current)) return terminal(current);
            const exact = report?.deliveryId === current.deliveryId && report?.assignmentId === task.input.assignment.assignmentId &&
              report?.artifact === task.input.assignment.artifact && report?.role === task.input.assignment.role &&
              typeof report?.text === "string" && report.text.length > 0 && report.text.length <= 16384;
            if (exact) {
              current.disposition = "reported";
              current.report = { deliveryId: report.deliveryId, assignmentId: report.assignmentId, artifact: report.artifact, role: report.role, text: report.text };
              return terminal(current);
            }
            return { status: "running", checkpoint: { phase: "observe", tick: task.state.checkpoint.tick + 1 } };
          }, ctx);
        },
      },
      abort: async (task, runtime, ctx) => finish(task, runtime, ctx, "cancelled", "task-aborted"),
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "fixture.assignments", tasks: [Assignment] }));
    // No providers, environment, CodingTools or user-input submissions.
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), { models: createModels(), registry }, context);
    const root = await harness.root(context);
    let closed = false;
    return {
      async admit(input) {
        const { assignment, digest } = bind(input);
        const key = createHash("sha256").update(assignment.requestId).digest("hex");
        const receipt = await root.commit(async (tx) => {
          const records = (await tx.doc(Records, root.id)).records;
          if (records[key]) {
            if (records[key].digest !== digest) throw new Error("request identity conflict");
            return { taskId: records[key].taskId, key, digest, nonAuthorizing: true };
          }
          const taskId = await tx.createTask(Assignment, { key, assignment }, { ownership: { kind: "conversation" } });
          records[key] = { taskId, digest, disposition: "admitted" };
          return { taskId, key, digest, nonAuthorizing: true };
        }, context);
        // Scheduling is explicit and separate from admission/receipt, so submit never waits for transport.
        await boundary("after-admit", receipt);
        return receipt;
      },
      async status(receipt) {
        const records = await harness.snapshot(Records, root.id, context);
        const record = records?.records[receipt.key];
        if (!record || record.taskId !== receipt.taskId || record.digest !== receipt.digest) throw new Error("unknown fixture receipt");
        return structuredClone(record);
      },
      async control(receipt, action) {
        if (!["hold", "cancel"].includes(action)) throw new Error("unknown fixture control");
        await root.commit(async (tx) => {
          const record = await recordFor(tx, root.id, receipt.key);
          if (!record || record.taskId !== receipt.taskId || record.digest !== receipt.digest) throw new Error("unknown fixture receipt");
          if (!stopped(record)) Object.assign(record, { disposition: action === "cancel" ? "cancelled" : "held", reason: "fixture-control" });
        }, context);
        // No stop/send/close effect against any external worker or newer assignment.
      },
      resume() { harness.resume(); },
      async close() {
        if (closed) return;
        await harness.close(context);
        closed = true;
        rmdirSync(lock);
      },
    };
  } catch (error) {
    if (harness) await harness.close(context);
    rmdirSync(lock);
    throw error;
  }
}

// A bounded persistence port for the approved OFFLINE seam integration. This
// stores identity/state and already-attributed report bodies, never prompts,
// terminal history or transport authority. No task scheduler or automatic resume.
export async function openDurableSeamStore({ directory }) {
  const [{ Harness, createRegistry, defineDoc }, { openNodeSqliteStorage },
    { BACKGROUND_CONTEXT: context }, { default: durablePackage }] = await Promise.all([
    import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-durable/storage/sqlite/node"),
    import("@earendil-works/chord/context"),
    import("@earendil-works/pi-durable/package.json", { with: { type: "json" } }),
  ]);
  if (durablePackage.version !== "1.0.4") throw new Error("seam fixture requires pi-durable 1.0.4");
  if (realpathSync(directory) !== directory) throw new Error("canonical seam directory required");
  const info = statSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("private same-owner seam directory required");
  }
  const lock = join(directory, "owner.lock");
  mkdirSync(lock, { mode: 0o700 });
  let harness;
  try {
    const Records = defineDoc({ kind: "fixture.seam-records", version: 1, scope: "conversation",
      history: "latest", fork: "initial", initial: () => ({ submission: {}, delivery: {} }) });
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")),
      { registry: createRegistry() }, context);
    const root = await harness.root(context);
    let closed = false;
    const identity = ["id", "digest", "role", "repository", "createdAt"];
    const fields = {
      submission: new Set([...identity, "phase", "acceptedAt", "deliveryId"]),
      delivery: new Set([...identity, "state", "acceptedAt", "code", "report", "answeredAt", "proof"]),
    };
    function check(kind, record, partial = false) {
      if (closed) throw new Error("seam store closed");
      const allowed = fields[kind];
      if (!allowed || !record || Object.getPrototypeOf(record) !== Object.prototype) throw new Error("invalid seam record");
      if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("unsupported seam field; snapshots and prompts are forbidden");
      for (const [key, value] of Object.entries(record)) {
        const limit = key === "report" ? 16384 : 4096;
        if (key === "createdAt") {
          if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid seam timestamp");
        } else if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > limit) {
          throw new Error("invalid bounded seam field");
        }
      }
      if (!partial && identity.some((key) => record[key] === undefined)) throw new Error("missing seam identity");
      if (record.digest !== undefined && !/^[a-f0-9]{64}$/.test(record.digest)) throw new Error("invalid seam digest");
      if (record.report !== undefined && (record.state !== "answered" || record.proof !== "snapshot-backed-v1")) {
        throw new Error("attributed report proof required");
      }
    }
    function checkHandle(kind, id) {
      if (closed) throw new Error("seam store closed");
      if (!fields[kind] || typeof id !== "string" || !/^[a-z0-9-]{1,128}$/.test(id)) throw new Error("invalid seam handle");
    }
    return {
      schema: "agentic-driver.offline-seam-store.v1",
      async get(kind, id) {
        checkHandle(kind, id);
        const snapshot = await harness.snapshot(Records, root.id, context);
        return structuredClone(snapshot?.[kind]?.[id]);
      },
      async reserve(kind, record) {
        check(kind, record);
        checkHandle(kind, record.id);
        return root.commit(async (tx) => {
          const records = (await tx.doc(Records, root.id))[kind];
          const existing = records[record.id];
          if (existing) {
            if (identity.some((key) => key !== "createdAt" && existing[key] !== record[key])) throw new Error("seam identity conflict");
            // Durable commit documents are draft proxies; permitted fields are
            // primitives, so materialize the record before returning it.
            return { created: false, record: { ...existing } };
          }
          // Never evict a send tombstone to make room: eviction could enable replay.
          if (Object.keys(records).length >= 64) throw new Error("seam store capacity reached; owner reconciliation required");
          records[record.id] = structuredClone(record);
          return { created: true, record: structuredClone(record) };
        }, context);
      },
      async update(kind, id, digest, patch) {
        checkHandle(kind, id);
        check(kind, patch, true);
        if (identity.some((key) => Object.hasOwn(patch, key))) throw new Error("immutable seam identity");
        return root.commit(async (tx) => {
          const records = (await tx.doc(Records, root.id))[kind];
          const current = records[id];
          if (!current || current.digest !== digest) throw new Error("unknown seam identity");
          const next = { ...current, ...patch };
          // A hold observed by this transaction cannot be overwritten by a
          // racing ack. Keep its ack metadata, but never resume/attribute it.
          if (current.phase === "held") next.phase = "held";
          if (current.state === "held") next.state = "held";
          check(kind, next);
          // Once proven and committed, a report cannot be replaced by later text.
          if (current.state === "answered" && JSON.stringify(next) !== JSON.stringify(current)) throw new Error("answered seam record is immutable");
          records[id] = next;
          return structuredClone(next);
        }, context);
      },
      async close() {
        if (closed) return;
        await harness.close(context);
        closed = true;
        rmdirSync(lock);
      },
    };
  } catch (error) {
    if (harness) await harness.close(context);
    rmdirSync(lock);
    throw error;
  }
}
