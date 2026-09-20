// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// janus configuration loading and validation.
//
// The config file is the single authority for the provider chain, the model
// allowlist, the request/concurrency/budget ceilings, and audit-log
// retention. Validation is CLOSED: unknown fields are rejected, invalid
// values are rejected — nothing falls back to a default silently.
//
// Provider architecture (authoritative owner decision): direct TypeSafe
// (`@typesafe-ai/sdk`, official SDK) is the SOLE provider. The Vercel AI
// Gateway and the merge gateway are DROPPED — they are not valid config and
// there is no fallback transport. When TypeSafe Direct is unconfigured the
// service fails closed (model_unauthorized), with no silent degradation.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const JANUS_VERSION = "0.1.0";
export const QUESTION_SCHEMA_VERSION = "janus.question-schema.v2";
export const RESPONSE_SCHEMA_VERSION = "janus.evaluate-response.v2";

/** Authoritative request budget (§2): state + questions + framing, in tokens. */
export const REQUEST_BUDGET_TOKENS = 30_000;
/** Hard ceiling for the configured request budget: config cannot raise it. */
export const MAX_REQUEST_BUDGET_TOKENS = REQUEST_BUDGET_TOKENS;
/** Service-side hard cap per request (§5). Client budgets are capped at this. */
export const MAX_TIMEOUT_MS = 30_000;
/** Default per-question instructions ceiling. */
export const MAX_INSTRUCTIONS_CHARS = 20_000;
/** Maximum number of questions in one request. */
export const MAX_QUESTIONS = 32;
/** Default score vocabulary levels (§6: 0..5, one decimal). */
export const SCORE_LEVELS = 6;
/** Maximum choice options per choice question. */
export const MAX_CHOICES = 64;
/** Maximum state size accepted before token accounting, in UTF-8 bytes. */
export const MAX_STATE_BYTES = 4_000_000;
/** Maximum audit-log file size before oldest-first rotation. */
export const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
/** Default audit-log retention in days. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
/** Hard ceiling for the global concurrency cap: config cannot raise it. */
export const MAX_CONCURRENCY = 4;
/** Default global concurrency cap (M9). */
export const DEFAULT_MAX_CONCURRENT = MAX_CONCURRENCY;
/** Default daily token ceiling for the cost breaker (M10). */
export const DEFAULT_DAILY_TOKEN_CEILING = 2_000_000;
/** Default daily cost ceiling in USD for the cost breaker (M10). */
export const DEFAULT_DAILY_COST_CEILING_USD = 10;
/** Default Jev price per million tokens (input + output blended, config-overridable). */
export const DEFAULT_COST_PER_MTOKEN_USD = 0.5;

/** Provider identifiers on the transport contract (§7). TypeSafe Direct is the sole provider. */
export type ProviderId = "typesafe-direct";

/**
 * A Keychain reference: the generic-password account and service names.
 * The secret value itself is never in config — only these references.
 */
export interface KeychainRef {
  /** Keychain account name (e.g. `typesafe-ai`). */
  account: string;
  /** Keychain service name (e.g. `Typesafe AI`). */
  service: string;
}

/** One configured provider in the ordered failover chain. */
export interface ProviderConfig {
  id: ProviderId;
  /** Provider-specific model identifier passed to the provider adapter. */
  model: string;
  /** Keychain reference for this provider's credential. */
  keychain: KeychainRef;
}

export interface JanusConfig {
  /** Server bind address. Hard-restricted to the loopback literals. */
  host: "127.0.0.1";
  port: number;
  /** Ordered provider chain: index 0 is primary; later entries are failovers. */
  providers: ProviderConfig[];
  /** Provider/model used when the request does not name one. */
  defaultModel: string;
  /** Global in-flight evaluation cap (M9). Hard ceiling 4. */
  maxConcurrent: number;
  /** Per-request timeout cap in ms (§5). */
  timeoutMs: number;
  /** Request token budget (§2). Hard ceiling 30,000. */
  requestBudgetTokens: number;
  /** Daily token ceiling for the cost breaker (M10). */
  dailyTokenCeiling: number;
  /** Daily cost ceiling in USD for the cost breaker (M10). */
  dailyCostCeilingUsd: number;
  /** Blended cost per million tokens used by the breaker. */
  costPerMtokenUsd: number;
  audit: {
    /** Append-only audit log path. Use "stdout" for launchd/dev console logging. */
    path: string;
    maxBytes: number;
    retentionDays: number;
  };
  /**
   * Redaction is ALWAYS on before any external call. The field exists as a
   * fixed `true` for the type contract; config cannot set it to false and
   * there is no disable knob.
   */
  readonly redactSecrets: true;
}

export interface ConfigLoadResult {
  config: JanusConfig;
  /** Non-fatal problems recorded while loading (reported on /version). */
  warnings: string[];
}

/** The sole provider chain: direct TypeSafe. */
export function defaultProviderChain(): ProviderConfig[] {
  return [
    {
      id: "typesafe-direct",
      model: "jev-latest",
      keychain: { account: "typesafe-ai", service: "Typesafe AI" },
    },
  ];
}

class ConfigError extends Error {}

function fail(field: string, why: string): never {
  throw new ConfigError(`config invalid: ${field}: ${why}`);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function optPositiveInt(raw: Record<string, unknown>, field: string, fallback: number, max?: number): number {
  const value = raw[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(field, `must be a positive integer, got ${JSON.stringify(value)}`);
  }
  if (max !== undefined && value > max) {
    fail(field, `${value} exceeds the hard ceiling of ${max}; config cannot raise it`);
  }
  return value;
}

function optNonNegativeNumber(raw: Record<string, unknown>, field: string, fallback: number): number {
  const value = raw[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(field, `must be a non-negative finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optString(raw: Record<string, unknown>, field: string, fallback: string): string {
  const value = raw[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    fail(field, "must be a nonempty string");
  }
  return value;
}

const PROVIDER_IDS: readonly ProviderId[] = ["typesafe-direct"];

function enforceKeychainRef(raw: unknown, field: string): KeychainRef {
  const obj = requireObject(raw, field);
  const allowed = new Set(["account", "service"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, "unknown field");
  }
  const account = obj.account;
  const service = obj.service;
  if (typeof account !== "string" || account.length === 0) fail(`${field}.account`, "must be a nonempty string");
  if (typeof service !== "string" || service.length === 0) fail(`${field}.service`, "must be a nonempty string");
  return { account, service };
}

function enforceProvider(raw: unknown, index: number): ProviderConfig {
  const obj = requireObject(raw, `providers[${index}]`);
  const allowed = new Set(["id", "model", "keychain"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(`providers[${index}].${key}`, "unknown field");
  }
  const id = obj.id;
  if (typeof id !== "string" || !PROVIDER_IDS.includes(id as ProviderId)) {
    fail(`providers[${index}].id`, `must be one of ${PROVIDER_IDS.join(", ")}`);
  }
  const model = obj.model;
  if (typeof model !== "string" || model.length === 0) {
    fail(`providers[${index}].model`, "must be a nonempty provider-specific model identifier");
  }
  const keychain = enforceKeychainRef(obj.keychain, `providers[${index}].keychain`);
  return { id: id as ProviderId, model, keychain };
}

function enforceProviderChain(raw: unknown): ProviderConfig[] {
  if (raw === undefined) return defaultProviderChain();
  if (!Array.isArray(raw) || raw.length === 0) fail("providers", "must be a nonempty array");
  if (raw.length > 1) {
    fail(
      "providers",
      "only the typesafe-direct provider is supported; at most one provider entry is valid",
    );
  }
  const chain = raw.map((entry, index) => enforceProvider(entry, index));
  const seen = new Set<string>();
  for (const provider of chain) {
    if (seen.has(provider.id)) fail("providers", `duplicate provider id ${provider.id}`);
    seen.add(provider.id);
  }
  return chain;
}

function resolveAuditPath(raw: unknown, configDir: string): string {
  if (raw === undefined) return join(configDir, "janus-audit");
  if (typeof raw !== "string" || raw.length === 0) fail("audit.path", "must be a nonempty string");
  if (raw === "stdout") return raw;
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
}

export function defaultConfigPath(): string {
  // typesafe-ai/jev namespace per §7; the janus config lives alongside it.
  return join(homedir(), ".config", "typesafe-ai", "jev", "janus-config.json");
}

export function loadConfig(path?: string): ConfigLoadResult {
  const warnings: string[] = [];
  const configPath = path ?? defaultConfigPath();
  const configDir = resolve(configPath, "..");

  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      } else {
        throw new ConfigError("config invalid: config file is not a JSON object");
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(
        `config invalid: config file failed to parse (${configPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    warnings.push(`config file not found; using defaults (${configPath})`);
  }

  // Closed top-level validation: unknown fields are rejected, never ignored.
  const allowedTop = new Set([
    "port",
    "providers",
    "defaultModel",
    "maxConcurrent",
    "timeoutMs",
    "requestBudgetTokens",
    "dailyTokenCeiling",
    "dailyCostCeilingUsd",
    "costPerMtokenUsd",
    "audit",
    "redactSecrets",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) fail(key, "unknown config field");
  }

  const auditRaw = requireObject(raw.audit, "audit");
  const allowedAudit = new Set(["path", "maxBytes", "retentionDays"]);
  for (const key of Object.keys(auditRaw)) {
    if (!allowedAudit.has(key)) fail(`audit.${key}`, "unknown config field");
  }

  // Redaction is immutable-on. The field may be present as true only.
  if (raw.redactSecrets !== undefined && raw.redactSecrets !== true) {
    fail("redactSecrets", "redaction is always on and cannot be disabled");
  }

  const providers = enforceProviderChain(raw.providers);
  const defaultModel = optString(raw, "defaultModel", providers[0]!.model);
  if (!providers.some((p) => p.model === defaultModel)) {
    fail("defaultModel", `${JSON.stringify(defaultModel)} is not any configured provider's model`);
  }

  const port = optPositiveInt(raw, "port", 8787);
  if (port > 65535) fail("port", `${port} out of range`);

  const auditPath = resolveAuditPath(auditRaw.path, configDir);

  const config: JanusConfig = {
    // §5 (H4): janus binds 127.0.0.1 only. There is no config knob for the
    // bind address by design; a non-loopback bind is a separate reviewed
    // change with shared-secret auth and an explicit bind-address policy.
    host: "127.0.0.1",
    port,
    providers,
    defaultModel,
    maxConcurrent: optPositiveInt(raw, "maxConcurrent", DEFAULT_MAX_CONCURRENT, MAX_CONCURRENCY),
    timeoutMs: optPositiveInt(raw, "timeoutMs", MAX_TIMEOUT_MS, MAX_TIMEOUT_MS),
    requestBudgetTokens: optPositiveInt(
      raw,
      "requestBudgetTokens",
      REQUEST_BUDGET_TOKENS,
      MAX_REQUEST_BUDGET_TOKENS,
    ),
    dailyTokenCeiling: optNonNegativeNumber(raw, "dailyTokenCeiling", DEFAULT_DAILY_TOKEN_CEILING),
    dailyCostCeilingUsd: optNonNegativeNumber(raw, "dailyCostCeilingUsd", DEFAULT_DAILY_COST_CEILING_USD),
    costPerMtokenUsd: optNonNegativeNumber(raw, "costPerMtokenUsd", DEFAULT_COST_PER_MTOKEN_USD),
    audit: {
      path: auditPath,
      maxBytes: optPositiveInt(auditRaw, "maxBytes", DEFAULT_AUDIT_MAX_BYTES),
      retentionDays: optPositiveInt(auditRaw, "retentionDays", DEFAULT_AUDIT_RETENTION_DAYS),
    },
    redactSecrets: true,
  };

  return { config, warnings };
}
