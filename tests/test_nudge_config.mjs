// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// NUDGE §7 config + validator tests (rule 30): schema/exact keys, ranges,
// cross-surface checks, removed count-cap keys, and the `nudge validate`
// setup report (loaded exactly as the runtime would, read-only).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateNudgeConfig, NUDGE_CONFIG_SCHEMA, NUDGE_REQUIRED_KEYS, NUDGE_REMOVED_KEYS,
  HERDR_MAX_PROMPT_BYTES, NUDGE_STUCK_REASONS,
} from "../scripts/enforcement/nudge_config_pi.js";
import {
  validateNudgeSetup, formatNudgeValidateReport, NUDGE_DEFAULTS_RELATIVE_PATH,
} from "../scripts/enforcement/nudge_validate_pi.js";

function validConfig(overrides = {}) {
  return {
    schema: NUDGE_CONFIG_SCHEMA,
    revision: 1,
    nudge: {
      enabled: true,
      reasonAttemptWindowPolls: 12,
      backoffCycles: 2,
      backoffMaxCycles: 8,
      nudgeMaxBytes: 2048,
      ...overrides,
    },
  };
}

test("a valid config with the upstream capability verified is valid and operational", () => {
  const result = validateNudgeConfig(validConfig(), { upstreamCapabilityVerified: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.operational, true);
});

test("all five keys are REQUIRED — each absence is named individually", () => {
  for (const key of NUDGE_REQUIRED_KEYS) {
    const config = validConfig();
    delete config.nudge[key];
    const result = validateNudgeConfig(config, { upstreamCapabilityVerified: true });
    assert.equal(result.ok, false, key);
    assert.ok(result.errors.some((e) => e.includes(`nudge.${key}: REQUIRED key absent`)), key);
  }
});

test("exactKeys closed: an unknown key is rejected with its exact path", () => {
  const config = validConfig();
  config.nudge.surprise = 1;
  const result = validateNudgeConfig(config, { upstreamCapabilityVerified: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("nudge.surprise: key outside the closed nudge config shape")));
});

test("removed count-cap keys are rejected by name with the budget rationale", () => {
  for (const key of NUDGE_REMOVED_KEYS) {
    const config = validConfig({ [key]: 3 });
    const result = validateNudgeConfig(config, { upstreamCapabilityVerified: true });
    assert.equal(result.ok, false, key);
    assert.ok(result.errors.some((e) => e.includes(`nudge.${key}: removed count-cap key`)), key);
  }
});

test("positive ranges: window, backoffMaxCycles, nudgeMaxBytes must be positive; backoffCycles >= 0", () => {
  for (const [key, value] of [
    ["reasonAttemptWindowPolls", 0], ["reasonAttemptWindowPolls", -1], ["reasonAttemptWindowPolls", 1.5],
    ["backoffMaxCycles", 0], ["backoffMaxCycles", -3],
    ["nudgeMaxBytes", 0], ["nudgeMaxBytes", -5],
    ["backoffCycles", -1], ["backoffCycles", 2.5],
  ]) {
    const result = validateNudgeConfig(validConfig({ [key]: value }), { upstreamCapabilityVerified: true });
    assert.equal(result.ok, false, `${key}=${value}`);
    assert.ok(result.errors.some((e) => e.includes(`nudge.${key}`)), `${key}=${value}`);
  }
});

test("backoffCycles <= backoffMaxCycles", () => {
  const result = validateNudgeConfig(validConfig({ backoffCycles: 9, backoffMaxCycles: 8 }), { upstreamCapabilityVerified: true });
  assert.ok(result.errors.some((e) => e.includes("backoffCycles: must be <= nudge.backoffMaxCycles")));
});

test("nudge MAX_PROMPT_BYTES equals the herdr communication limit", () => {
  const source = readFileSync(new URL("../scripts/enforcement/herdr_communication_pi.js", import.meta.url), "utf8");
  const match = source.match(/const MAX_PROMPT_BYTES = (\d+) \* (\d+);/);
  assert.ok(match, "herdr communication MAX_PROMPT_BYTES declaration not found");
  assert.equal(HERDR_MAX_PROMPT_BYTES, Number(match[1]) * Number(match[2]));
});

test("nudgeMaxBytes <= MAX_PROMPT_BYTES (32768)", () => {
  const result = validateNudgeConfig(validConfig({ nudgeMaxBytes: HERDR_MAX_PROMPT_BYTES + 1 }), { upstreamCapabilityVerified: true });
  assert.ok(result.errors.some((e) => e.includes("nudgeMaxBytes: must be <= MAX_PROMPT_BYTES")));
  const atBound = validateNudgeConfig(validConfig({ nudgeMaxBytes: HERDR_MAX_PROMPT_BYTES }), { upstreamCapabilityVerified: true });
  assert.ok(!atBound.errors.some((e) => e.includes("nudgeMaxBytes")));
});

test("cross-surface: reasonAttemptWindowPolls <= maxPollsPerSubmit when the dispatch config is supplied", () => {
  const result = validateNudgeConfig(validConfig({ reasonAttemptWindowPolls: 201 }), { upstreamCapabilityVerified: true, maxPollsPerSubmit: 200 });
  assert.ok(result.errors.some((e) => e.includes("must be <= dispatch poll.maxPollsPerSubmit")));
  const fits = validateNudgeConfig(validConfig(), { upstreamCapabilityVerified: true, maxPollsPerSubmit: 200 });
  assert.ok(!fits.errors.some((e) => e.includes("cross-surface")));
});

test("cross-surface: the window must leave room for at least one backoff/observation cycle", () => {
  const result = validateNudgeConfig(validConfig({ reasonAttemptWindowPolls: 200 }), { upstreamCapabilityVerified: true, maxPollsPerSubmit: 200 });
  assert.ok(result.errors.some((e) => e.includes("no room for even one backoff/observation cycle")));
});

test("closed reason enum is pinned for message-hash non-repetition support", () => {
  assert.deepEqual(NUDGE_STUCK_REASONS, [
    "blocked-modal", "working-sequence-frozen", "status-unknown", "done-report-unavailable",
  ]);
});

test("a valid schema without the verified N1 capability is non-operational (§7)", () => {
  const result = validateNudgeConfig(validConfig(), { upstreamCapabilityVerified: false });
  assert.equal(result.ok, true);
  assert.equal(result.operational, false);
});

test("enabled:false is valid but never operational", () => {
  const result = validateNudgeConfig(validConfig({ enabled: false }), { upstreamCapabilityVerified: true });
  assert.equal(result.ok, true);
  assert.equal(result.operational, false);
});

test("schema and revision are exact", () => {
  const badSchema = validConfig();
  badSchema.schema = "agentic-driver.herdr-nudge-config.v2";
  assert.ok(validateNudgeConfig(badSchema, { upstreamCapabilityVerified: true }).errors.some((e) => e.includes("schema")));
  const badRevision = validConfig();
  badRevision.revision = 2;
  assert.ok(validateNudgeConfig(badRevision, { upstreamCapabilityVerified: true }).errors.some((e) => e.includes("revision")));
});

// ---------------------------------------------------------------------------
// `nudge validate` setup report
// ---------------------------------------------------------------------------

function setupDir({ nudgeDefaults = validConfig({ enabled: false }), dispatchDefaults = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nudge-validate-"));
  mkdirSync(join(dir, ".agentic-driver"), { recursive: true });
  if (nudgeDefaults !== null) {
    writeFileSync(join(dir, NUDGE_DEFAULTS_RELATIVE_PATH), JSON.stringify(nudgeDefaults, null, 2));
  }
  if (dispatchDefaults !== null) {
    writeFileSync(join(dir, ".agentic-driver/dispatch.defaults.json"), JSON.stringify(dispatchDefaults, null, 2));
  }
  return dir;
}

test("the shipped repo config (enabled:false) validates as valid but non-operational", () => {
  const report = validateNudgeSetup({ repoRoot: process.cwd() });
  assert.equal(report.valid, true, report.errors.join("; "));
  assert.equal(report.operational, false);
  assert.equal(report.capabilityVerified, false);
});

test("a missing defaults file is an error with the exact path", () => {
  const dir = setupDir({ nudgeDefaults: null });
  try {
    const report = validateNudgeSetup({ repoRoot: dir });
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => e.includes("nudge defaults file is missing") && e.includes(join(dir, NUDGE_DEFAULTS_RELATIVE_PATH))));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cross-surface checks run when a dispatch config exists and are skipped (with a warning) when it does not", () => {
  const withDispatch = setupDir({ dispatchDefaults: { poll: { maxPollsPerSubmit: 200, stallPolls: 3 } } });
  try {
    const report = validateNudgeSetup({ repoRoot: withDispatch });
    assert.equal(report.valid, true, report.errors.join("; "));
    assert.ok(!report.warnings.some((w) => w.includes("cross-surface window checks skipped")));
  } finally { rmSync(withDispatch, { recursive: true, force: true }); }

  const withoutDispatch = setupDir({});
  try {
    const report = validateNudgeSetup({ repoRoot: withoutDispatch });
    assert.equal(report.valid, true);
    assert.ok(report.warnings.some((w) => w.includes("cross-surface window checks skipped")));
  } finally { rmSync(withoutDispatch, { recursive: true, force: true }); }
});

test("a window that does not fit the poll bound fails the setup report with paths", () => {
  const dir = setupDir({
    nudgeDefaults: validConfig({ enabled: false, reasonAttemptWindowPolls: 500 }),
    dispatchDefaults: { poll: { maxPollsPerSubmit: 200, stallPolls: 3 } },
  });
  try {
    const report = validateNudgeSetup({ repoRoot: dir });
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => e.includes("must be <= dispatch poll.maxPollsPerSubmit (200)")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("profile overlay replaces the nudge section wholesale; a profile count-cap key is rejected", () => {
  const dir = setupDir({});
  try {
    const profilePath = join(dir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(validConfig({ maxNudgesPerJourney: 5 }), null, 2));
    const report = validateNudgeSetup({ repoRoot: dir, profilePath });
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => e.includes("nudge.maxNudgesPerJourney: removed count-cap key")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the report formatter names validity, operationality, and every finding", () => {
  const report = validateNudgeSetup({ repoRoot: process.cwd() });
  const text = formatNudgeValidateReport(report);
  assert.match(text, /nudge config is valid/);
  assert.match(text, /NOT operational/);
  assert.match(text, /N1 upstream capability/);
});

// ---------------------------------------------------------------------------
// SEAM Part 2.11: the upstream-capability probe seam. The verdict for
// validateNudgeSetup's upstreamCapabilityVerified comes from the probe when
// it exists; every probe failure is verified:false (fail closed). The manual
// `--upstream-capability-verified` flag is a caller assertion only and is
// never a substitute for the probe.
// ---------------------------------------------------------------------------

test("the capability probe fails closed without any seam or trusted binary evidence", async () => {
  const { probeNudgeUpstreamCapability } = await import("../scripts/enforcement/nudge_config_pi.js");
  const verdict = await probeNudgeUpstreamCapability({});
  assert.equal(verdict.verified, false);
  assert.match(verdict.reason, /not verified|probe seam/);
});

test("a probe seam advertising the nudge verb verifies; one without it does not", async () => {
  const { probeNudgeUpstreamCapability } = await import("../scripts/enforcement/nudge_config_pi.js");
  const advertising = await probeNudgeUpstreamCapability({
    runProcess: async () => ({ code: 0, stdout: "herdr agent nudge <target> <text> — send a nudge" }),
  });
  assert.equal(advertising.verified, true);

  const silent = await probeNudgeUpstreamCapability({
    runProcess: async () => ({ code: 0, stdout: "herdr agent list\nherdr agent prompt" }),
  });
  assert.equal(silent.verified, false);
  assert.match(silent.reason, /marker absent/);

  const failing = await probeNudgeUpstreamCapability({
    runProcess: async () => ({ code: 2, stdout: "" }),
  });
  assert.equal(failing.verified, false);
  assert.match(failing.reason, /non-zero/);
});

test("resolveNudgeSetupWithProbe folds a verified probe into an operational report (with enabled:true)", async () => {
  const { resolveNudgeSetupWithProbe } = await import("../scripts/enforcement/nudge_validate_pi.js");
  const dir = setupDir({ nudgeDefaults: validConfig({ enabled: true }) });
  try {
    const report = await resolveNudgeSetupWithProbe({
      repoRoot: dir,
      probe: async () => ({ verified: true, reason: "fixture capability" }),
    });
    assert.equal(report.valid, true, report.errors.join("; "));
    assert.equal(report.capabilityVerified, true);
    assert.equal(report.operational, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed probe leaves the report valid but non-operational with the probe reason", async () => {
  const { resolveNudgeSetupWithProbe } = await import("../scripts/enforcement/nudge_validate_pi.js");
  const dir = setupDir({ nudgeDefaults: validConfig({ enabled: true }) });
  try {
    const report = await resolveNudgeSetupWithProbe({
      repoRoot: dir,
      probe: async () => ({ verified: false, reason: "fixture: capability absent" }),
    });
    assert.equal(report.valid, true);
    assert.equal(report.capabilityVerified, false);
    assert.equal(report.operational, false);
    assert.match(report.capabilityProbeReason ?? "", /fixture: capability absent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the manual verified flag is not a substitute for the probe: unverified stays non-operational", () => {
  // A caller may assert the capability, but the shipped validator resolves it
  // through the probe seam. Without a probe verdict the ladder stays
  // non-operational even when the flag is present (fail closed).
  const result = validateNudgeConfig(validConfig({ enabled: true }), { upstreamCapabilityVerified: false });
  assert.equal(result.ok, true);
  assert.equal(result.operational, false);
});

// ---------------------------------------------------------------------------
// The probe must not execute an executable that fails the runtime's
// realpath/Cellar trust validation. These fixtures build real paths (a plain
// executable outside Cellar, and a symlink) and prove the probe fails closed
// BEFORE any execution. The missing-nudge fail-closed test above is preserved.
// ---------------------------------------------------------------------------

test("the probe fails closed on an untrusted executable instead of running it", async () => {
  const { probeNudgeUpstreamCapability } = await import("../scripts/enforcement/nudge_config_pi.js");
  const dir = mkdtempSync(join(tmpdir(), "nudge-probe-untrusted-"));
  try {
    const marker = join(dir, "executed.marker");
    const untrusted = join(dir, "herdr");
    // This script would advertise the capability if it ever ran; the marker
    // proves whether execution happened at all.
    writeFileSync(untrusted, `#!/bin/sh\ntouch ${marker}\necho "herdr agent nudge"\n`);
    chmodSync(untrusted, 0o755);
    const verdict = await probeNudgeUpstreamCapability({ executable: untrusted });
    assert.equal(verdict.verified, false);
    assert.match(verdict.reason, /untrusted executable/);
    assert.equal(existsSync(marker), false, "the probe must not execute an untrusted executable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the probe fails closed on a symlinked executable outside the trusted Cellar path", async () => {
  const { probeNudgeUpstreamCapability } = await import("../scripts/enforcement/nudge_config_pi.js");
  const dir = mkdtempSync(join(tmpdir(), "nudge-probe-symlink-"));
  try {
    const target = join(dir, "herdr-target");
    writeFileSync(target, "#!/bin/sh\necho herdr agent nudge\n");
    chmodSync(target, 0o755);
    const link = join(dir, "herdr-link");
    symlinkSync(target, link);
    const verdict = await probeNudgeUpstreamCapability({ executable: link });
    assert.equal(verdict.verified, false);
    assert.match(verdict.reason, /untrusted executable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a runProcess seam still verifies without a filesystem binary (trust applies to real executables only)", async () => {
  const { probeNudgeUpstreamCapability } = await import("../scripts/enforcement/nudge_config_pi.js");
  const verdict = await probeNudgeUpstreamCapability({
    runProcess: async () => ({ code: 0, stdout: "herdr agent nudge <target> <text>" }),
  });
  assert.equal(verdict.verified, true);
});
