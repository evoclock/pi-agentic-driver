// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { NUDGE_STUCK_REASONS } from "./nudge_classifier_pi.js";

// NUDGE §7 config schema and validation (SPEC_TASK43_NUDGE.md v3.3.1,
// rule 30). Pure module: schema constants, the closed validator, and the
// runtime-merged-config loader shape. The `nudge validate` CLI lives in
// nudge_validate_pi.js; this module holds everything it checks so tests can
// exercise the exact runtime rules without spawning a process.

export const NUDGE_CONFIG_SCHEMA = "agentic-driver.herdr-nudge-config.v1";
export const NUDGE_CONFIG_REVISION = 1;

// All keys are REQUIRED; exactKeys closed (§7). `stallPolls` lives solely in
// #41's dispatch config — duplicate ownership here is invalid.
export const NUDGE_REQUIRED_KEYS = Object.freeze([
  "enabled",
  "reasonAttemptWindowPolls",
  "backoffCycles",
  "backoffMaxCycles",
  "nudgeMaxBytes",
]);

// Removed count-cap keys (v3.3): the budget is the closed reason taxonomy ×
// ladder depth × observation window × same-reason replacement loop guard,
// never a numeric cap. Their presence fails exact-key validation.
export const NUDGE_REMOVED_KEYS = Object.freeze([
  "maxNudgesPerJourney",
  "notifyAfterNudges",
  "replaceAfterNudges",
  "maxReplacementsPerJourney",
]);

// MAX_PROMPT_BYTES is owned by herdr communication (communication line 42);
// nudgeMaxBytes is bounded by it.
export const HERDR_MAX_PROMPT_BYTES = 32 * 1024;

// Re-export the classifier-owned closed taxonomy for config consumers.
export { NUDGE_STUCK_REASONS };
const CONFIG_SUPPORTED_STUCK_REASONS = Object.freeze([
  "blocked-modal", "working-sequence-frozen", "status-unknown", "done-report-unavailable",
]);

function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

// Validate the merged nudge config exactly as the runtime would consume it.
// Returns {ok, errors, operational}. `operational` is false when the schema
// is valid but the required N1 upstream capability is not yet verified
// (§7: a valid schema with a missing required N1 capability is reported
// non-operational and exits nonzero).
export function validateNudgeConfig(config, { upstreamCapabilityVerified = null, maxPollsPerSubmit = null, stallPolls = null } = {}) {
  const errors = [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, operational: false, errors: ["config: must be an object"] };
  }
  if (config.schema !== NUDGE_CONFIG_SCHEMA) {
    errors.push(`schema: must be "${NUDGE_CONFIG_SCHEMA}" (got ${JSON.stringify(config.schema ?? null)})`);
  }
  if (config.revision !== NUDGE_CONFIG_REVISION) {
    errors.push(`revision: must be ${NUDGE_CONFIG_REVISION} (got ${JSON.stringify(config.revision ?? null)})`);
  }
  const nudge = config.nudge;
  if (nudge === null || typeof nudge !== "object" || Array.isArray(nudge)) {
    errors.push("nudge: REQUIRED section missing — " + NUDGE_REQUIRED_KEYS.join(", ") + " must be set (fail closed)");
    return { ok: false, operational: false, errors };
  }
  // exactKeys closed: every REQUIRED key present, no unknown key, and the
  // removed count-cap keys are rejected by name so the operator sees why.
  for (const key of NUDGE_REQUIRED_KEYS) {
    if (nudge[key] === undefined) {
      errors.push(`nudge.${key}: REQUIRED key absent (fail closed)`);
    }
  }
  for (const key of Object.keys(nudge)) {
    if (!NUDGE_REQUIRED_KEYS.includes(key)) {
      const removed = NUDGE_REMOVED_KEYS.includes(key);
      errors.push(`nudge.${key}: ${removed
        ? "removed count-cap key — the budget is the closed reason taxonomy × ladder depth × observation window × same-reason replacement loop guard, never a numeric cap (NUDGE §7)"
        : "key outside the closed nudge config shape"}`);
    }
  }

  const enabled = nudge.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    errors.push("nudge.enabled: must be a boolean");
  }
  const window = nudge.reasonAttemptWindowPolls;
  if (window !== undefined && !isPositiveSafeInteger(window)) {
    errors.push("nudge.reasonAttemptWindowPolls: must be a positive safe integer (the bounded observation window for one persistent reason)");
  }
  const backoffCycles = nudge.backoffCycles;
  if (backoffCycles !== undefined && !isNonNegativeSafeInteger(backoffCycles)) {
    errors.push("nudge.backoffCycles: must be a safe integer >= 0");
  }
  const backoffMaxCycles = nudge.backoffMaxCycles;
  if (backoffMaxCycles !== undefined && !isPositiveSafeInteger(backoffMaxCycles)) {
    errors.push("nudge.backoffMaxCycles: must be a positive safe integer");
  }
  if (backoffCycles !== undefined && backoffMaxCycles !== undefined
    && isNonNegativeSafeInteger(backoffCycles) && isPositiveSafeInteger(backoffMaxCycles)
    && backoffCycles > backoffMaxCycles) {
    errors.push("nudge.backoffCycles: must be <= nudge.backoffMaxCycles");
  }
  const nudgeMaxBytes = nudge.nudgeMaxBytes;
  if (nudgeMaxBytes !== undefined) {
    if (!isPositiveSafeInteger(nudgeMaxBytes)) {
      errors.push("nudge.nudgeMaxBytes: must be a positive safe integer");
    } else if (nudgeMaxBytes > HERDR_MAX_PROMPT_BYTES) {
      errors.push(`nudge.nudgeMaxBytes: must be <= MAX_PROMPT_BYTES (${HERDR_MAX_PROMPT_BYTES})`);
    }
  }

  // Cross-surface checks (§7 + SEAM §7): the poll bound owns the outer hard
  // bound; the nudge window must fit inside it with room for at least one
  // backoff/observation cycle. stallPolls must have exactly one owner.
  if (maxPollsPerSubmit !== null) {
    if (!isPositiveSafeInteger(maxPollsPerSubmit)) {
      errors.push("cross-surface: maxPollsPerSubmit must be a positive safe integer when supplied");
    } else if (isPositiveSafeInteger(window) && window > maxPollsPerSubmit) {
      errors.push(`cross-surface: nudge.reasonAttemptWindowPolls (${window}) must be <= dispatch poll.maxPollsPerSubmit (${maxPollsPerSubmit})`);
    } else if (isPositiveSafeInteger(window) && window >= maxPollsPerSubmit) {
      errors.push("cross-surface: the observation window leaves no room for even one backoff/observation cycle inside maxPollsPerSubmit");
    }
  }
  if (stallPolls !== null && !isPositiveSafeInteger(stallPolls)) {
    errors.push("cross-surface: stallPolls must be a positive safe integer when supplied");
  }

  // Cross-module pin: config supports exactly the classifier-owned reasons.
  const unsupportedReasons = NUDGE_STUCK_REASONS.filter(
    (reason) => !CONFIG_SUPPORTED_STUCK_REASONS.includes(reason),
  );
  const missingReasons = CONFIG_SUPPORTED_STUCK_REASONS.filter(
    (reason) => !NUDGE_STUCK_REASONS.includes(reason),
  );
  if (unsupportedReasons.length > 0 || missingReasons.length > 0) {
    errors.push(`reason enum: classifier/config taxonomy mismatch (unsupported=${unsupportedReasons.join(",") || "none"}; missing=${missingReasons.join(",") || "none"})`);
  }

  // Operational readiness: a valid schema with a missing required N1
  // capability is reported non-operational (§7). The upstream herdr nudge
  // verb has not shipped, so the default is non-operational until the
  // capability probe and modal-isolation fixtures pass.
  const operational = errors.length === 0
    && (upstreamCapabilityVerified === null ? false : upstreamCapabilityVerified === true)
    && enabled === true;

  return { ok: errors.length === 0, operational, errors };
}

// ---------------------------------------------------------------------------
// 8. Upstream nudge-capability probe seam (NUDGE §3, §7; SEAM Part 2.11).
//    The real `herdr agent nudge` verb arrives with the upstream capability.
//    Until then this probe fails closed: it reports verified=false unless the
//    transport itself proves the capability. `nudge validate` (and the
//    runtime enablement path) consume this single seam — there is no second
//    place where the capability verdict is invented. The manual
//    `upstreamCapabilityVerified` input is a caller assertion, never a
//    substitute for this probe.
//    ---------------------------------------------------------------------
//    The probe runs the trusted herdr binary (never PATH-resolved) with the
//    nudge help verb and checks the pinned capability marker in the output.
//    Any failure — missing binary, non-zero exit, missing marker — means the
//    capability is NOT verified. A `runProcess` seam may be injected for
//    tests; production probing uses the trusted executable directly.
// ---------------------------------------------------------------------------

export const NUDGE_CAPABILITY_PROBE_MARKER = "agent nudge";

export async function probeNudgeUpstreamCapability({ runProcess = null, executable = null } = {}) {
  // No probe seam and no trusted binary: the capability is unverified. This
  // is the expected state until the upstream capability ships.
  const probeRun = typeof runProcess === "function" ? runProcess : null;
  const probeExecutable = typeof executable === "string" && executable.trim() ? executable : null;
  if (probeRun === null && probeExecutable === null) {
    return { verified: false, reason: "no nudge-capability probe seam or trusted executable is available; the upstream herdr nudge verb is not verified" };
  }
  const { execFileSync } = await import("node:child_process");
  const argv = ["agent", "nudge", "--help"];
  let stdout = "";
  try {
    if (probeRun !== null) {
      const result = await probeRun({ argv, shell: false });
      if (!result || result.code !== 0) {
        return { verified: false, reason: `the nudge-capability probe exited non-zero (${result?.code ?? "unknown"})` };
      }
      stdout = String(result.stdout ?? "");
    } else {
      stdout = execFileSync(probeExecutable, argv, { encoding: "utf8", timeout: 5_000, shell: false });
    }
  } catch (error) {
    return { verified: false, reason: `the nudge-capability probe failed: ${String(error?.message || error).slice(0, 200)}` };
  }
  if (!stdout.includes(NUDGE_CAPABILITY_PROBE_MARKER)) {
    return { verified: false, reason: "the trusted herdr binary does not advertise the agent nudge verb (capability marker absent)" };
  }
  return { verified: true, reason: "the trusted herdr binary advertises the agent nudge verb" };
}
