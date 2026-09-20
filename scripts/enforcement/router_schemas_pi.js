// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Capacity/policy router schemas (ROUTER_DESIGN_TASK68 §2-§4): the closed
// seat record, the closed router configuration, and the normalized
// quota-observation record. Every shape is exactKeys-closed, every enum value
// comes from a closed registry, and every validator fails closed on unknown
// or missing fields.
//
// Pure, side-effect-free: no file I/O beyond what the caller passes in. The
// config digest is SHA-256 over the canonical JSON form (the same canonical
// JSON used by the board writer).

import { canonicalJsonString, sha256Hex } from "./task_board_core_pi.js";
import { realpathSync, writeFileSync, renameSync, readFileSync, unlinkSync, lstatSync, openSync, closeSync, constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export { canonicalJsonString, sha256Hex };

export const SEAT_SCHEMA = "agentic-driver.seat.v1";
export const ROUTER_CONFIG_SCHEMA = "agentic-driver.router-config.v1";
export const QUOTA_OBSERVATION_SCHEMA = "agentic-driver.quota-observation.v1";

// ---------------------------------------------------------------------------
// Closed registries (§2). Model names and placement are CONFIGURATION DATA,
// never code enums: only the registries below are closed in code, and each
// is versioned through the config record itself.
// ---------------------------------------------------------------------------

export const SEAT_KINDS = Object.freeze(["local", "hosted-api", "subscription"]);
export const PROVIDERS = Object.freeze([
  "llama-server", "merge-gateway", "vercel-ai-gateway", "anthropic", "openai",
]);
export const CAPABILITIES = Object.freeze([
  "implement", "review", "final-verification", "design", "research",
]);
export const CONTAINMENT_TIERS = Object.freeze(["testudo", "docker-policy", "none"]);
export const COST_CLASSES = Object.freeze(["free", "low", "medium", "high"]);
export const QUOTA_UNITS = Object.freeze(["messages", "tokens", "time", "credits"]);
export const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);
export const SOURCE_STATUSES = Object.freeze(["ok", "stale", "parse-error", "unknown"]);
export const EFFORT_LEVELS = Object.freeze(["low", "default", "high"]);
export const PHASES = Object.freeze(["plan", "implement", "review", "escalate"]);
export const RESERVE_SCOPES = Object.freeze(["account-window", "account", "pool"]);
export const COST_POLICIES = Object.freeze(["free-first", "cheapest", "none"]);
export const RANKING_FALLBACKS = Object.freeze(["preference-order"]);

const SEAT_ID_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPosInt(value) {
  return Number.isInteger(value) && value >= 1;
}

// ---------------------------------------------------------------------------
// §2 Seat record: agentic-driver.seat.v1
// ---------------------------------------------------------------------------

export function wellFormedSeat(seat, { endpoints = null } = {}) {
  if (!isPlainObject(seat) || !exactKeys(seat, [
    "schema", "seatId", "kind", "provider", "accountId", "endpointRef",
    "model", "capabilities", "containmentTier", "maxConcurrency",
    "costClass", "quotaCollector", "clusterMembership", "enabled", "deprecated",
  ])) {
    return { ok: false, reason: "seat record has unknown or missing fields (exactKeys closed)" };
  }
  if (seat.schema !== SEAT_SCHEMA) return { ok: false, reason: `seat schema must be ${SEAT_SCHEMA}` };
  if (typeof seat.seatId !== "string" || !SEAT_ID_RE.test(seat.seatId) || seat.seatId.length > 64) {
    return { ok: false, reason: `seatId "${seat.seatId}" must match ${SEAT_ID_RE.source} (max 64 chars)` };
  }
  if (!SEAT_KINDS.includes(seat.kind)) {
    return { ok: false, reason: `seat kind "${seat.kind}" is not one of ${SEAT_KINDS.join(", ")}` };
  }
  if (!PROVIDERS.includes(seat.provider)) {
    return { ok: false, reason: `seat provider "${seat.provider}" is not in the closed provider registry` };
  }
  // accountId is REQUIRED iff kind is subscription (§2).
  if (seat.kind === "subscription") {
    if (typeof seat.accountId !== "string" || seat.accountId === "") {
      return { ok: false, reason: `subscription seat "${seat.seatId}" requires a non-empty accountId` };
    }
  } else if (seat.accountId !== null) {
    return { ok: false, reason: `non-subscription seat "${seat.seatId}" must have accountId: null` };
  }
  if (typeof seat.endpointRef !== "string" || !SLUG_RE.test(seat.endpointRef)) {
    return { ok: false, reason: `seat endpointRef "${seat.endpointRef}" must be a named endpoint slug` };
  }
  if (endpoints !== null && !isPlainObject(endpoints?.[seat.endpointRef])) {
    return { ok: false, reason: `seat endpointRef "${seat.endpointRef}" does not resolve in endpoints{}` };
  }
  if (typeof seat.model !== "string" || seat.model === "" || seat.model.length > 128) {
    return { ok: false, reason: `seat model must be a non-empty string (max 128 chars)` };
  }
  if (!Array.isArray(seat.capabilities) || seat.capabilities.length === 0
    || !seat.capabilities.every((c) => CAPABILITIES.includes(c))) {
    return { ok: false, reason: `seat capabilities must be a non-empty subset of the closed capability registry` };
  }
  if (!CONTAINMENT_TIERS.includes(seat.containmentTier)) {
    return { ok: false, reason: `seat containmentTier "${seat.containmentTier}" is not one of ${CONTAINMENT_TIERS.join(", ")}` };
  }
  if (!isPosInt(seat.maxConcurrency) || seat.maxConcurrency > 32) {
    return { ok: false, reason: `seat maxConcurrency must be an integer from 1 through 32` };
  }
  if (!COST_CLASSES.includes(seat.costClass)) {
    return { ok: false, reason: `seat costClass "${seat.costClass}" is not one of ${COST_CLASSES.join(", ")}` };
  }
  if (seat.quotaCollector !== null && (typeof seat.quotaCollector !== "string" || !SLUG_RE.test(seat.quotaCollector))) {
    return { ok: false, reason: `seat quotaCollector must be a collector slug or null` };
  }
  if (seat.clusterMembership !== null) {
    const cm = seat.clusterMembership;
    if (!isPlainObject(cm) || !exactKeys(cm, ["clusterId", "nodes", "spansNodes"])) {
      return { ok: false, reason: `clusterMembership must have exactly {clusterId, nodes, spansNodes}` };
    }
    if (typeof cm.clusterId !== "string" || !SLUG_RE.test(cm.clusterId)) {
      return { ok: false, reason: `clusterMembership.clusterId must be a slug` };
    }
    if (!Array.isArray(cm.nodes) || cm.nodes.length === 0
      || !cm.nodes.every((n) => typeof n === "string" && SLUG_RE.test(n))) {
      return { ok: false, reason: `clusterMembership.nodes must be a non-empty list of endpoint slugs` };
    }
    if (endpoints !== null && !cm.nodes.every((n) => isPlainObject(endpoints?.[n]))) {
      return { ok: false, reason: `clusterMembership node "${cm.nodes.find((n) => !isPlainObject(endpoints?.[n]))}" does not resolve in endpoints{}` };
    }
    if (typeof cm.spansNodes !== "boolean") {
      return { ok: false, reason: `clusterMembership.spansNodes must be a boolean` };
    }
  }
  if (typeof seat.enabled !== "boolean") {
    return { ok: false, reason: `seat enabled must be a boolean` };
  }
  if (seat.deprecated !== null && (typeof seat.deprecated !== "string" || !ISO_DATE_RE.test(seat.deprecated))) {
    return { ok: false, reason: `seat deprecated must be an ISO yyyy-mm-dd date or null` };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// §3 Router configuration: agentic-driver.router-config.v1
// ---------------------------------------------------------------------------

const ENDPOINT_FIELDS = Object.freeze(["url", "kind"]);
const MODEL_FIELDS = Object.freeze(["aliases", "contextWindow", "capabilities"]);
const COLLECTOR_FIELDS = Object.freeze(["adapter", "cachePath", "ttlSeconds", "accounts"]);
const ELIGIBILITY_FIELDS = Object.freeze(["rules", "reserve"]);
const RESERVE_FIELDS = Object.freeze([
  "floorPercent", "scope", "coldStartFraction", "estimateSamples",
  "estimateMinSamples", "estimateOutlierSigma", "ownerInteractiveOverride",
]);
const PREFERENCE_FIELDS = Object.freeze(["order", "costPolicy"]);
const PREFERENCE_ORDER_FIELDS = Object.freeze(["seatId"]);
const RANKING_FIELDS = Object.freeze(["enabled", "janusUrl", "maxCandidates", "fallback"]);
const LOCAL_HEALTH_FIELDS = Object.freeze(["probeSeconds", "warmStateTracking"]);
const SECRET_REF_FIELDS = Object.freeze(["keychainService"]);

export function computeConfigDigest(config) {
  return sha256Hex(canonicalJsonString(config));
}

// Closed eligibility rule ids (§6.1, ordered). The config may only reorder
// within this closed list's semantics — the engine evaluates the canonical
// order regardless; the list exists so a config can disable nothing and
// rename nothing. An empty list means "all eight rules, in order".
export const ELIGIBILITY_RULES = Object.freeze([
  "seat-enabled",
  "board-policy-route",
  "capability-match",
  "containment-tier",
  "endpoint-health",
  "model-installed",
  "quota-eligibility",
  "global-capacity",
]);

export function validateRouterConfig(config) {
  if (!isPlainObject(config)) return { ok: false, errors: ["router config must be an object"] };
  if (!exactKeys(config, [
    "schema", "revision", "endpoints", "seats", "models", "collectors",
    "eligibility", "preferences", "ranking", "localHealth", "secrets",
  ])) {
    return { ok: false, errors: ["router config has unknown or missing fields (exactKeys closed)"] };
  }
  const errors = [];
  if (config.schema !== ROUTER_CONFIG_SCHEMA) {
    errors.push(`config schema must be ${ROUTER_CONFIG_SCHEMA}`);
  }
  if (!isPosInt(config.revision)) {
    errors.push("config revision must be a positive integer");
  }
  // endpoints{}: named, closed-shape endpoint records. URLs are validated
  // structurally (http/https); there is no unrestricted-URL escape hatch.
  if (!isPlainObject(config.endpoints)) {
    errors.push("endpoints must be an object keyed by endpoint slug");
  } else {
    for (const [name, endpoint] of Object.entries(config.endpoints)) {
      if (!SLUG_RE.test(name)) {
        errors.push(`endpoint name "${name}" must be a slug`);
        continue;
      }
      if (!isPlainObject(endpoint) || !exactKeys(endpoint, ENDPOINT_FIELDS)) {
        errors.push(`endpoint "${name}" must have exactly {url, kind}`);
        continue;
      }
      if (typeof endpoint.url !== "string"
        || !/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(endpoint.url)) {
        errors.push(`endpoint "${name}" url must be an http(s) URL`);
      }
      if (!PROVIDERS.includes(endpoint.kind)) {
        errors.push(`endpoint "${name}" kind "${endpoint.kind}" is not in the closed provider registry`);
      }
    }
  }
  // seats[]: unique seatIds, well-formed records, resolvable endpointRefs.
  if (!Array.isArray(config.seats) || config.seats.length === 0) {
    errors.push("seats must be a non-empty list");
  } else {
    const seen = new Set();
    for (const seat of config.seats) {
      const check = wellFormedSeat(seat, { endpoints: config.endpoints });
      if (!check.ok) {
        errors.push(`seat ${seat?.seatId ?? "(unidentified)"}: ${check.reason}`);
        continue;
      }
      if (seen.has(seat.seatId)) errors.push(`duplicate seatId "${seat.seatId}"`);
      seen.add(seat.seatId);
      if (!isPlainObject(config.models?.[seat.model])) {
        errors.push(`seat "${seat.seatId}" model "${seat.model}" does not resolve in models{}`);
      }
      if (config.endpoints?.[seat.endpointRef]?.kind !== seat.provider) {
        errors.push(`seat "${seat.seatId}" provider does not match endpoint kind`);
      }
      if (seat.quotaCollector !== null && !isPlainObject(config.collectors?.[seat.quotaCollector])) {
        errors.push(`seat "${seat.seatId}" quotaCollector "${seat.quotaCollector}" does not resolve in collectors{}`);
      }
    }
  }
  // models{}: closed-shape model records.
  if (!isPlainObject(config.models)) {
    errors.push("models must be an object keyed by model id");
  } else {
    for (const [id, model] of Object.entries(config.models)) {
      if (typeof id !== "string" || id === "" || id.length > 128) {
        errors.push("model ids must be non-empty strings (max 128 chars)");
        continue;
      }
      if (!isPlainObject(model) || !exactKeys(model, MODEL_FIELDS)) {
        errors.push(`model "${id}" must have exactly {aliases, contextWindow, capabilities}`);
        continue;
      }
      if (!Array.isArray(model.aliases) || !model.aliases.every((a) => typeof a === "string" && a !== "")) {
        errors.push(`model "${id}" aliases must be a list of strings`);
      }
      if (!isPosInt(model.contextWindow)) {
        errors.push(`model "${id}" contextWindow must be a positive integer`);
      }
      if (!Array.isArray(model.capabilities) || !model.capabilities.every((c) => CAPABILITIES.includes(c))) {
        errors.push(`model "${id}" capabilities must be a subset of the closed capability registry`);
      }
    }
  }
  // collectors{}: adapter id, contained cache path, positive TTL, resolvable
  // account slugs.
  if (!isPlainObject(config.collectors)) {
    errors.push("collectors must be an object keyed by collector id");
  } else {
    for (const [id, collector] of Object.entries(config.collectors)) {
      if (!SLUG_RE.test(id)) {
        errors.push(`collector id "${id}" must be a slug`);
        continue;
      }
      if (!isPlainObject(collector) || !exactKeys(collector, COLLECTOR_FIELDS)) {
        errors.push(`collector "${id}" must have exactly {adapter, cachePath, ttlSeconds, accounts}`);
        continue;
      }
      if (typeof collector.adapter !== "string" || !SLUG_RE.test(collector.adapter)) {
        errors.push(`collector "${id}" adapter must be a slug`);
      }
      if (typeof collector.cachePath !== "string" || collector.cachePath === ""
        || collector.cachePath.includes("..")) {
        errors.push(`collector "${id}" cachePath must be a non-empty path without traversal`);
      }
      if (!isPosInt(collector.ttlSeconds)) {
        errors.push(`collector "${id}" ttlSeconds must be a positive integer`);
      }
      if (!Array.isArray(collector.accounts) || collector.accounts.length === 0
        || !collector.accounts.every((a) => typeof a === "string" && SLUG_RE.test(a))) {
        errors.push(`collector "${id}" accounts must be a non-empty list of account slugs`);
      } else {
        const expected = new Set((config.seats ?? []).filter((s) => s?.quotaCollector === id && s?.kind === "subscription").map((s) => s.accountId));
        const actual = new Set(collector.accounts);
        if (expected.size !== actual.size || [...expected].some((a) => !actual.has(a))) {
          errors.push(`collector "${id}" accounts must exactly match its subscription seats`);
        }
      }
    }
  }
  // eligibility{}: closed reserve parameters; rules is a closed list (empty
  // = all eight, in canonical order).
  if (!isPlainObject(config.eligibility) || !exactKeys(config.eligibility, ELIGIBILITY_FIELDS)) {
    errors.push("eligibility must have exactly {rules, reserve}");
  } else {
    if (!Array.isArray(config.eligibility.rules)
      || !config.eligibility.rules.every((r) => ELIGIBILITY_RULES.includes(r))) {
      errors.push(`eligibility.rules must be a subset of the closed rule registry (${ELIGIBILITY_RULES.join(", ")})`);
    }
    const reserve = config.eligibility.reserve;
    if (!isPlainObject(reserve) || !exactKeys(reserve, RESERVE_FIELDS)) {
      errors.push("eligibility.reserve must have exactly {floorPercent, scope, coldStartFraction, estimateSamples, estimateMinSamples, estimateOutlierSigma, ownerInteractiveOverride}");
    } else {
      if (!Number.isFinite(reserve.floorPercent) || reserve.floorPercent < 0 || reserve.floorPercent > 100) {
        errors.push("eligibility.reserve.floorPercent must be a number from 0 through 100");
      }
      if (!RESERVE_SCOPES.includes(reserve.scope)) {
        errors.push(`eligibility.reserve.scope must be one of ${RESERVE_SCOPES.join(", ")}`);
      }
      if (!Number.isFinite(reserve.coldStartFraction) || reserve.coldStartFraction <= 0 || reserve.coldStartFraction > 1) {
        errors.push("eligibility.reserve.coldStartFraction must be a number from >0 through 1");
      }
      if (!isPosInt(reserve.estimateSamples) || reserve.estimateSamples > 1000) {
        errors.push("eligibility.reserve.estimateSamples must be a positive integer (max 1000)");
      }
      if (!isPosInt(reserve.estimateMinSamples) || reserve.estimateMinSamples > reserve.estimateSamples) {
        errors.push("eligibility.reserve.estimateMinSamples must be a positive integer <= estimateSamples");
      }
      if (!Number.isFinite(reserve.estimateOutlierSigma) || reserve.estimateOutlierSigma <= 0) {
        errors.push("eligibility.reserve.estimateOutlierSigma must be a positive number");
      }
      if (typeof reserve.ownerInteractiveOverride !== "boolean") {
        errors.push("eligibility.reserve.ownerInteractiveOverride must be a boolean");
      }
    }
  }
  // preferences{}: resolvable seatIds in a deterministic order.
  if (!isPlainObject(config.preferences) || !exactKeys(config.preferences, PREFERENCE_FIELDS)) {
    errors.push("preferences must have exactly {order, costPolicy}");
  } else {
    if (!Array.isArray(config.preferences.order)) {
      errors.push("preferences.order must be a list");
    } else {
      const seatIds = new Set((Array.isArray(config.seats) ? config.seats : []).map((s) => s?.seatId));
      const seenOrder = new Set();
      for (const entry of config.preferences.order) {
        if (!isPlainObject(entry) || !exactKeys(entry, PREFERENCE_ORDER_FIELDS)) {
          errors.push("preferences.order entries must have exactly {seatId}");
          continue;
        }
        if (!seatIds.has(entry.seatId)) {
          errors.push(`preferences.order seatId "${entry.seatId}" does not resolve in seats{}`);
        }
        if (seenOrder.has(entry.seatId)) {
          errors.push(`preferences.order seatId "${entry.seatId}" appears more than once`);
        }
        seenOrder.add(entry.seatId);
      }
    }
    if (!COST_POLICIES.includes(config.preferences.costPolicy)) {
      errors.push(`preferences.costPolicy must be one of ${COST_POLICIES.join(", ")}`);
    }
  }
  // ranking{}: bounded candidates; fallback is the single supported value.
  if (!isPlainObject(config.ranking) || !exactKeys(config.ranking, RANKING_FIELDS)) {
    errors.push("ranking must have exactly {enabled, janusUrl, maxCandidates, fallback}");
  } else {
    if (typeof config.ranking.enabled !== "boolean") {
      errors.push("ranking.enabled must be a boolean");
    }
    if (typeof config.ranking.janusUrl !== "string"
      || !/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(config.ranking.janusUrl)) {
      errors.push("ranking.janusUrl must be an http(s) URL");
    }
    if (!isPosInt(config.ranking.maxCandidates) || config.ranking.maxCandidates > 8) {
      errors.push("ranking.maxCandidates must be a positive integer (max 8)");
    }
    if (!RANKING_FALLBACKS.includes(config.ranking.fallback)) {
      errors.push(`ranking.fallback must be one of ${RANKING_FALLBACKS.join(", ")}`);
    }
  }
  // localHealth{}: probe interval and warm-state tracking flag.
  if (!isPlainObject(config.localHealth) || !exactKeys(config.localHealth, LOCAL_HEALTH_FIELDS)) {
    errors.push("localHealth must have exactly {probeSeconds, warmStateTracking}");
  } else {
    if (!isPosInt(config.localHealth.probeSeconds)) {
      errors.push("localHealth.probeSeconds must be a positive integer");
    }
    if (typeof config.localHealth.warmStateTracking !== "boolean") {
      errors.push("localHealth.warmStateTracking must be a boolean");
    }
  }
  // secrets{}: by reference only — a keychain service name per provider.
  if (!isPlainObject(config.secrets)) {
    errors.push("secrets must be an object keyed by provider id");
  } else {
    for (const [provider, ref] of Object.entries(config.secrets)) {
      if (!PROVIDERS.includes(provider)) {
        errors.push(`secrets key "${provider}" is not in the closed provider registry`);
        continue;
      }
      if (!isPlainObject(ref) || !exactKeys(ref, SECRET_REF_FIELDS)
        || typeof ref.keychainService !== "string" || ref.keychainService === "") {
        errors.push(`secrets["${provider}"] must have exactly {keychainService} with a non-empty service name`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// Precedence merge (§3): user profile > repository defaults. The profile is
// a partial config; its present sections replace the defaults' sections
// wholesale (never deep-merged — ambiguity fails closed by construction).
// The revision of the merged config is the profile's revision when present,
// else the defaults' revision. Returns null on any structural failure.
export function mergeRouterConfig(defaults, profile) {
  if (profile === null || profile === undefined) {
    const check = validateRouterConfig(defaults);
    return check.ok ? { ...defaults } : null;
  }
  if (!isPlainObject(profile)) return null;
  const merged = { ...defaults };
  for (const key of Object.keys(profile)) {
    if (key === "schema") continue; // schema identity is fixed
    if (!["revision", "endpoints", "seats", "models", "collectors", "eligibility",
      "preferences", "ranking", "localHealth", "secrets"].includes(key)) {
      return null; // unknown profile section fails closed
    }
    merged[key] = profile[key];
  }
  const check = validateRouterConfig(merged);
  return check.ok ? merged : null;
}

// ---------------------------------------------------------------------------
// §4 Quota observation: agentic-driver.quota-observation.v1
// ---------------------------------------------------------------------------

const QUOTA_WINDOW_FIELDS = Object.freeze(["unit", "total", "used", "remaining", "resetAt", "derived"]);
const CONCURRENCY_FIELDS = Object.freeze(["active", "limit"]);

export function wellFormedQuotaObservation(observation) {
  if (!isPlainObject(observation) || !exactKeys(observation, [
    "schema", "collector", "schemaVersion", "seatId", "accountId", "capturedAt",
    "expiresAt", "generation", "quotaWindows", "concurrency", "confidence",
    "sourceStatus", "parseErrors",
  ])) {
    return { ok: false, reason: "quota observation has unknown or missing fields (exactKeys closed)" };
  }
  if (observation.schema !== QUOTA_OBSERVATION_SCHEMA) {
    return { ok: false, reason: `observation schema must be ${QUOTA_OBSERVATION_SCHEMA}` };
  }
  if (typeof observation.collector !== "string" || !SLUG_RE.test(observation.collector)) {
    return { ok: false, reason: "observation collector must be a slug" };
  }
  if (!isPosInt(observation.schemaVersion)) {
    return { ok: false, reason: "observation schemaVersion must be a positive integer" };
  }
  if (typeof observation.seatId !== "string" || !SEAT_ID_RE.test(observation.seatId)) {
    return { ok: false, reason: "observation seatId must be a seat slug" };
  }
  if (typeof observation.accountId !== "string" || observation.accountId === "") {
    return { ok: false, reason: "observation accountId is required (explicit seat→account mapping)" };
  }
  if (!ISO_TS_RE.test(observation.capturedAt) || !ISO_TS_RE.test(observation.expiresAt)) {
    return { ok: false, reason: "observation capturedAt/expiresAt must be ISO timestamps" };
  }
  if (Date.parse(observation.expiresAt) < Date.parse(observation.capturedAt)) {
    return { ok: false, reason: "observation expiresAt must not precede capturedAt" };
  }
  if (!isNonNegInt(observation.generation)) {
    return { ok: false, reason: "observation generation must be a non-negative integer" };
  }
  if (!Array.isArray(observation.quotaWindows)) {
    return { ok: false, reason: "observation quotaWindows must be a list" };
  }
  for (const window of observation.quotaWindows) {
    if (!isPlainObject(window) || !exactKeys(window, QUOTA_WINDOW_FIELDS)) {
      return { ok: false, reason: "quota window must have exactly {unit, total, used, remaining, resetAt, derived}" };
    }
    if (!QUOTA_UNITS.includes(window.unit)) {
      return { ok: false, reason: `quota window unit "${window.unit}" is not one of ${QUOTA_UNITS.join(", ")}` };
    }
    if (!isNonNegInt(window.total) || !isNonNegInt(window.used) || !isNonNegInt(window.remaining)) {
      return { ok: false, reason: "quota window total/used/remaining must be non-negative integers" };
    }
    // §4: total is explicit and never derived — validation requires
    // total >= used + remaining within the unit.
    if (window.total < window.used + window.remaining) {
      return { ok: false, reason: `quota window unit "${window.unit}" violates total >= used + remaining` };
    }
    if (window.resetAt !== null && !ISO_TS_RE.test(window.resetAt)) {
      return { ok: false, reason: "quota window resetAt must be an ISO timestamp or null" };
    }
    if (typeof window.derived !== "boolean") {
      return { ok: false, reason: "quota window derived must be a boolean" };
    }
  }
  const concurrency = observation.concurrency;
  if (concurrency !== null) {
    if (!isPlainObject(concurrency) || !exactKeys(concurrency, CONCURRENCY_FIELDS)
      || !isNonNegInt(concurrency.active) || !isPosInt(concurrency.limit)
      || concurrency.active > concurrency.limit) {
      return { ok: false, reason: "observation concurrency must be {active, limit} with 0 <= active <= limit" };
    }
  }
  if (!CONFIDENCE_LEVELS.includes(observation.confidence)) {
    return { ok: false, reason: `observation confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}` };
  }
  if (!SOURCE_STATUSES.includes(observation.sourceStatus)) {
    return { ok: false, reason: `observation sourceStatus must be one of ${SOURCE_STATUSES.join(", ")}` };
  }
  if (!Array.isArray(observation.parseErrors)
    || !observation.parseErrors.every((e) => typeof e === "string" && e.length <= 512)) {
    return { ok: false, reason: "observation parseErrors must be a list of strings (max 512 chars each)" };
  }
  return { ok: true, reason: null };
}

// §4 freshness: an observation is fresh iff now < expiresAt AND
// sourceStatus === "ok". Evaluated at read time, never trusted from the file.
export function isObservationFresh(observation, now) {
  if (!isPlainObject(observation)) return false;
  if (observation.sourceStatus !== "ok") return false;
  const at = typeof now === "string" ? Date.parse(now) : now;
  const expiry = Date.parse(observation?.expiresAt);
  return Number.isFinite(at) && Number.isFinite(expiry) && at < expiry;
}

// §4 failure vs zero: collector failure (stale/parse-error/unknown) is
// distinct from legitimate zero capacity (ok with remaining: 0). Returns
// "failure" | "zero" | "available".
export function observationCapacityState(observation, now) {
  if (!isPlainObject(observation)) return "failure";
  if (observation.sourceStatus !== "ok") return "failure";
  if (!isObservationFresh(observation, now)) return "failure";
  const windows = Array.isArray(observation.quotaWindows) ? observation.quotaWindows : [];
  if (windows.length === 0) return "available";
  const anyZero = windows.every((w) => w.remaining === 0);
  return anyZero ? "zero" : "available";
}

// ---------------------------------------------------------------------------
// §4 cache-root containment: cache paths resolve under the configured trusted
// root; traversal fails closed.
// ---------------------------------------------------------------------------

export function cachePathContained(cachePath, trustedRoot) {
  if (typeof cachePath !== "string" || cachePath === "" || typeof trustedRoot !== "string" || trustedRoot === "" || cachePath.includes("\0")) {
    return { ok: false, reason: "cache path and trusted root are required and must not contain null bytes" };
  }
  try {
    const root = realpathSync(trustedRoot);
    // Resolve the parent, not the final file (which may not exist yet). This
    // detects symlinks in every existing path component.
    const parent = realpathSync(dirname(resolve(cachePath)));
    const finalPath = resolve(parent, cachePath.split("/").at(-1));
    const rel = relative(root, finalPath);
    if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) throw new Error("escape");
    try {
      if (lstatSync(finalPath).isSymbolicLink()) throw new Error("final component is a symlink");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ok: true, reason: null, path: finalPath };
  } catch {
    return { ok: false, reason: "cache path does not resolve under the trusted root (fails closed)" };
  }
}

export function writeCollectorCacheAtomic({ cachePath, trustedRoot, value }) {
  const check = cachePathContained(cachePath, trustedRoot);
  if (!check.ok) throw new Error(check.reason);
  const tmp = `${check.path}.tmp-${randomUUID()}`;
  try { writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(tmp, check.path); }
  catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
  return check.path;
}

export function readCollectorCache({ cachePath, trustedRoot }) {
  const check = cachePathContained(cachePath, trustedRoot);
  if (!check.ok) return { ok: false, reason: check.reason };
  let fd = null;
  try {
    fd = openSync(check.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const value = JSON.parse(readFileSync(fd, "utf8"));
    const valid = wellFormedQuotaObservation(value);
    return valid.ok ? { ok: true, observation: value } : { ok: false, reason: valid.reason };
  } catch (error) { return { ok: false, reason: String(error?.message || error) }; }
  finally { if (fd !== null) try { closeSync(fd); } catch {} }
}
