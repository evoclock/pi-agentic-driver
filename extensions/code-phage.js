// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  analyzeCodePhage,
  assessScopeDrift,
  compareCodePhagePlan,
} from "../lib/code-phage-core.mjs";

export const CODE_PHAGE_TOOL = "code_phage";
export const CODE_PHAGE_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 4_000 },
    candidatePaths: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1_024 },
    },
    acceptedRequirements: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 4_000 },
    },
    testPaths: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 4_000 },
    },
    phase: { type: "string", enum: ["plan", "review"] },
    credits: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          version: { type: "string" },
          license: { type: "string" },
          accessed: { type: "string" },
        },
        required: ["source", "version", "license", "accessed"],
      },
    },
  },
  required: ["goal"],
});

function resultText(value) {
  return JSON.stringify(value, null, 2);
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: resultText(value) }],
    details: value,
  };
}

function pathFromToolCall(event) {
  const input = event?.input;
  if (!input || typeof input !== "object") return undefined;
  const path = input.path ?? input.file_path;
  return typeof path === "string" ? path : undefined;
}

export default function codePhage(pi) {
  const active = {
    goal: undefined,
    candidatePaths: [],
    plan: undefined,
  };

  pi.on?.("session_start", () => {
    active.goal = undefined;
    active.candidatePaths = [];
    active.plan = undefined;
  });

  pi.on?.("tool_call", (event, ctx) => {
    if (!active.goal) return undefined;
    if (!["write", "edit", "apply_patch", "Write", "Edit"].includes(event?.toolName)) return undefined;
    const path = pathFromToolCall(event);
    if (!path) return undefined;
    let warning;
    try {
      warning = assessScopeDrift(active.goal, active.candidatePaths, path);
    } catch {
      warning = { status: "possible-drift", path, reason: "the proposed path could not be safely classified" };
    }
    if (!warning) return undefined;
    ctx?.ui?.notify?.(
      `code-phage: possible scope drift for ${path}. ${warning.reason}. Recheck the accepted goal and deletion test; no action was blocked.`,
      "warning",
    );
    return undefined;
  });

  pi.registerTool({
    name: CODE_PHAGE_TOOL,
    label: "Code Phage",
    description: "Advisory code-bloat and scope-alignment review. It checks prior art, measures diagnostic complexity signals, compares candidate scope with the stated goal, and never mutates or blocks work.",
    promptSnippet: "Use before and after bounded implementation work to check prior art, complexity, deletion justification, and scope drift.",
    promptGuidelines: [
      "Provide the structural goal, not approval records, leases, hashes, commands, or authority mechanics.",
      "Treat cognitive complexity, cyclomatic complexity, line count, and duplication as diagnostic signals, not universal rejection thresholds.",
      "Use the possible scope-drift warning to return to the accepted goal; this tool never blocks or mutates work.",
    ],
    parameters: CODE_PHAGE_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const value = analyzeCodePhage({
          root: ctx?.cwd || process.cwd(),
          goal: params?.goal,
          candidatePaths: params?.candidatePaths,
          phase: params?.phase || "plan",
          credits: params?.credits,
          acceptedRequirements: params?.acceptedRequirements,
          testPaths: params?.testPaths,
        });
        if (value.phase === "plan") {
          active.plan = value;
        } else {
          value.comparison = compareCodePhagePlan(active.plan, value);
        }
        active.goal = value.goal;
        active.candidatePaths = value.budget.candidateFiles;
        return toolResult(value);
      } catch (error) {
        return toolResult({
          schema: "agentic-driver.code-phage.v1",
          status: "advisory-error",
          advisoryOnly: true,
          authorityCreated: false,
          mutated: false,
          error: error instanceof Error ? error.message : String(error),
          nextAction: "Correct the structural goal or repository context; no source mutation was performed.",
        });
      }
    },
  });
}
