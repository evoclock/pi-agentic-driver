// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only
export declare const DURABLE_DRIVER_PROTOCOL: "agentic-driver.run.v1";

export type DurableStepKind = "internal" | "external";
export type DurableRunState = "active" | "held" | "finished" | "cancelled";
export type DurableStepState = "pending" | "ready" | "intent" | "held" | "finished";
export interface DurableStep {
  id: string;
  kind: DurableStepKind;
  state: DurableStepState;
  requestKey: string;
  correlationId?: string;
  /** Registration-only ID retained on runs written before correlation IDs replaced tasks. */
  taskId?: string;
  intentOwner?: string;
  receipt?: { requestKey: string; verified: true; reference: string };
  releases?: Array<{ requestKey: string; reference: string }>;
}
export interface DurableRun {
  schema?: typeof DURABLE_DRIVER_PROTOCOL;
  runId: string;
  digest: string;
  state: DurableRunState;
  steps: DurableStep[];
}
export interface DurableDriver {
  schema: typeof DURABLE_DRIVER_PROTOCOL;
  start(plan: { runId: string; steps: Array<{ id: string; kind: DurableStepKind }> }): Promise<{
    runId: string; digest: string; stepIds: string[];
  }>;
  status(runId: string): Promise<DurableRun | null>;
  /** One intent for the entire host-owned worker/review/verification invocation. */
  invokeWorker<Result>(input: {
    requestId: string; goal: string; signal: AbortSignal;
    transport: { invoke(input: { requestId: string; goal: string; requestKey: string; signal: AbortSignal }): Promise<{
      result: Result; verified: true; reference: string;
    }> };
  }): Promise<{ runId: string; state: "finished"; result: Result } |
    { runId: string; state: "finished" | "held"; step: DurableStep } |
    { runId: string; state: "cancelled" }>;
  resume(runId: string): Promise<DurableRun>;
  report(runId: string, report: { stepId: string; requestKey: string; receipt?: {
    requestKey: string; verified: true; reference: string;
  } }): Promise<DurableRun>;
  reconcile(runId: string, evidence: { stepId: string; requestKey: string; verified: boolean; reference?: string }): Promise<DurableRun>;
  release(runId: string, evidence: { stepId: string; requestKey: string; verifiedNotSent: true; reference: string }): Promise<DurableRun>;
  cancel(runId: string): Promise<DurableRun>;
  close(): Promise<void>;
}
export declare function openDurableDriver(options: { directory: string }): Promise<DurableDriver>;
