// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only
// Production run ledger. It records outward intent before returning a request to the host.
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import durablePackage from "@earendil-works/pi-durable/package.json" with { type: "json" };
import { claimSeamLock, releaseSeamLock } from "./storage_owner_lock_pi.js";

export const DURABLE_DRIVER_PROTOCOL = "agentic-driver.run.v1";
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const copy = (value) => JSON.parse(JSON.stringify(value));
function validateId(value) {
  if (typeof value !== "string" || !ID.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    throw new Error("invalid durable identity");
  }
  return value;
}
function validatePlan(plan) {
  validateId(plan?.runId);
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 64) throw new Error("invalid step plan");
  const ids = new Set();
  for (const step of plan.steps) {
    validateId(step?.id);
    if (ids.has(step.id) || !["internal", "external"].includes(step.kind)) throw new Error("invalid or repeated step");
    ids.add(step.id);
  }
  if (Object.keys(plan).some((key) => !["runId", "steps"].includes(key)) ||
      plan.steps.some((step) => Object.keys(step).some((key) => !["id", "kind"].includes(key)))) {
    throw new Error("unsupported plan field");
  }
  return { runId: plan.runId, steps: plan.steps.map(({ id, kind }) => ({ id, kind })) };
}

/** An exclusive same-owner directory contains state.sqlite. Call close before another process opens it.
 * Returned external intents are NOT authorization to execute an effect: the host still enforces its own policy.
 */
export async function openDurableDriver({ directory }) {
  if (durablePackage.version !== "1.0.4") throw new Error("pi-durable 1.0.4 required");
  if (realpathSync(directory) !== directory) throw new Error("canonical storage directory required");
  const info = statSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("private same-owner storage directory required");
  }
  const lease = claimSeamLock(directory);
  let harness;
  try {
    const Runs = defineDoc({ kind: "driver.production-runs", version: 1, scope: "conversation",
      history: "latest", fork: "initial", initial: () => ({ runs: {} }) });
    const registry = createRegistry();
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")),
      { models: createModels(), registry }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT);
    // This is the pi-durable scheduler resume, not a reconstructed scheduler or replay of host effects.
    harness.resume();
    const owner = randomUUID();
    let closed = false;
    const workerFlights = new Set();
    const ensureOpen = () => { if (closed) throw new Error("durable driver closed"); };
    const snapshot = async (runId) => {
      ensureOpen();
      validateId(runId);
      const doc = await harness.snapshot(Runs, root.id, BACKGROUND_CONTEXT);
      const record = doc?.runs?.[runId];
      return record ? copy(record) : null;
    };
    const change = async (runId, update) => {
      ensureOpen();
      validateId(runId);
      return root.commit(async (tx) => {
        const record = (await tx.doc(Runs, root.id)).runs[runId];
        if (!record) throw new Error("unknown run");
        return copy(update(record));
      }, BACKGROUND_CONTEXT);
    };
    return {
      schema: DURABLE_DRIVER_PROTOCOL,
      async start(input) {
        ensureOpen();
        const plan = validatePlan(input);
        const digest = hash(JSON.stringify(plan));
        const receipt = await root.commit(async (tx) => {
          const runs = (await tx.doc(Runs, root.id)).runs;
          const previous = Object.hasOwn(runs, plan.runId) ? runs[plan.runId] : null;
          if (previous) {
            if (previous.digest !== digest) throw new Error("run identity conflict");
            return { runId: plan.runId, digest, stepIds: previous.steps.map((step) => step.correlationId ?? step.taskId) };
          }
          if (Object.values(runs).filter((run) => ["active", "held"].includes(run.state)).length >= 64) {
            throw new Error("live run capacity reached; reconciliation required");
          }
          const steps = [];
          for (const item of plan.steps) {
            const correlationId = hash(`${plan.runId}:${item.id}:${digest}`);
            steps.push({ ...item, correlationId, state: "pending", requestKey: correlationId });
          }
          runs[plan.runId] = { schema: DURABLE_DRIVER_PROTOCOL, digest, runId: plan.runId, state: "active", steps };
          return { runId: plan.runId, digest, stepIds: steps.map((step) => step.correlationId) };
        }, BACKGROUND_CONTEXT);
        harness.resume();
        return copy(receipt);
      },
      status: snapshot,
      // One external intent covers the complete host-owned invocation. The host owns
      // its result and action receipts; this ledger never replays an uncertain turn.
      async invokeWorker({ requestId, goal, transport, signal }) {
        if (typeof requestId !== "string" || !requestId || requestId.length > 256 ||
            typeof goal !== "string" || !goal || typeof transport?.invoke !== "function" ||
            !(signal instanceof AbortSignal)) throw new Error("invalid worker invocation");
        const runId = hash(`worker:${requestId}`);
        const stepId = `worker_${hash(JSON.stringify([requestId, goal]))}`;
        if (workerFlights.has(runId)) throw new Error("worker invocation already active");
        workerFlights.add(runId);
        try {
          await this.start({ runId, steps: [{ id: stepId, kind: "external" }] });
          const before = await this.status(runId);
          if (before.state !== "active" || before.steps[0].state !== "pending") {
            return { runId, state: before.state === "finished" ? "finished" : "held", step: before.steps[0] };
          }
          if (signal.aborted) {
            await this.cancel(runId);
            return { runId, state: "cancelled" };
          }
          const active = await this.resume(runId);
          const step = active.steps[0];
          // The intent has committed before crossing the worker boundary.
          const onAbort = () => { void this.cancel(runId).catch(() => {}); };
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            if (signal.aborted) { await this.cancel(runId); return { runId, state: "cancelled" }; }
            const delivered = await transport.invoke({ requestId, goal, requestKey: step.requestKey, signal });
            if (signal.aborted) { await this.cancel(runId); return { runId, state: "cancelled" }; }
            if (delivered?.verified !== true || typeof delivered.reference !== "string" ||
                !delivered.reference || delivered.reference.length > 512) {
              throw new Error("verified worker receipt required");
            }
            await this.report(runId, { stepId, requestKey: step.requestKey,
              receipt: { requestKey: step.requestKey, verified: true, reference: delivered.reference } });
            return { runId, state: "finished", result: delivered.result };
          } finally { signal.removeEventListener("abort", onAbort); }
        } finally { workerFlights.delete(runId); }
      },
      // Resume advances only to the first unfinished step. An external intent is persisted
      // before being returned. After interruption, an unreceipted intent is held, not reissued.
      async resume(runId) {
        return change(runId, (run) => {
          if (run.state !== "active") return run;
          const step = run.steps.find((item) => item.state !== "finished");
          if (!step) { run.state = "finished"; return run; }
          if (step.state === "intent" && step.intentOwner !== owner) {
            step.state = "held"; run.state = "held"; return run;
          }
          if (step.state === "pending") {
            step.state = step.kind === "external" ? "intent" : "ready";
            if (step.state === "intent") step.intentOwner = owner;
          }
          return run;
        });
      },
      // Only the host can prove an effect was never sent. This is a new attempt with a new key;
      // an unknown send outcome must remain held and must not use this operation.
      async release(runId, evidence) {
        validateId(evidence?.stepId);
        return change(runId, (run) => {
          const step = run.steps.find((item) => item.id === evidence.stepId);
          if (run.state !== "held" || step?.kind !== "external" || step.state !== "held" ||
              step.requestKey !== evidence.requestKey) throw new Error("unknown held intent");
          if (evidence.verifiedNotSent !== true || typeof evidence.reference !== "string" ||
              !evidence.reference || evidence.reference.length > 512 ||
              Object.keys(evidence).some((key) => !["stepId", "requestKey", "verifiedNotSent", "reference"].includes(key))) {
            throw new Error("not-sent proof required");
          }
          step.releases = [...(step.releases ?? []), { requestKey: step.requestKey, reference: evidence.reference }];
          step.requestKey = hash(`${step.requestKey}:${randomUUID()}`);
          step.intentOwner = owner;
          step.state = "intent";
          run.state = "active";
          return run;
        });
      },
      // A report is evidence only. External effects require an independently verified receipt.
      async report(runId, { stepId, requestKey, receipt }) {
        validateId(stepId);
        return change(runId, (run) => {
          const step = run.steps.find((item) => item.id === stepId);
          if (!step || step.requestKey !== requestKey) throw new Error("step identity conflict");
          if (step.state === "finished") {
            if (JSON.stringify(step.receipt ?? null) !== JSON.stringify(receipt ?? null)) throw new Error("receipt conflict");
            return run;
          }
          if (run.state !== "active" || step !== run.steps.find((item) => item.state !== "finished")) {
            throw new Error("step is not active");
          }
          if (step.kind === "external") {
            if (step.state !== "intent" || receipt?.requestKey !== requestKey ||
                receipt?.verified !== true || typeof receipt.reference !== "string" ||
                !receipt.reference || receipt.reference.length > 512 ||
                Object.keys(receipt).some((key) => !["requestKey", "verified", "reference"].includes(key))) {
              throw new Error("verified external receipt required");
            }
            step.receipt = copy(receipt);
          } else if (step.state !== "ready" || receipt !== undefined) {
            throw new Error("internal step is not ready");
          }
          step.state = "finished";
          if (run.steps.every((item) => item.state === "finished")) run.state = "finished";
          return run;
        });
      },
      // Reconciliation never sends an effect. A host may provide proof for a held intent;
      // absence or disagreement leaves the run held for operator review.
      async reconcile(runId, evidence) {
        validateId(evidence?.stepId);
        return change(runId, (run) => {
          if (run.state === "cancelled") throw new Error("cancelled run cannot reconcile");
          const step = run.steps.find((item) => item.id === evidence.stepId);
          if (!step || step.kind !== "external" || step.requestKey !== evidence.requestKey) {
            throw new Error("unknown external intent");
          }
          if (step.state === "finished") {
            if (evidence.verified === true && evidence.reference === step.receipt?.reference) return run;
            throw new Error("reconciliation conflict");
          }
          if (!["held", "intent"].includes(step.state)) throw new Error("unknown external intent");
          if (evidence.verified === true && typeof evidence.reference === "string" &&
              evidence.reference.length > 0 && evidence.reference.length <= 512) {
            step.receipt = { requestKey: step.requestKey, verified: true, reference: evidence.reference };
            step.state = "finished";
            if (run.state !== "cancelled") run.state = run.steps.every((item) => item.state === "finished") ? "finished" : "active";
          } else { step.state = "held"; if (run.state !== "cancelled") run.state = "held"; }
          return run;
        });
      },
      async cancel(runId) {
        return change(runId, (run) => { if (run.state !== "finished") run.state = "cancelled"; return run; });
      },
      async close() {
        if (closed) return;
        if (workerFlights.size) throw new Error("worker invocation is active");
        try { await harness.close(BACKGROUND_CONTEXT); }
        finally { closed = true; releaseSeamLock(lease); }
      },
    };
  } catch (error) {
    try { if (harness) await harness.close(BACKGROUND_CONTEXT); }
    finally { releaseSeamLock(lease); }
    throw error;
  }
}
