// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// `nudge validate` (NUDGE §7, rule 30): a read-only setup-time validator in
// the shape of router_validate_pi.js. It loads the merged nudge config
// exactly as the runtime would (repo defaults + optional profile overlay,
// same merge semantics: profile sections replace wholesale), then reports
// findings with paths. Exit 0 only when the config is valid AND operational
// — a valid schema with a missing required N1 capability (the upstream herdr
// nudge verb has not shipped) is reported non-operational and exits nonzero.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  validateNudgeConfig, NUDGE_CONFIG_SCHEMA, NUDGE_REMOVED_KEYS,
  probeNudgeUpstreamCapability,
} from "./nudge_config_pi.js";
import { TRUSTED_HERDR_EXECUTABLE } from "./herdr_communication_pi.js";

export const NUDGE_DEFAULTS_RELATIVE_PATH = ".agentic-driver/nudge.defaults.json";
export const NUDGE_PROFILE_DEFAULT_PATH = join(homedir(), ".config", "agentic-driver", "nudge", "profile.json");

// Optional cross-surface inputs: the dispatch config's poll bound and
// stallPolls. When a dispatch config exists, the validator cross-checks
// (SEAM §7); when it does not, those checks are skipped and reported as
// such — the runtime re-checks at enablement.
export const DISPATCH_DEFAULTS_RELATIVE_PATH = ".agentic-driver/dispatch.defaults.json";

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function mergeConfigs(defaults, profile) {
  if (profile === null || profile === undefined) return defaults;
  if (defaults === null || defaults === undefined) return profile;
  return {
    ...defaults,
    ...profile,
    nudge: profile.nudge !== undefined ? profile.nudge : defaults.nudge,
  };
}

export function validateNudgeSetup({
  repoRoot = process.cwd(),
  defaultsPath = null,
  profilePath = null,
  dispatchPath = null,
  upstreamCapabilityVerified = false,
  capabilityProbe = null,
} = {}) {
  // Part 2.11: `upstreamCapabilityVerified` may be asserted by the caller, or
  // resolved through the probe seam when one is SUPPLIED. When a probe is
  // given it must be a synchronous verdict provider (or an already-resolved
  // {verified}); async probing is the caller's job — see
  // resolveNudgeSetupWithProbe below. An unverified capability remains the
  // expected fail-closed state until the upstream herdr nudge verb ships.
  // The manual assertion is never a substitute for the probe: it only lets a
  // caller that has already run the probe fold the verdict into this report.
  let capabilityVerified = upstreamCapabilityVerified === true;
  let capabilityProbeReason = null;
  if (!capabilityVerified && capabilityProbe !== null && typeof capabilityProbe === "object" && typeof capabilityProbe.then !== "function") {
    capabilityVerified = capabilityProbe.verified === true;
    capabilityProbeReason = capabilityProbe.reason ?? null;
  } else if (!capabilityVerified && capabilityProbe !== null) {
    throw Object.assign(new Error("an async capabilityProbe must be resolved before validateNudgeSetup — use resolveNudgeSetupWithProbe"), { code: "invalid_parameters" });
  }
  const resolvedDefaults = resolve(defaultsPath ?? join(repoRoot, NUDGE_DEFAULTS_RELATIVE_PATH));
  const resolvedProfile = resolve(profilePath ?? process.env.AGENTIC_DRIVER_NUDGE_PROFILE ?? NUDGE_PROFILE_DEFAULT_PATH);
  const resolvedDispatch = resolve(dispatchPath ?? join(repoRoot, DISPATCH_DEFAULTS_RELATIVE_PATH));
  const errors = [];
  const warnings = [];

  const defaults = readJsonIfExists(resolvedDefaults);
  if (defaults === null) {
    errors.push(`defaults: nudge defaults file is missing: ${resolvedDefaults}`);
  } else if (defaults === undefined) {
    errors.push(`defaults: nudge defaults file is not valid JSON: ${resolvedDefaults}`);
  }
  let profile = null;
  if (existsSync(resolvedProfile)) {
    profile = readJsonIfExists(resolvedProfile);
    if (profile === undefined) errors.push(`profile: nudge profile file is not valid JSON: ${resolvedProfile}`);
    else if (profile !== null) warnings.push(`profile loaded: ${resolvedProfile}`);
  } else {
    warnings.push(`no profile at ${resolvedProfile} — defaults only`);
  }

  const config = mergeConfigs(defaults, profile);
  if (config !== null && config !== undefined) {
    // Cross-surface inputs from the dispatch config when present.
    let maxPollsPerSubmit = null;
    let stallPolls = null;
    const dispatch = readJsonIfExists(resolvedDispatch);
    if (dispatch !== null && dispatch !== undefined) {
      const poll = dispatch.poll;
      if (poll !== null && typeof poll === "object" && !Array.isArray(poll)) {
        maxPollsPerSubmit = typeof poll.maxPollsPerSubmit === "number" ? poll.maxPollsPerSubmit : null;
        stallPolls = typeof poll.stallPolls === "number" ? poll.stallPolls : null;
      }
      if (poll === null || typeof poll !== "object" || Array.isArray(poll)) {
        warnings.push(`dispatch: no poll section found at ${resolvedDispatch} — cross-surface window checks skipped (the runtime re-checks at enablement)`);
      }
      // Single-owner check for stallPolls (§7): if the nudge config somehow
      // carries it, the closed validator already rejects the unknown key;
      // here we name the ownership rule explicitly.
      if (config.nudge && Object.prototype.hasOwnProperty.call(config.nudge, "stallPolls")) {
        errors.push("nudge.stallPolls: stallPolls is owned solely by the dispatch config — duplicate ownership is invalid");
      }
    } else if (defaults !== null) {
      warnings.push(`no dispatch config at ${resolvedDispatch} — cross-surface window checks skipped (the runtime re-checks at enablement)`);
    }

    const validation = validateNudgeConfig(config, { upstreamCapabilityVerified: capabilityVerified, maxPollsPerSubmit, stallPolls });
    for (const error of validation.errors) errors.push(`config: ${error}`);
    if (validation.ok && !validation.operational) {
      if (capabilityVerified !== true) {
        // §7: a valid schema with a missing required N1 capability is
        // reported non-operational and exits nonzero — but it is a finding,
        // not a config error, so it lands in warnings when the config itself
        // is valid.
        warnings.push("operational: the required N1 upstream capability (herdr agent nudge with modal-isolation fixtures) is not verified — the ladder is configured but non-operational (§7)");
      } else if (config.nudge?.enabled !== true) {
        warnings.push("operational: nudge.enabled is false — the ladder is configured but not activated");
      }
    }
  }

  return {
    valid: errors.length === 0,
    operational: errors.length === 0 && capabilityVerified === true && config?.nudge?.enabled === true,
    capabilityVerified: capabilityVerified === true,
    ...(capabilityProbeReason !== null ? { capabilityProbeReason } : {}),
    defaultsPath: resolvedDefaults,
    profilePath: resolvedProfile,
    dispatchPath: resolvedDispatch,
    errors,
    warnings,
    removedKeysRejected: NUDGE_REMOVED_KEYS,
    schema: NUDGE_CONFIG_SCHEMA,
  };
}

// Part 2.11: async-capable setup resolution. Runs the supplied probe (or the
// default trusted-executable probe) and folds its verdict into the setup
// report. The probe is the seam: when the upstream herdr nudge verb ships and
// its modal-isolation fixtures pass, the probe verifies and `nudge validate`
// reports operational (with enabled:true). Until then every probe outcome is
// verified:false and the validator stays non-operational — fail closed.
export async function resolveNudgeSetupWithProbe({
  repoRoot = process.cwd(),
  defaultsPath = null,
  profilePath = null,
  dispatchPath = null,
  upstreamCapabilityVerified = false,
  probe = null,
} = {}) {
  let capabilityProbeReason = null;
  let capabilityVerified = upstreamCapabilityVerified === true;
  if (!capabilityVerified) {
    const runProbe = typeof probe === "function" ? probe : () => probeNudgeUpstreamCapability({ executable: TRUSTED_HERDR_EXECUTABLE });
    try {
      const verdict = await runProbe();
      capabilityVerified = verdict?.verified === true;
      capabilityProbeReason = verdict?.reason ?? null;
    } catch (error) {
      capabilityVerified = false;
      capabilityProbeReason = `the nudge-capability probe failed: ${String(error?.message || error).slice(0, 200)}`;
    }
  }
  const report = validateNudgeSetup({
    repoRoot,
    defaultsPath,
    profilePath,
    dispatchPath,
    upstreamCapabilityVerified: capabilityVerified,
    ...(capabilityProbeReason !== null ? { capabilityProbe: { verified: capabilityVerified, reason: capabilityProbeReason } } : {}),
  });
  return report;
}

export function formatNudgeValidateReport(report) {
  const lines = [];
  lines.push(report.valid ? "nudge config is valid" : "nudge config is NOT valid");
  lines.push(report.operational ? "nudge ladder is operational" : "nudge ladder is NOT operational");
  lines.push(`defaults: ${report.defaultsPath}`);
  lines.push(`profile: ${report.profilePath}`);
  lines.push(`dispatch cross-check: ${report.dispatchPath}`);
  for (const error of report.errors) lines.push(`ERROR: ${error}`);
  for (const warning of report.warnings) lines.push(`warn: ${warning}`);
  return lines.join("\n");
}

function isEntrypoint() {
  if (typeof process === "undefined" || !Array.isArray(process.argv) || process.argv[1] === undefined) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isEntrypoint()) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : null;
  };
  const capabilityFlag = args.includes("--upstream-capability-verified");
  const report = await resolveNudgeSetupWithProbe({
    repoRoot: process.cwd(),
    defaultsPath: take("--defaults"),
    profilePath: take("--profile"),
    dispatchPath: take("--dispatch"),
    upstreamCapabilityVerified: capabilityFlag,
  });
  process.stdout.write(`${formatNudgeValidateReport(report)}\n`);
  if (!report.valid || !report.operational) {
    process.stderr.write(`${JSON.stringify({
      valid: report.valid, operational: report.operational,
      errors: report.errors, warnings: report.warnings,
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.exit(0);
}
