// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests: closed config validation (review fix #9) — unknown fields and
// invalid values are rejected, never defaulted silently; caps are enforced
// (request budget <= 30k, max concurrency <= 4, redaction immutable-on).

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../janus/config.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function configWith(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-config-test-"));
  const path = join(dir, "janus-config.json");
  writeFileSync(path, JSON.stringify(overrides));
  return path;
}

function expectConfigError(path: string, fragment?: string | RegExp): void {
  assert.throws(
    () => loadConfig(path),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (fragment) {
        if (typeof fragment === "string") assert.match(message, new RegExp(fragment));
        else assert.match(message, fragment);
      }
      return /config invalid/.test(message);
    },
  );
}

test("default config: sole typesafe-direct provider, 30k budget, redaction on", () => {
  const dir = mkdtempSync(join(tmpdir(), "janus-config-test-"));
  try {
    const { config, warnings } = loadConfig(join(dir, "missing.json"));
    assert.equal(config.providers[0]!.id, "typesafe-direct");
    assert.deepEqual(config.providers[0]!.keychain, { account: "typesafe-ai", service: "Typesafe AI" });
    assert.equal(config.providers.length, 1, "the fallback providers are dropped");
    assert.equal(config.requestBudgetTokens, 30_000);
    assert.equal(config.maxConcurrent, 4);
    assert.equal(config.redactSecrets, true);
    assert.equal(config.defaultModel, "jev-latest");
    assert.ok(warnings.length > 0, "missing file is a warning, not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown top-level fields are rejected (review fix #9)", () => {
  expectConfigError(configWith({ modelAllowlist: ["x"] }), /unknown config field/);
  expectConfigError(configWith({ keychainService: "x" }), /unknown config field/);
  expectConfigError(configWith({ maxTokens: 5 }), /unknown config field/);
  expectConfigError(configWith({ redaction: "off" }), /unknown config field/);
});

test("unknown audit fields are rejected", () => {
  expectConfigError(configWith({ audit: { path: "stdout", retentionDays: 1, extra: true } }), /audit\.extra/);
});

test("invalid values are rejected, not defaulted silently (review fix #9)", () => {
  expectConfigError(configWith({ port: "http" }));
  expectConfigError(configWith({ port: 99_999 }));
  expectConfigError(configWith({ timeoutMs: 0 }));
  expectConfigError(configWith({ maxConcurrent: 1.5 }));
  expectConfigError(configWith({ requestBudgetTokens: -5 }));
  expectConfigError(configWith({ audit: { retentionDays: "soon" } }));
});

test("request budget cannot be raised above 30,000 (review fix #3/#9)", () => {
  expectConfigError(configWith({ requestBudgetTokens: 30_001 }), /hard ceiling/);
  expectConfigError(configWith({ requestBudgetTokens: 1_000_000 }), /hard ceiling/);
  const ok = loadConfig(configWith({ requestBudgetTokens: 29_999 }));
  assert.equal(ok.config.requestBudgetTokens, 29_999);
});

test("max concurrency cannot be raised above 4 (review fix #9)", () => {
  expectConfigError(configWith({ maxConcurrent: 5 }), /hard ceiling/);
  const ok = loadConfig(configWith({ maxConcurrent: 2 }));
  assert.equal(ok.config.maxConcurrent, 2);
});

test("timeout cannot be raised above 30s (review fix #9)", () => {
  expectConfigError(configWith({ timeoutMs: 31_000 }), /hard ceiling/);
});

test("redaction is immutable-on: redactSecrets: false is rejected (review fix #4/#9)", () => {
  expectConfigError(configWith({ redactSecrets: false }), /redaction is always on/);
  const ok = loadConfig(configWith({ redactSecrets: true }));
  assert.equal(ok.config.redactSecrets, true);
});

test("provider entries are validated closed (review fix #2)", () => {
  expectConfigError(configWith({ providers: [{ id: "acme", model: "m", keychain: { account: "a", service: "s" } }] }), /providers\[0\]\.id/);
  // The fallback gateways are DROPPED: their ids are not valid configuration.
  expectConfigError(configWith({ providers: [{ id: "vercel-ai-gateway", model: "m", keychain: { account: "a", service: "s" } }] }), /providers\[0\]\.id/);
  expectConfigError(configWith({ providers: [{ id: "merge-gateway", model: "m", keychain: { account: "a", service: "s" } }] }), /providers\[0\]\.id/);
  expectConfigError(configWith({ providers: [{ id: "typesafe-direct", model: "", keychain: { account: "a", service: "s" } }] }), /model/);
  expectConfigError(configWith({ providers: [{ id: "typesafe-direct", model: "m", keychain: { account: "a" } }] }), /keychain\.service/);
  expectConfigError(configWith({ providers: [{ id: "typesafe-direct", model: "m", keychain: { account: "a", service: "s", apiKey: "x" } }] }), /unknown field/);
  expectConfigError(configWith({ providers: [] }), /nonempty array/);
  expectConfigError(
    configWith({
      providers: [
        { id: "typesafe-direct", model: "m", keychain: { account: "a", service: "s" } },
        { id: "typesafe-direct", model: "m2", keychain: { account: "a", service: "s" } },
      ],
    }),
    /at most one provider entry is valid/,
  );
});

test("valid custom provider chain loads; defaultModel must match a provider model", () => {
  const ok = loadConfig(
    configWith({
      providers: [
        { id: "typesafe-direct", model: "jev-latest", keychain: { account: "typesafe-ai", service: "Typesafe AI" } },
      ],
      defaultModel: "jev-latest",
    }),
  );
  assert.equal(ok.config.defaultModel, "jev-latest");
  expectConfigError(
    configWith({
      providers: [
        { id: "typesafe-direct", model: "jev-latest", keychain: { account: "a", service: "s" } },
      ],
      defaultModel: "other-model",
    }),
    /defaultModel/,
  );
});

test("malformed config JSON is an error, not a silent default", () => {
  const dir = mkdtempSync(join(tmpdir(), "janus-config-test-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "{not json");
  expectConfigError(path, /failed to parse/);
  rmSync(dir, { recursive: true, force: true });
});

test("non-object config JSON is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "janus-config-test-"));
  const path = join(dir, "array.json");
  writeFileSync(path, "[1,2,3]");
  expectConfigError(path);
  rmSync(dir, { recursive: true, force: true });
});
