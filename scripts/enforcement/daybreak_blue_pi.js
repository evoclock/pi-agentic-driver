// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localModelsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "daybreak_blue_models.local.json");

function configuredDaybreakModels() {
  const fromEnv = (process.env.PAD_DAYBREAK_MODELS || "").split(/[,\s]+/).filter(Boolean);
  let fromFile = [];
  if (existsSync(localModelsPath)) {
    const parsed = JSON.parse(readFileSync(localModelsPath, "utf8"));
    if (Array.isArray(parsed.models)) fromFile = parsed.models.filter((name) => typeof name === "string" && name);
  }
  return new Set([...fromEnv, ...fromFile]);
}

// Applied by Pi's before_provider_request hook to the *serialized* Codex
// Responses body, before both SSE and WebSocket transports send it.
export function daybreakBluePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const programs = payload.access_programs;
  const validPrograms = programs && typeof programs === "object" && !Array.isArray(programs);
  const hasInstructions = typeof payload.instructions === "string";
  const hasInput = Array.isArray(payload.input);
  const codexBody = payload.store === false && Array.isArray(payload.include) &&
    payload.include.includes("reasoning.encrypted_content") && (hasInstructions || hasInput);
  // The request body, not the session-selected (possibly virtual) ctx.model, is authoritative.
  // Model ids are owner-provisioned (local config or PAD_DAYBREAK_MODELS) so the public
  // package does not ship a profile-specific model name.
  if (configuredDaybreakModels().has(payload.model) && codexBody) {
    return { ...payload, access_programs: { ...(validPrograms ? programs : {}), cyber: "daybreak_blue" } };
  }
  // Pi swallows handler exceptions; always remove a previous hook's Daybreak on
  // any other request, including malformed bodies and routed standard models.
  if (validPrograms && !Object.hasOwn(programs, "cyber")) return undefined;
  if (programs === undefined) return undefined;
  const { access_programs: _previous, ...body } = payload;
  if (!validPrograms) return body;
  const { cyber: _ignored, ...rest } = programs;
  return Object.keys(rest).length ? { ...body, access_programs: rest } : body;
}

export function registerDaybreakBlue(pi) {
  pi.on("before_provider_request", (event) => daybreakBluePayload(event.payload));
}
