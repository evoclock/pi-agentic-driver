// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

export const DEFAULT_STALL_CONFIG = Object.freeze({
  enabled: true,
  idleTimeoutMs: 120_000,
  repeatedToolCalls: 3,
});

export const STALL_REASONS = Object.freeze([
  "idle-timeout",
  "repeated-tool-loop",
  "blocked-brief",
]);

const REQUIRED_KEYS = Object.freeze(["enabled", "idleTimeoutMs", "repeatedToolCalls"]);
const MAX_TOOL_SIGNATURE_BYTES = 8 * 1024;
const MAX_SIGNATURE_DEPTH = 16;
const BLOCKED_LINE = /^\s*(?:\[\s*blocked(?:\s*\]|\s*:)|blocked\s*:)/im;

export function validateStallConfig(config) {
  const errors = [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, config: null, errors: ["stall: must be an object"] };
  }
  if (Object.keys(config).sort().join(",") !== REQUIRED_KEYS.slice().sort().join(",")) {
    errors.push(`stall: keys must be exactly ${REQUIRED_KEYS.join(", ")}`);
  }
  if (typeof config.enabled !== "boolean") {
    errors.push("stall.enabled: must be a boolean");
  }
  if (!Number.isSafeInteger(config.idleTimeoutMs) || config.idleTimeoutMs < 1 || config.idleTimeoutMs > 2_147_483_647) {
    errors.push("stall.idleTimeoutMs: must be a positive safe integer that fits a JavaScript timer");
  }
  if (!Number.isSafeInteger(config.repeatedToolCalls) || config.repeatedToolCalls < 2) {
    errors.push("stall.repeatedToolCalls: must be a safe integer >= 2");
  }
  return {
    ok: errors.length === 0,
    config: errors.length === 0 ? {
      enabled: config.enabled,
      idleTimeoutMs: config.idleTimeoutMs,
      repeatedToolCalls: config.repeatedToolCalls,
    } : null,
    errors,
  };
}

function canonicalJson(value, seen = new Set(), depth = 0) {
  if (depth > MAX_SIGNATURE_DEPTH) throw new Error("tool input is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("tool input is circular");
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen, depth + 1)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("tool input is circular");
    seen.add(value);
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen, depth + 1)}`).join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new Error("tool input is not JSON data");
}

function toolSignature(event) {
  if (typeof event?.toolName !== "string" || event.toolName === ""
    || event.input === null || typeof event.input !== "object" || Array.isArray(event.input)) {
    return null;
  }
  try {
    const serialized = canonicalJson({ toolName: event.toolName, input: event.input });
    if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_SIGNATURE_BYTES) return null;
    return createHash("sha256").update(serialized, "utf8").digest("hex");
  } catch {
    return null;
  }
}

function blockedReport(message) {
  if (message?.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)
    || message.content.some((block) => block?.type === "toolCall")) {
    return false;
  }
  const text = message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return BLOCKED_LINE.test(text);
}

export function buildStallNudge(reason) {
  switch (reason) {
    case "idle-timeout":
      return "No progress was observed before the idle timeout. Continue the approved goal from the last confirmed step. Do not repeat completed actions. If blocked, state [BLOCKED: reason] and stop.";
    case "repeated-tool-loop":
      return "The same tool call repeated without progress. Inspect its last result and take one different next step. If no safe step exists, state [BLOCKED: reason] and stop.";
    case "blocked-brief":
      return "You reported [BLOCKED]. State the exact blocker and stop. Do not repeat the blocked action.";
    default:
      throw new Error(`Unknown stall reason: ${String(reason)}`);
  }
}

export function createStallDetector(config = DEFAULT_STALL_CONFIG, now = () => Date.now()) {
  const validation = validateStallConfig(config);
  if (!validation.ok) throw new Error(`Invalid stall configuration: ${validation.errors.join("; ")}`);
  if (typeof now !== "function") throw new Error("A clock is required for stall detection.");
  const settings = validation.config;
  let running = false;
  let lastProgressAt = null;
  let previousToolSignature = null;
  let sameToolCalls = 0;
  let reason = null;

  const readClock = () => {
    try {
      const value = now();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const markProgress = () => {
    const current = readClock();
    if (current !== null) lastProgressAt = current;
  };

  return {
    beginRun() {
      if (!settings.enabled) return false;
      if (!running) {
        reason = null;
        previousToolSignature = null;
        sameToolCalls = 0;
      }
      running = true;
      markProgress();
      return true;
    },
    isRunning() {
      return running;
    },
    observeProgress() {
      if (!running || !settings.enabled) return null;
      markProgress();
      return reason;
    },
    observeToolCall(event) {
      if (!running || !settings.enabled) return null;
      markProgress();
      const signature = toolSignature(event);
      if (signature === null) {
        previousToolSignature = null;
        sameToolCalls = 0;
        if (reason === "repeated-tool-loop") reason = null;
        return reason;
      }
      if (signature === previousToolSignature) {
        sameToolCalls += 1;
      } else {
        previousToolSignature = signature;
        sameToolCalls = 1;
        if (reason === "repeated-tool-loop") reason = null;
      }
      if (sameToolCalls >= settings.repeatedToolCalls) reason ??= "repeated-tool-loop";
      return reason;
    },
    observeAssistantMessage(message) {
      if (!running || !settings.enabled) return null;
      markProgress();
      if (blockedReport(message)) reason = "blocked-brief";
      else if (message?.role === "assistant" && message.stopReason === "stop"
        && !message.content?.some?.((block) => block?.type === "toolCall")
        && (reason === "blocked-brief" || reason === "repeated-tool-loop")) {
        reason = null;
      }
      return reason;
    },
    checkIdle() {
      if (!running || !settings.enabled) return null;
      if (reason !== null) return reason;
      const current = readClock();
      if (current === null || lastProgressAt === null) return null;
      if (current < lastProgressAt) {
        lastProgressAt = current;
        return null;
      }
      if (current - lastProgressAt >= settings.idleTimeoutMs) reason = "idle-timeout";
      return reason;
    },
    endRun() {
      if (!running) return null;
      const finalReason = this.checkIdle();
      running = false;
      return finalReason;
    },
    reset() {
      running = false;
      lastProgressAt = null;
      previousToolSignature = null;
      sameToolCalls = 0;
      reason = null;
    },
  };
}
