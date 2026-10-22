// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
// Packaged document store for dispatch and an isolated development-only assignment fixture.
import { createHash } from "node:crypto";
import { mkdirSync, rmdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimSeamLock, releaseSeamLock } from "./storage_owner_lock_pi.js";
export { claimSeamLock, releaseSeamLock } from "./storage_owner_lock_pi.js";
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
  const [{ Harness, createRegistry, defineDoc, defineTask, defineExtension }, { openNodeSqliteStorage },
    { createModels }, { BACKGROUND_CONTEXT: context }, { default: durablePackage }] = await Promise.all([
    import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-durable/storage/sqlite/node"),
    import("@earendil-works/pi-ai/models"),
    import("@earendil-works/chord/context"),
    import("@earendil-works/pi-durable/package.json", { with: { type: "json" } }),
  ]);
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

// Bounded persistence for Herdr effects. Durable tasks own journey checkpoints;
// this store keeps identities and attributed reports, never prompts or pane history.
// Cross-process ownership remains a host lock, outside pi-durable's scheduler.
export async function openDurableSeamStore({ directory, orphanWaitMs = 30_000 }) {
  if (!Number.isSafeInteger(orphanWaitMs) || orphanWaitMs < 1 || orphanWaitMs > 60_000) {
    throw new Error("invalid orphan wait bound");
  }
  const [{ Harness, createRegistry, defineDoc, defineTask, defineExtension }, { openNodeSqliteStorage },
    { BACKGROUND_CONTEXT: context }, { default: durablePackage }] = await Promise.all([
    import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-durable/storage/sqlite/node"),
    import("@earendil-works/chord/context"),
    import("@earendil-works/pi-durable/package.json", { with: { type: "json" } }),
  ]);
  if (durablePackage.version !== "1.0.4") throw new Error("dispatch store requires pi-durable 1.0.4");
  if (realpathSync(directory) !== directory) throw new Error("canonical seam directory required");
  const info = statSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("private same-owner seam directory required");
  }
  const lock = claimSeamLock(directory);
  let harness;
  try {
    const Records = defineDoc({ kind: "driver.seam-records", version: 1, scope: "conversation",
      history: "latest", fork: "initial", initial: () => ({ submission: {}, delivery: {}, journey: {} }) });
    const OutwardRecords = defineDoc({ kind: "driver.outward-records", version: 1, scope: "conversation",
      history: "latest", fork: "initial", initial: () => ({ outward: {} }) });
    const active = new Map();
    const attached = async (task, runtime, ctx) => {
      if (!active.has(task.input.id)) await runtime.sleep(runtime.now() + orphanWaitMs, ctx);
      const call = active.get(task.input.id);
      if (!call) await runtime.commit(() => terminal("blocked"), ctx);
      return call;
    };
    const terminal = (state, report) => ({ status: "terminal", outcome: { status: "completed",
      result: { state, ...(report ? { report } : {}) } } });
    const checkpoint = (phase, report, tick = 0) => ({ status: "running", checkpoint: {
      phase, ...(report ? { report } : {}), tick,
    } });
    const Journey = defineTask({
      name: "driver.herdr-iteration", version: 1, initial: () => ({ phase: "admitted" }),
      phases: {
        admitted: async (task, runtime, ctx) => {
          const call = await attached(task, runtime, ctx);
          if (!call) return;
          await call.boundary?.("before-send");
          await runtime.commit(() => checkpoint("in-flight"), ctx);
          let exchange;
          try { exchange = await call.send(runtime.signal); }
          catch { await runtime.commit(() => terminal("blocked"), ctx); return; }
          await call.boundary?.("after-exchange");
          if (exchange?.ok !== true || exchange.promptSent !== true || typeof exchange.report !== "string" ||
              !exchange.report || Buffer.byteLength(exchange.report, "utf8") > 32768) {
            await runtime.commit(() => terminal("blocked"), ctx);
            return;
          }
          await runtime.commit(() => checkpoint("assignment-sent"), ctx);
          await call.boundary?.("after-send");
          await runtime.commit(() => checkpoint("result-received", exchange.report), ctx);
          await call.boundary?.("after-result");
          await runtime.commit(() => terminal("verified", exchange.report), ctx);
        },
        "in-flight": async (task, runtime, ctx) => {
          const call = await attached(task, runtime, ctx);
          if (!call) return;
          let observation;
          try { observation = await call.observe(runtime.signal); } catch { /* Unknown is not non-delivery. */ }
          if (!observation?.present) { await runtime.commit(() => terminal("blocked"), ctx); return; }
          await runtime.commit(() => checkpoint("assignment-sent"), ctx);
          if (typeof observation.report === "string" && observation.report &&
              Buffer.byteLength(observation.report, "utf8") <= 32768) {
            await runtime.commit(() => checkpoint("result-received", observation.report), ctx);
          }
        },
        "assignment-sent": async (task, runtime, ctx) => {
          const call = await attached(task, runtime, ctx);
          if (!call) return;
          let observation;
          try { observation = await call.observe(runtime.signal); } catch { /* Preserve uncertainty. */ }
          if (!observation?.present) { await runtime.commit(() => terminal("blocked"), ctx); return; }
          if (typeof observation.report === "string" && observation.report &&
              Buffer.byteLength(observation.report, "utf8") <= 32768) {
            await runtime.commit(() => checkpoint("result-received", observation.report), ctx);
            return;
          }
          if ((task.state.checkpoint.tick ?? 0) >= 120) {
            await runtime.commit(() => terminal("blocked"), ctx);
            return;
          }
          await runtime.sleep(runtime.now() + 1000, ctx);
          await runtime.commit(() => checkpoint("assignment-sent", undefined, (task.state.checkpoint.tick ?? 0) + 1), ctx);
        },
        "result-received": async (task, runtime, ctx) => {
          await runtime.commit(() => terminal("verified", task.state.checkpoint.report), ctx);
        },
      },
      abort: async (_task, runtime, ctx) => runtime.commit(() => terminal("blocked"), ctx),
    });
    const Outward = defineTask({
      name: "driver.outward-effect", version: 1, initial: () => ({ phase: "admitted" }),
      phases: {
        admitted: async (task, runtime, ctx) => {
          const call = await attached(task, runtime, ctx);
          if (!call) return;
          await call.boundary?.("before-effect");
          await runtime.commit(() => checkpoint("in-flight"), ctx);
          try { await call.apply(runtime.signal); }
          catch { /* An error does not prove that the remote effect failed. */ }
          await call.boundary?.("after-effect");
          let proof;
          try { proof = await call.observe(runtime.signal); } catch { /* Hold on uncertainty. */ }
          await runtime.commit(() => terminal(proof?.verified === true ? "verified" : "blocked",
            proof?.verified === true ? proof.reference : undefined), ctx);
        },
        "in-flight": async (task, runtime, ctx) => {
          const call = await attached(task, runtime, ctx);
          if (!call) return;
          let proof;
          try { proof = await call.observe(runtime.signal); } catch { /* Never replay the effect. */ }
          await runtime.commit(() => terminal(proof?.verified === true ? "verified" : "blocked",
            proof?.verified === true ? proof.reference : undefined), ctx);
        },
      },
      abort: async (_task, runtime, ctx) => runtime.commit(() => terminal("blocked"), ctx),
    });
    // Satisfy the pinned Models interface without importing a provider registry.
    // Every model/auth operation fails closed; this store supports documents only.
    const models = Object.freeze(Object.fromEntries([
      "getProviders", "getProvider", "getModels", "getModel", "getModelsOfType", "getModelOfType", "getAllModels",
      "refresh", "checkAuth", "getAvailable", "getAvailableOfType", "getAllAvailable", "getAuth", "login", "logout",
      "stream", "complete", "streamSimple", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred",
      "generateImages", "classify",
    ].map((name) => [name, () => { throw new Error("model operations are disabled for the document store"); }])));
    const registry = createRegistry();
    registry.install(defineExtension({ name: "driver.herdr-iteration", tasks: [Journey, Outward] }));
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")),
      { models, registry }, context);
    const root = await harness.root(context);
    let closed = false;
    const identity = ["id", "digest", "role", "repository", "createdAt"];
    const requiredIdentity = {
      submission: identity,
      delivery: identity,
      journey: identity,
      outward: ["id", "digest", "repository", "createdAt"],
    };
    const fields = {
      submission: new Set([...identity, "phase", "acceptedAt", "deliveryId"]),
      delivery: new Set([...identity, "state", "acceptedAt", "code", "report", "answeredAt", "proof"]),
      journey: new Set([...identity, "journeyId", "iteration", "taskId", "cardId"]),
      outward: new Set([...requiredIdentity.outward, "kind", "journeyId"]),
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
      if (!partial && requiredIdentity[kind].some((key) => record[key] === undefined)) {
        throw new Error("missing seam identity");
      }
      if (record.digest !== undefined && !/^[a-f0-9]{64}$/.test(record.digest)) throw new Error("invalid seam digest");
      if (record.report !== undefined && kind === "delivery" && (record.state !== "answered" || record.proof !== "snapshot-backed-v1")) {
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
        if (kind === "journey") throw new Error("journey state belongs to the task scheduler");
        checkHandle(kind, id);
        const snapshot = await harness.snapshot(Records, root.id, context);
        return structuredClone(snapshot?.[kind]?.[id]);
      },
      async reserve(kind, record) {
        if (kind === "journey") throw new Error("journey admission belongs to the task scheduler");
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
      async listJourneys() {
        if (closed) throw new Error("seam store closed");
        const snapshot = await harness.snapshot(Records, root.id, context);
        return Promise.all(Object.values(snapshot?.journey ?? {}).map(async ({ taskRef, ...entry }) => {
          const task = await harness.getTask(taskRef, context);
          const settled = task?.state.status === "terminal" ? task.state.outcome?.result : undefined;
          return { ...structuredClone(entry), state: settled?.state ?? task?.state.checkpoint?.phase ?? "blocked",
            ...(settled?.report ? { report: settled.report } : {}) };
        }));
      },
      async runJourneyStep(record, handlers) {
        check("journey", record);
        checkHandle("journey", record.id);
        if (active.has(record.id)) throw new Error("journey is already running");
        active.set(record.id, handlers);
        try {
          const taskRef = await root.commit(async (tx) => {
            const index = (await tx.doc(Records, root.id)).journey;
            if (index[record.id]) {
              if (index[record.id].digest !== record.digest || index[record.id].repository !== record.repository ||
                  index[record.id].role !== record.role || index[record.id].taskId !== record.taskId) {
                throw new Error("journey identity conflict");
              }
              return index[record.id].taskRef;
            }
            if (Object.keys(index).length >= 64) throw new Error("journey capacity reached; reconcile before admitting more");
            const taskRef = await tx.createTask(Journey, { id: record.id }, { ownership: { kind: "conversation" } });
            index[record.id] = { ...structuredClone(record), taskRef };
            return taskRef;
          }, context);
          harness.resume();
          const task = await harness.waitForTask(taskRef, context);
          if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") {
            throw new Error("durable journey task did not settle safely");
          }
          return structuredClone(task.state.outcome.result);
        } finally {
          active.delete(record.id);
        }
      },
      async runOutwardEffect(record, handlers) {
        check("outward", record);
        checkHandle("outward", record.id);
        if (typeof handlers?.apply !== "function" || typeof handlers?.observe !== "function") throw new Error("outward handlers required");
        if (active.has(record.id)) throw new Error("outward effect already running");
        active.set(record.id, handlers);
        try {
          const taskRef = await root.commit(async (tx) => {
            const index = (await tx.doc(OutwardRecords, root.id)).outward;
            const previous = index[record.id];
            if (previous) {
              if (Object.keys(record).some((key) => key !== "createdAt" && previous[key] !== record[key])) throw new Error("outward identity conflict");
              return previous.taskRef;
            }
            if (Object.keys(index).length >= 64) throw new Error("outward capacity reached; reconcile before more effects");
            const ref = await tx.createTask(Outward, { id: record.id }, { ownership: { kind: "conversation" } });
            index[record.id] = { ...structuredClone(record), taskRef: ref };
            return ref;
          }, context);
          harness.resume();
          const task = await harness.waitForTask(taskRef, context);
          if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("outward task did not settle");
          return structuredClone(task.state.outcome.result);
        } finally { active.delete(record.id); }
      },
      async update(kind, id, digest, patch) {
        if (kind === "journey") throw new Error("journey changes belong to the task scheduler");
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
        releaseSeamLock(lock);
      },
    };
  } catch (error) {
    if (harness) await harness.close(context);
    releaseSeamLock(lock);
    throw error;
  }
}
