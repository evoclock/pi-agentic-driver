// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Production router runtime loader. Configuration precedence is the closed
// user profile over repository defaults. SQLite remains operational state;
// authenticated claims remain authority and are used only to repair it.
//
// Two run modes:
//   - write mode (default): a dispatch path. Expires stale reserved rows,
//     reconciles claimed reservations from the authenticated claims file,
//     settles terminal claims, heartbeats live claims, and ingests
//     observations/receipts.
//   - read-only mode (W4): the `check` observation path. It reads the
//     collector cache and the store without a single write, and never creates
//     a store that does not exist. `persisted: false` is then true.
//
// The localHealth probe (W2) produces endpoint-keyed, read-time-fresh health
// observations for `kind: "local"` seats. A failed probe is never "ok".

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mergeRouterConfig, validateRouterConfig, computeConfigDigest, readCollectorCache } from "./router_schemas_pi.js";
import {
  openRouterStore, closeRouterStore, activeReservations, consumptionSamples,
  expireStaleReservations, insertQuotaObservation, insertConsumptionSample,
  reconcileReservationFromClaim, followClaimConsumption, renewReservationLease,
} from "./router_store_pi.js";
import { readClaimsState } from "./task_board_core_pi.js";

export const ROUTER_DEFAULTS_RELATIVE_PATH = ".agentic-driver/router.defaults.json";
export const ROUTER_PROFILE_DEFAULT_PATH = join(homedir(), ".config", "agentic-driver", "router", "profile.json");
export const ROUTER_CACHE_ROOT_DEFAULT_PATH = join(homedir(), ".local", "share", "agentic-driver", "quota");
export const HEALTH_OBSERVATION_SCHEMA = "agentic-driver.health-observation.v1";
export const LOCAL_HEALTH_PATH = "/health";

function readJson(path, { optional = false } = {}) {
  if (!existsSync(path)) {
    if (optional) return null;
    throw new Error(`router configuration is missing: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function expandHome(path) {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadRouterConfig({ repoRoot = process.cwd(), defaultsPath = null, profilePath = null } = {}) {
  const resolvedDefaults = resolve(defaultsPath ?? join(repoRoot, ROUTER_DEFAULTS_RELATIVE_PATH));
  const resolvedProfile = resolve(profilePath ?? process.env.AGENTIC_DRIVER_ROUTER_PROFILE ?? ROUTER_PROFILE_DEFAULT_PATH);
  const defaults = readJson(resolvedDefaults);
  const profile = readJson(resolvedProfile, { optional: true });
  const config = mergeRouterConfig(defaults, profile);
  if (config === null) throw new Error("router defaults/profile merge is invalid (fails closed)");
  const validation = validateRouterConfig(config);
  if (!validation.ok) throw new Error(`router configuration is invalid: ${validation.errors.join("; ")}`);
  return { config, configDigest: computeConfigDigest(config), configRevision: config.revision,
    defaultsPath: resolvedDefaults, profilePath: resolvedProfile, profileLoaded: profile !== null };
}

// ---------------------------------------------------------------------------
// localHealth probe adapter (W2, design §8.12)
// ---------------------------------------------------------------------------

function healthBase({ endpointRef, at, expiresAt }) {
  return {
    schema: HEALTH_OBSERVATION_SCHEMA,
    endpointRef,
    capturedAt: at,
    expiresAt,
    sourceStatus: "unknown",
    reason: null,
    warm: null,
    memoryHeadroomBytes: null,
    concurrency: null,
  };
}

// Probe ONE endpoint. The probe fails closed: a missing endpoint, a missing
// transport, a non-2xx response, a malformed body, a body status other than
// "ok", an exhausted memory headroom, or a full concurrency limit all yield a
// non-"ok" sourceStatus. Only a verified successful probe is ever "ok".
async function probeEndpoint({ endpointRef, endpoint, at, expiresAt, fetchFn, timeoutMs, warmStateTracking }) {
  const base = healthBase({ endpointRef, at, expiresAt });
  if (endpoint === null || typeof endpoint !== "object" || typeof endpoint.url !== "string" || endpoint.url === "") {
    return { ...base, sourceStatus: "unknown", reason: `endpoint "${endpointRef}" does not resolve in endpoints{}` };
  }
  if (typeof fetchFn !== "function") {
    return { ...base, sourceStatus: "unknown", reason: "no health probe transport is available (fails closed)" };
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchFn(`${endpoint.url.replace(/\/$/, "")}${LOCAL_HEALTH_PATH}`, { method: "GET", signal: controller?.signal });
  } catch (error) {
    return { ...base, sourceStatus: "unreachable", reason: `health probe failed: ${String(error?.message || error).slice(0, 128)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (response === null || typeof response !== "object" || response.ok !== true) {
    return { ...base, sourceStatus: "unreachable", reason: `health endpoint returned status ${response?.status ?? "no response"}` };
  }
  let body = null;
  try { body = typeof response.json === "function" ? await response.json() : null; } catch (error) {
    return { ...base, sourceStatus: "parse-error", reason: `health body is not JSON: ${String(error?.message || error).slice(0, 128)}` };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body) || body.status !== "ok") {
    return { ...base, sourceStatus: "unreachable", reason: `health status "${body?.status ?? "absent"}" is not ok` };
  }
  let memoryHeadroomBytes = null;
  const memory = body.memory ?? null;
  if (memory !== null && typeof memory === "object" && Number.isFinite(memory.free)) {
    memoryHeadroomBytes = memory.free;
    if (memory.free <= 0) return { ...base, sourceStatus: "unreachable", reason: "no memory headroom on the endpoint" };
  }
  let concurrency = null;
  const slots = body.concurrency ?? null;
  if (slots !== null && typeof slots === "object" && Number.isFinite(slots.active) && Number.isFinite(slots.limit)) {
    concurrency = { active: slots.active, limit: slots.limit };
    if (slots.limit <= 0 || slots.active >= slots.limit) {
      return { ...base, sourceStatus: "unreachable", reason: `endpoint concurrency is full (${slots.active}/${slots.limit})` };
    }
  }
  const warm = typeof body.warm === "boolean" ? body.warm
    : warmStateTracking && typeof body.model_loaded === "boolean" ? body.model_loaded : null;
  return { ...base, sourceStatus: "ok", reason: null, warm, memoryHeadroomBytes, concurrency };
}

// Probe every endpoint a local seat needs. For a spanning cluster seat the
// seat's endpointRef observation is "ok" only when BOTH nodes are ready; a
// single failed node fails the seat closed (design §8.12).
export async function probeLocalHealth({ config, now = null, fetchFn = null, timeoutMs = 3000 } = {}) {
  const at = now ?? new Date().toISOString();
  const probeSeconds = Number.isInteger(config?.localHealth?.probeSeconds) && config.localHealth.probeSeconds > 0
    ? config.localHealth.probeSeconds : 60;
  const expiresAt = new Date(Date.parse(at) + probeSeconds * 1000).toISOString();
  const warmStateTracking = config?.localHealth?.warmStateTracking === true;
  const doFetch = fetchFn ?? globalThis.fetch?.bind(globalThis) ?? null;
  const localSeats = (config?.seats ?? []).filter((seat) => seat?.kind === "local" && seat.enabled === true);
  const requiredBySeat = new Map();
  const endpointsToProbe = new Set();
  for (const seat of localSeats) {
    const refs = new Set([seat.endpointRef]);
    if (seat.clusterMembership?.spansNodes === true) {
      for (const node of Array.isArray(seat.clusterMembership.nodes) ? seat.clusterMembership.nodes : []) refs.add(node);
    }
    requiredBySeat.set(seat.seatId, [...refs]);
    for (const ref of refs) endpointsToProbe.add(ref);
  }
  const probes = {};
  for (const ref of endpointsToProbe) {
    probes[ref] = await probeEndpoint({ endpointRef: ref, endpoint: config?.endpoints?.[ref], at, expiresAt, fetchFn: doFetch, timeoutMs, warmStateTracking });
  }
  const observations = { ...probes };
  for (const [seatId, refs] of requiredBySeat) {
    if (refs.length <= 1) continue;
    const seat = localSeats.find((candidate) => candidate.seatId === seatId);
    const failed = refs.filter((ref) => probes[ref]?.sourceStatus !== "ok");
    if (failed.length > 0) {
      observations[seat.endpointRef] = {
        ...(probes[seat.endpointRef] ?? healthBase({ endpointRef: seat.endpointRef, at, expiresAt })),
        sourceStatus: "unreachable",
        reason: `spanning cluster seat "${seatId}" is not ready: endpoint(s) ${failed.join(", ")} did not report ok`,
      };
    }
  }
  return { observations, probes, probedAt: at, expiresAt };
}

// ---------------------------------------------------------------------------
// Store acquisition (W5): cache the write store per db path so a tick loop
// reuses one handle instead of leaking a DatabaseSync per invocation. A
// read-only store is opened only for its call and closed immediately.
// ---------------------------------------------------------------------------

const writeStoreCache = new Map();

function acquireWriteStore(dbPath) {
  const key = dbPath ?? "__default__";
  const cached = writeStoreCache.get(key);
  if (cached !== undefined && cached.closed !== true && cached.db !== null) return cached;
  const store = openRouterStore({ dbPath });
  writeStoreCache.set(key, store);
  return store;
}

export function closeCachedRouterStores() {
  for (const store of writeStoreCache.values()) closeRouterStore(store);
  writeStoreCache.clear();
}

// ---------------------------------------------------------------------------
// Terminal-claim settlement + heartbeat (L1). The authenticated claims file
// is authority: a reservation bound to a consumed claim settles to
// consumed/released, a reservation bound to a still-active claim is
// heartbeated, and a reservation bound to no claim is released. SQLite is
// repaired FROM the claims file, never the reverse.
// ---------------------------------------------------------------------------

export function settleTerminalReservations(store, { claimsState, now }) {
  const activeEnvelopeIds = new Set((claimsState?.claims ?? []).map((claim) => claim.envelopeId));
  const consumedByEnvelopeId = new Map((claimsState?.consumedClaims ?? []).map((entry) => [entry.envelopeId, entry.reason]));
  const reservations = activeReservations(store, { now });
  const settled = [];
  const seen = new Set();
  for (const reservation of reservations) {
    if (reservation.state !== "claimed" || typeof reservation.envelopeId !== "string" || reservation.envelopeId === "") continue;
    if (seen.has(reservation.envelopeId)) continue;
    seen.add(reservation.envelopeId);
    if (activeEnvelopeIds.has(reservation.envelopeId)) {
      renewReservationLease(store, { reservationId: reservation.reservationId, now });
      continue;
    }
    const reason = consumedByEnvelopeId.get(reservation.envelopeId) ?? "reclaimed";
    const followed = followClaimConsumption(store, { envelopeId: reservation.envelopeId, reason, now });
    settled.push(...followed.followed);
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Runtime assembly
// ---------------------------------------------------------------------------

export function prepareRouterRuntime({ repoRoot = process.cwd(), boardPath = null, defaultsPath = null,
  profilePath = null, dbPath = null, cacheRoot = null, now = null, consumptionReceipts = [], readOnly = false } = {}) {
  const loaded = loadRouterConfig({ repoRoot, defaultsPath, profilePath });
  const at = now ?? new Date().toISOString();
  const store = readOnly
    ? openRouterStore({ dbPath, readOnly: true })
    : acquireWriteStore(dbPath);

  let claimsState = { claims: [], consumedClaims: [] };
  // Terminal settlement and heartbeat repair SQLite only from an
  // authoritative claims file. Without a board path there is no authority to
  // repair against, so reservations are left untouched (fail closed).
  const hasClaimsAuthority = boardPath && existsSync(boardPath);
  if (hasClaimsAuthority) {
    const read = readClaimsState(boardPath);
    if (!read.ok) throw Object.assign(new Error(read.reason), { code: "claims-corrupt" });
    claimsState = read.state;
    if (!readOnly) {
      for (const claim of claimsState.claims) reconcileReservationFromClaim(store, { claim, now: at });
    }
  }

  const trustedRoot = resolve(cacheRoot ?? process.env.AGENTIC_DRIVER_ROUTER_CACHE_ROOT ?? ROUTER_CACHE_ROOT_DEFAULT_PATH);
  const quotaObservations = [];
  for (const [collectorId, collector] of Object.entries(loaded.config.collectors)) {
    const cachePath = expandHome(collector.cachePath);
    const read = readCollectorCache({ cachePath, trustedRoot });
    if (!read.ok || read.observation.collector !== collectorId) continue;
    if (!readOnly) insertQuotaObservation(store, read.observation);
    quotaObservations.push(read.observation);
  }

  try {
    if (!readOnly) {
      expireStaleReservations(store, { now: at });
      // L1: settle reservations whose claim is terminal (consumed/gone) and
      // heartbeat reservations whose claim is still active, but only from an
      // authoritative claims file.
      if (hasClaimsAuthority) settleTerminalReservations(store, { claimsState, now: at });
      for (const receipt of Array.isArray(consumptionReceipts) ? consumptionReceipts : []) {
        if (typeof receipt?.seatId !== "string" || typeof receipt?.unit !== "string"
          || !Number.isFinite(receipt?.quantity) || receipt.quantity < 0) continue;
        insertConsumptionSample(store, { seatId: receipt.seatId, unit: receipt.unit,
          quantity: receipt.quantity, claimId: receipt.claimId ?? null, capturedAt: receipt.capturedAt ?? at });
      }
    }
    const snapshot = {
      quotaObservations,
      consumptionSamples: store.missing === true ? [] : consumptionSamples(store),
      existingReservations: store.missing === true ? [] : activeReservations(store, { now: at }),
    };
    return {
      ...loaded, routerConfig: loaded.config, routerStore: readOnly ? null : store, routerNow: at,
      routerSnapshot: snapshot, cacheRoot: trustedRoot,
      routerReadOnly: readOnly, routerStorePath: store.path,
    };
  } finally {
    // Read-only runtimes never outlive the call; the handle is closed here so
    // the pure `check` path cannot leak a store.
    if (readOnly) closeRouterStore(store);
  }
}

// The production entry: assemble the runtime and attach endpoint-keyed
// localHealth observations to the snapshot (W2). In read-only mode this is
// still pure: probes are network reads and the store is opened read-only.
export async function prepareRouterRuntimeWithHealth({ fetchFn = null, healthTimeoutMs = 3000, ...options } = {}) {
  const runtime = prepareRouterRuntime(options);
  const health = await probeLocalHealth({ config: runtime.routerConfig, now: runtime.routerNow, fetchFn, timeoutMs: healthTimeoutMs });
  runtime.routerSnapshot.healthObservations = health.observations;
  runtime.healthProbes = health.probes;
  return runtime;
}
