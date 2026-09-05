// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  evaluateModeRequest,
  NATIVE_CONFIRMATION_SOURCE,
} from "./lifecycle_mode_core.js";

export const LIFECYCLE_MODE_TOOL = "agentic_work_mode";
const REGISTRATIONS = new WeakSet();

export function isNativeTuiContext(context) {
  return context?.mode === "tui"
    && context?.hasUI === true
    && typeof context?.ui?.confirm === "function";
}

function requestFrom(params = {}) {
  return {
    mode: params.mode,
    repository: params.repository,
    workspace: params.workspace,
    purpose: params.purpose,
    ...(params.action === undefined ? {} : { action: params.action }),
  };
}

function confirmationBody(request) {
  return [
    "Review this restricted semantic action.",
    `Repository: ${request.repository}`,
    `Workspace: ${request.workspace}`,
    `Action: ${request.action}`,
    `Purpose: ${request.purpose}`,
    "No card, board change, lease, work order, runtime, commit, push, or sign-off authority is created.",
  ].join("\n");
}

function unavailableNativeUi(request) {
  const result = evaluateModeRequest(request);
  return {
    ...result,
    status: "blocked",
    decision: "deny",
    reason: "native Pi TUI confirmation is unavailable",
    notice: "Open this workflow in interactive Pi TUI; no authority was created.",
    nextAction: "Open this workflow in interactive Pi TUI; no authority was created.",
  };
}

function toolResult(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

export async function evaluatePiMode(request, context = {}) {
  if (request?.mode !== "restricted") return evaluateModeRequest(request);
  if (!isNativeTuiContext(context)) return unavailableNativeUi(request);
  let confirmed;
  try {
    confirmed = await context.ui.confirm("Confirm restricted semantic action", confirmationBody(request));
  } catch (error) {
    return {
      ...evaluateModeRequest(request),
      status: "blocked",
      decision: "deny",
      reason: `native confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
      notice: "No authority was created.",
      nextAction: "No change was made.",
    };
  }
  return evaluateModeRequest(request, {
    confirmationSource: NATIVE_CONFIRMATION_SOURCE,
    confirmed,
  });
}

export function registerLifecycleModeInterface(pi, runtime = undefined) {
  if (typeof pi?.registerTool !== "function" || REGISTRATIONS.has(pi)) return;
  REGISTRATIONS.add(pi);
  pi.registerTool({
    name: LIFECYCLE_MODE_TOOL,
    label: "Agentic Work Mode",
    description: "Choose a card-free ad-hoc, planned-interactive, planned-autonomous, planned, or restricted work mode. This is the default route for ordinary read, edit, and test work, troubleshooting, context regain that does not mutate recovery state, architecture discussion, and buildout orchestration; ad-hoc work requires no card.",
    promptSnippet: "Use this card-free mode contract for ordinary work by default. Startup and read-only project status remain observe-only; explicit card, planned-assignment, dispatch, or recovery/checkpoint mutation requests use the prompted lifecycle instead.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["ad-hoc", "planned-interactive", "planned-autonomous", "planned", "restricted"] },
        repository: { type: "string" },
        workspace: { type: "string" },
        purpose: { type: "string" },
        action: { type: "string" },
      },
      required: ["mode", "repository", "workspace", "purpose"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const request = requestFrom(params);
      const result = await evaluatePiMode(request, context);
      // Keep the selected semantic mode only in the transient adapter state.
      // This is a session handoff, not a new state/approval store.  Do not
      // retain the restricted action or any adapter-derived identity here.
      if (runtime && result?.decision !== "deny" && result?.mode) {
        runtime.workMode = result.mode;
        runtime.workContext = {
          repository: result.repository,
          workspace: result.workspace,
          purpose: result.purpose,
        };
      }
      return toolResult(result);
    },
  });
}

export default registerLifecycleModeInterface;
