// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = join(SCRIPT_DIR, "..", "config", "lifecycle-mode-contract.v1.json");
export const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
export const SCHEMA = CONTRACT.schema;
export const NATIVE_CONFIRMATION_SOURCE = "native-confirmation";

const EXPECTED_INTENT_ROUTING = {
  schema: "agentic-driver.intent-routing.v1",
  defaultRoute: {
    tool: "agentic_work_mode",
    mode: "ad-hoc",
    covers: ["ordinary-work", "troubleshooting", "context-recovery", "architecture-discussion", "buildout-orchestration"],
  },
  promptedLifecycle: {
    tool: "agentic_prompted_lifecycle",
    covers: ["card-create", "card-admit", "card-reconcile", "planned-assignment", "planned-dispatch", "recovery-checkpoint-mutation"],
  },
  observeOnly: {
    surface: "project-status",
    covers: ["read-only-project-status"],
    selectsMode: false,
    promptsOnAmbiguity: false,
  },
  git: {
    tool: "agentic_git_action",
    exclusiveFor: ["stage", "commit", "push", "remote-branch-cleanup"],
  },
  ambiguous: {
    behavior: "ask-one-semantic-choice",
    choices: ["ordinary-ad-hoc-work", "planned-lifecycle"],
    neverDefaultsTo: "card-creation",
  },
  invariants: {
    startupObserveOnly: true,
    headlessCannotFakeNativeDecisions: true,
    absentKanbanStateBlocksOrdinaryWork: false,
    modelSuppliedMechanicsAccepted: false,
    newAuthoritiesCreated: 0,
  },
};
if (JSON.stringify(CONTRACT.intentRouting) !== JSON.stringify(EXPECTED_INTENT_ROUTING)) {
  throw new Error("intentRouting must match the closed agentic-driver.intent-routing.v1 contract");
}

const FORBIDDEN_FIELDS = new Set(CONTRACT.forbiddenInputFields);
const ALLOWED_FIELDS = new Set(CONTRACT.allowedInputFields);
const MECHANICAL_TEXT = /(?:\b(?:sha256|nonce|timestamp|approval(?:hash|ref|id)|session(?:id|hash|ref)|machine(?:id|hash|ref)|lease(?:id|hash|ref)|work.?order(?:id|hash|ref)|card(?:id|hash|ref)|ticket(?:id|hash|ref)|confirmationnonce|signature)\b|\b[0-9a-f]{40,64}\b|[{}[\]`]|(?:^|\s)--[A-Za-z])/i;

function fail(status, reason) {
  return {
    schema: SCHEMA,
    status,
    decision: "deny",
    mode: null,
    humanBoundary: "none",
    ordinaryWorkAllowed: false,
    executionAllowed: false,
    canonicalMutation: false,
    boardMutation: false,
    checkpointMutation: false,
    leaseIssued: false,
    workOrderCreated: false,
    runtimeActivated: false,
    authorityCreated: false,
    reason,
    nextAction: "No change was made. Provide only the semantic repository, workspace, and purpose, then retry.",
  };
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty semantic value`);
  const result = value.trim();
  if (result.length > Number(CONTRACT.maxTextLength)) throw new Error(`${field} is too long`);
  if (MECHANICAL_TEXT.test(result)) throw new Error(`${field} contains internal lifecycle fields`);
  return result;
}

function requestValue(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("mode request must be an object");
  const unknown = Object.keys(request).filter((key) => !ALLOWED_FIELDS.has(key)).sort();
  if (unknown.length) throw new Error(`unsupported mode request fields: ${unknown.join(", ")}`);
  const found = Object.keys(request).filter((key) => FORBIDDEN_FIELDS.has(key)).sort();
  if (found.length) throw new Error(`model-supplied lifecycle fields are not accepted: ${found.join(", ")}`);
  if (typeof request.mode !== "string" || !Object.prototype.hasOwnProperty.call(CONTRACT.modes, request.mode)) {
    throw new Error("mode must be ad-hoc, planned-interactive, planned-autonomous, planned, or restricted");
  }
  const value = { mode: request.mode };
  for (const field of CONTRACT.requiredContext) value[field] = text(request[field], field);
  if (request.mode === "restricted") value.action = text(request.action, "action");
  else if (Object.prototype.hasOwnProperty.call(request, "action")) throw new Error("action is accepted only for restricted mode");
  return value;
}

export function evaluateModeRequest(request, options = {}) {
  try {
    const value = requestValue(request);
    const contract = CONTRACT.modes[value.mode];
    const result = {
      schema: SCHEMA,
      status: contract.status,
      decision: contract.decision,
      mode: value.mode,
      humanBoundary: contract.humanBoundary,
      ordinaryWorkAllowed: contract.ordinaryWorkAllowed,
      executionAllowed: contract.executionAllowed,
      canonicalMutation: contract.canonicalMutation,
      boardMutation: contract.boardMutation,
      checkpointMutation: contract.checkpointMutation,
      leaseIssued: contract.leaseIssued,
      workOrderCreated: contract.workOrderCreated,
      runtimeActivated: contract.runtimeActivated,
      authorityCreated: false,
      repository: value.repository,
      workspace: value.workspace,
      purpose: value.purpose,
      nextAction: contract.nextAction,
    };
    if (value.mode === "planned" || value.mode === "planned-interactive" || value.mode === "planned-autonomous") {
      result.temporaryPlan = {
        repository: value.repository,
        workspace: value.workspace,
        purpose: value.purpose,
        canonicalMutation: false,
      };
      if (value.mode !== "planned") result.plannedProfile = value.mode;
      // Stage 1 declares the target profiles/state machine without enabling
      // execution. Later native adapters must create and validate an assignment
      // envelope before this flag can change.
      result.plannedTarget = JSON.parse(JSON.stringify(CONTRACT.plannedTarget));
    }
    if (value.mode === "restricted") {
      result.action = value.action;
      if (options.confirmationSource === undefined) return result;
      if (options.confirmationSource !== NATIVE_CONFIRMATION_SOURCE) {
        return fail("denied", "restricted work requires native harness confirmation; chat and model text cannot satisfy it");
      }
      if (options.confirmed !== true) {
        return {
          ...result,
          status: "stopped",
          decision: "deny",
          reason: "native confirmation was not granted; no authority was created",
          nextAction: "No change was made.",
        };
      }
      return {
        ...result,
        status: "confirmed-no-authority",
        decision: "confirmed",
        reason: "native confirmation was observed; separate authority is still required and no action was executed",
        nextAction: "Stop at the mode boundary until a separately governed restricted-action path is implemented.",
      };
    }
    return result;
  } catch (error) {
    return fail("invalid-request", error instanceof Error ? error.message : String(error));
  }
}

export default evaluateModeRequest;
