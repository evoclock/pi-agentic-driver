// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Pulse scheduler (PULSE_DESIGN_v3 §2.3, §3.3, §6, §7, §8, §12): session-scoped
// scheduling composition. Owns the manual `check` action (pure observation),
// the interactive `run` action with its immutable single-use batch context and
// one native confirmation, the trusted semantic policy operations
// (enable/disable/configure), and the optional fixed-interval timer.
//
// It never claims, spawns, or mutates policy itself: atomic claims go through
// the existing dispatcher (claimCard), worker creation through the guarded
// Herdr lifecycle seam injected as `spawnWorker`, and policy writes through
// one confirmed semantic operation on the existing board-bound policy file.
// The timer never sends prompts to a model to make scheduling decisions.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateBoard, readAutomationPolicy, checkAutomationPolicy, checkPulsePolicy,
  readClaims, claimCard, claimCardForConfirmedBatch, registerConfirmedBatchForClaims,
  automationPolicyPath, PLACEMENTS,
} from "./task_board_core_pi.js";
import { scanBoard } from "./pulse_core_pi.js";
import { routeDecision } from "./router_engine_pi.js";
import { createReservation, claimReservation, renewReservationLease, consumeReservation, releaseReservation, insertRouteDecision } from "./router_store_pi.js";
import { isNativeTuiContext } from "./native_tui_context.js";

// ---------------------------------------------------------------------------
// Board resolution and observation
// ---------------------------------------------------------------------------

// Resolve the canonical board for the calling workspace. Mirrors the
// task-board extension's resolver: canonical TASKS.md first, derived
// board.md never authoritative.
export function resolveBoardPath(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  for (const name of ["TASKS.md", "board.md"]) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(cwd, "TASKS.md");
}

// Observe model availability for the policy's declared routes. The adapter
// resolves exact configured models through the Pi model registry and scoped
// model list; labels and self-reports never prove availability. Unknown or
// unresolved models are `unknown` and unusable (fails closed).
export function observeModelAvailability({ pulsePolicy = null, modelRegistry = null, scopedModels = null } = {}) {
  const observations = {};
  const declared = new Set();
  if (pulsePolicy && typeof pulsePolicy.routing === "object") {
    for (const entry of Object.values(pulsePolicy.routing)) {
      for (const route of [...(entry?.preferred ?? []), ...(entry?.fallback ?? [])]) {
        if (typeof route?.model !== "string") continue;
        declared.add(route.model);
        observations[route.model] = { status: "unknown" };
      }
    }
  }
  const scopedList = Array.isArray(scopedModels) ? scopedModels : [];
  // scopedModels entries are {model, thinkingLevel?}; an empty list means no
  // scoping is configured, so every available model is usable (§4.1).
  const scopedIds = new Set(scopedList.map((entry) => typeof entry === "string" ? entry : entry?.model)
    .filter((id) => typeof id === "string"));
  const noScoping = scopedList.length === 0;
  for (const model of declared) {
    if (!noScoping && !scopedIds.has(model)) {
      observations[model] = { status: "unknown" };
      continue;
    }
    try {
      // Resolve through the registry: an exact model id is resolvable either
      // as a loaded model (get) or through its provider auth (getProviderAuth
      // resolves the current API key without requiring a loaded model).
      // Labels and self-reports never prove availability (§4.1).
      const api = modelRegistry?.get?.(model) ?? null;
      if (!api && typeof modelRegistry?.getProviderAuth === "function") {
        const provider = model.split("/")[0];
        let auth = null;
        try { auth = modelRegistry.getProviderAuth(provider); } catch { auth = null; }
        observations[model] = { status: auth ? "available" : "unknown" };
        continue;
      }
      if (!api) {
        observations[model] = { status: "unknown" };
        continue;
      }
      // Authentication is checked through the registry, not model self-report.
      const auth = typeof modelRegistry?.isAuthenticated === "function"
        ? modelRegistry.isAuthenticated(model)
        : true;
      observations[model] = { status: auth ? "available" : "unauthenticated" };
    } catch {
      observations[model] = { status: "unavailable" };
    }
  }
  return { observations, declaredModels: [...declared] };
}

// One pure board scan for the manual check. Returns a structured result; it
// never claims and never mutates anything.
export function pulseCheck({ boardPath, modelRegistry = null, scopedModels = null, observedAt = null, activeSessions = [], providerLimit = null }) {
  const base = observeBoardForPulse({ boardPath });
  if (!base.ok) return base;
  const { validated, pulsePolicy, effectivePolicy } = base;
  const activeClaims = readClaims(boardPath);
  const { observations, declaredModels } = observeModelAvailability({ pulsePolicy, modelRegistry, scopedModels });
  const { scan, diagnosticHash } = scanBoard({
    cards: validated.cards,
    boardPath,
    boardRevision: null,
    policyRevision: null,
    activeClaims,
    pulsePolicy,
    modelObservations: observations,
    declaredModels,
    observedAt,
    placement: pulsePolicy ? effectivePolicy.placement : null,
    activeSessions, providerLimit,
  });
  return { ok: true, code: null, reason: null, scan, diagnosticHash, validated, effectivePolicy, pulsePolicy, activeClaims, activeSessions, providerLimit };
}

export async function routePulseCheck(check, { routerConfig, quotaObservations = [], healthObservations = {}, consumptionSamples = [], existingReservations = [], modelInstalled = null, janusRank = null, now = null } = {}) {
  if (!check?.ok || !routerConfig) return { ok: false, code: "router-unavailable", reason: "validated router configuration is required" };
  const decisions = [];
  const proposed = new Set((check.scan.proposedDispatches ?? []).map((p) => p.title));
  for (const card of check.validated.cards) {
    if (!proposed.has(card.title)) continue;
    const role = check.scan.cards.find((c) => c.title === card.title)?.role ?? "implementer";
    const routeModels = [...(check.pulsePolicy?.routing?.[role]?.preferred ?? []), ...(check.pulsePolicy?.routing?.[role]?.fallback ?? [])].map((r) => r.model);
    const policyRouteSeatIds = routerConfig.seats.filter((s) => routeModels.includes(s.model)).map((s) => s.seatId);
    const freeCapacityBySeat = Object.fromEntries(routerConfig.seats.map((s) => [s.seatId,
      check.scan.capacity.find((c) => c.role === role && c.model === s.model)?.free ?? 0]));
    const decision = await routeDecision({ card: { ...card, role }, config: routerConfig,
      snapshotDigest: check.diagnosticHash, policyRouteSeatIds, healthObservations,
      quotaObservations, consumptionSamples, existingReservations, activeSessions: check.activeSessions,
      freeCapacityBySeat, modelInstalled, janusRank, now: now ?? new Date().toISOString() });
    if (!decision.ok) {
      return { ok: false, code: "route-unavailable", reason: decision.reason ?? `no eligible route for card ${card.cardId}` };
    }
    decisions.push({ ...decision, cardId: card.cardId });
  }
  return { ok: true, decisions };
}

// Shared trusted resolution: board parse/validation + policy read/validate.
function observeBoardForPulse({ boardPath }) {
  if (typeof boardPath !== "string" || boardPath === "" || !existsSync(boardPath)) {
    return { ok: false, code: "board-unavailable", reason: "no board file found for this workspace (board-unavailable)" };
  }
  let validated;
  try {
    validated = validateBoard(readFileSync(boardPath, "utf8"), {});
  } catch (error) {
    return { ok: false, code: "board-invalid", reason: String(error?.message || error).slice(0, 512) };
  }
  if (!validated.ok) {
    return { ok: false, code: "board-invalid", reason: (validated.errors ?? []).join("; ").slice(0, 512) };
  }
  const policy = readAutomationPolicy(boardPath);
  // A missing or expired policy means Pulse is OFF, not an error: check is a
  // pure observation and must still report the board (§8: zero scheduling
  // effects). A malformed pulse object still fails closed.
  const policyCheck = checkAutomationPolicy(policy, { boardPath });
  if (!policyCheck.ok && policy !== null && policy?.pulse !== undefined) {
    return { ok: false, code: "policy-invalid", reason: policyCheck.reason };
  }
  const effectivePolicy = policyCheck.ok ? policyCheck.policy : null;
  const pulsePolicy = effectivePolicy?.pulse ?? null;
  return { ok: true, validated, effectivePolicy, pulsePolicy };
}

// ---------------------------------------------------------------------------
// Immutable single-use batch context (§6.2)
// ---------------------------------------------------------------------------

export const PULSE_BATCH_SCHEMA = "agentic-driver.pulse-batch.v1";
const BATCH_ENTRY_STATES = Object.freeze(["unused", "reserved", "consumed"]);
const BATCH_INTERACTIVE_TTL_MS = 5 * 60 * 1000;

// Mint one immutable, single-use batch context from a fresh scan. The entry
// set covers the FULL currently eligible candidate list (every READY_FOR_NEXT
// card), not only initially free slots; refill consumes it lazily. It is
// extension-memory state, never model input or durable authority.
export function mintBatchContext({ scan, cards, policy, instruction, now = null, batchId = null, routeDecisions = null }) {
  if (scan?.schema !== "agentic-driver.board-pulse.v1") {
    throw new Error("mintBatchContext requires a pulse scan");
  }
  if (typeof instruction !== "string" || instruction.trim() === "") {
    throw new Error("batch context requires the direct human instruction");
  }
  const at = now ?? new Date().toISOString();
  const issuedMs = Date.parse(at);
  // The public scan shape is title-keyed (§5): internal card identity comes
  // from the validated cards list, matched by title. Duplicate titles fail
  // closed rather than binding the wrong card.
  const byTitle = new Map();
  for (const card of cards) {
    if (byTitle.has(card.title)) byTitle.set(card.title, null);
    else byTitle.set(card.title, card);
  }
  const proposalByTitle = new Map((scan.proposedDispatches ?? []).map((p) => [p.title, p]));
  // Route decisions (router design §1/§8.1): keyed by cardId. The scheduler
  // carries the decision's identity (seatId, provider, model, digest,
  // reservationId) into the batch entry — it never recomputes a route.
  const decisionByCardId = new Map(
    (routeDecisions ?? []).filter((d) => d?.ok && typeof d?.record?.decisionId === "string")
      .map((d) => [d.cardId, d]),
  );
  const entries = [];
  for (const cardScan of scan.cards) {
    if (cardScan.result !== "READY_FOR_NEXT") continue;
    const card = byTitle.get(cardScan.title);
    if (!card) continue; // duplicate or missing title fails closed
    const proposal = proposalByTitle.get(cardScan.title);
    const decision = decisionByCardId.get(card.cardId) ?? null;
    if (!decision || typeof decision.digest !== "string" || typeof decision.model !== "string"
      || typeof decision.provider !== "string" || typeof decision.selectedSeatId !== "string") {
      throw new Error(`missing complete route decision for card ${card.cardId} (fails closed)`);
    }
    const model = decision.model;
    const repositories = Array.isArray(card.repositories) ? card.repositories.filter((r) => typeof r === "string" && r !== "") : [];
    const repository = repositories.length === 1 ? repositories[0]
      : repositories.length === 0 && Array.isArray(policy?.acceptedRepositories) && policy.acceptedRepositories.length === 1
        ? policy.acceptedRepositories[0]
        : null;
    if (!repository) continue; // ambiguous repository fails closed
    entries.push({
      cardId: card.cardId,
      cardHash: card.hash ?? null,
      title: card.title,
      role: cardScan.role,
      model,
      repository,
      placement: proposal?.placement ?? policy?.placement ?? null,
      state: "unused",
      seatId: decision.selectedSeatId,
      accountId: decision.accountId,
      provider: decision.provider,
      endpointRef: decision.endpointRef,
      effort: decision.effort,
      containmentTier: decision.containmentTier,
      phase: decision.record.phase,
      routeDecisionId: decision.record.decisionId,
      routeDecisionRecord: decision.record,
      routeDecisionDigest: decision.digest,
      reservationId: decision.reservationId,
      reservationVectors: decision.reservationVectors,
    });
  }
  // Interactive expiry is the earlier of policy expiry or five minutes.
  const policyExpiryMs = policy?.expiry ? Date.parse(policy.expiry) : NaN;
  const expiresMs = Number.isFinite(policyExpiryMs)
    ? Math.min(policyExpiryMs, issuedMs + BATCH_INTERACTIVE_TTL_MS)
    : issuedMs + BATCH_INTERACTIVE_TTL_MS;
  return {
    schema: PULSE_BATCH_SCHEMA,
    batchId: batchId ?? randomUUID(),
    instruction,
    boardPath: scan.board,
    policyRevision: null,
    issuedAt: at,
    expiresAt: new Date(expiresMs).toISOString(),
    maxConcurrency: Number.isInteger(policy?.maxConcurrent) ? policy.maxConcurrent : null,
    entries,
  };
}

function batchEntry(ctx, cardId) {
  return (ctx?.entries ?? []).find((entry) => entry.cardId === cardId) ?? null;
}

export function batchExpired(ctx, now = null) {
  const at = now ?? new Date().toISOString();
  return !ctx || typeof ctx.expiresAt !== "string" || Date.parse(ctx.expiresAt) <= Date.parse(at);
}

// Atomic entry transitions in extension memory. Reuse, expiry, or drift
// fails closed; a reserved entry returns to unused only when the lifecycle
// result proves no start occurred.
export function reserveBatchEntry(ctx, cardId, { now = null } = {}) {
  const entry = batchEntry(ctx, cardId);
  if (!entry) return { ok: false, reason: "card is not in the confirmed batch; a fresh preview and confirmation is required" };
  if (batchExpired(ctx, now)) return { ok: false, reason: "the batch confirmation context has expired; a fresh preview and confirmation is required" };
  if (entry.state !== "unused") return { ok: false, reason: `batch entry is ${entry.state}, not unused; it cannot be reserved again` };
  entry.state = "reserved";
  return { ok: true, entry };
}

export function consumeBatchEntry(ctx, cardId) {
  const entry = batchEntry(ctx, cardId);
  if (!entry) return { ok: false, reason: "card is not in the confirmed batch" };
  if (entry.state !== "reserved") return { ok: false, reason: `batch entry is ${entry.state}, not reserved; it cannot be consumed` };
  entry.state = "consumed";
  return { ok: true, entry };
}

export function releaseBatchEntry(ctx, cardId) {
  const entry = batchEntry(ctx, cardId);
  if (!entry) return { ok: false, reason: "card is not in the confirmed batch" };
  if (entry.state !== "reserved") return { ok: false, reason: `batch entry is ${entry.state}, not reserved; it cannot be released` };
  entry.state = "unused";
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// Batch execution (claims + guarded spawns)
// ---------------------------------------------------------------------------

// Containment gate (pre-claim, fail-closed): a container/microvm assignment
// is NEVER started as an ordinary host Herdr worker. There is no verified
// containment execution seam that supports assignment workers today, so
// container/microvm dispatch is denied with a precise result BEFORE any claim
// is created — no claim means nothing to reconcile and no capacity is leaked,
// and no envelope attempt is consumed (a retry needs a fresh dispatch once a
// real containment seam exists). Automated host dispatch stays explicitly
// high-risk and is never inferred: it is denied unless the caller proves an
// interactive, natively confirmed run (allowHostDispatch).
const CONTAINMENT_SEAM_UNAVAILABLE =
  "containment-seam-unavailable: no verified containment execution seam supports assignment workers; container/microvm assignments are never started as host workers (fails closed)";
const AUTOMATED_HOST_DENIED =
  "automated host dispatch is explicitly high-risk and requires explicit authority; it is never inferred (fails closed)";

// Execute the confirmed batch: reserve → atomic claim → guarded spawn →
// consume after verified start. A claim race removes the card from the landed
// batch and refreshes capacity; an ambiguous spawn leaves the entry reserved
// and triggers reconciliation, never reuse or another start.
export async function executeBatch({ batch, boardPath, spawnWorker = null, context = null, now = null, allowHostDispatch = false, routerStore = null }) {
  const landed = [];
  const capacityTaken = new Set();
  let terminalReason = "no-eligible-card";
  for (const entry of batch.entries) {
    if (batch.maxConcurrency !== null && capacityTaken.size >= batch.maxConcurrency) {
      terminalReason = "capacity-full";
      break;
    }
    if (entry.placement !== "host") {
      // Pre-claim denial: nothing was claimed, so no claim cleanup or
      // reconciliation is needed and capacity is not leaked.
      landed.push({ title: entry.title, role: entry.role, model: entry.model, placement: entry.placement, status: "denied", reason: CONTAINMENT_SEAM_UNAVAILABLE });
      terminalReason = "containment-seam-unavailable";
      continue;
    }
    if (!allowHostDispatch) {
      landed.push({ title: entry.title, role: entry.role, model: entry.model, placement: entry.placement, status: "denied", reason: AUTOMATED_HOST_DENIED });
      terminalReason = "host-dispatch-denied";
      continue;
    }
    const reserved = reserveBatchEntry(batch, entry.cardId, { now });
    if (!reserved.ok) continue;
    if (entry.reservationId !== null) {
      if (!routerStore) { releaseBatchEntry(batch, entry.cardId); throw new Error("router store is required for quota reservation"); }
      createReservation(routerStore, { reservationId: entry.reservationId, decisionId: entry.routeDecisionId,
        seatId: entry.seatId, accountId: entry.accountId, vectors: entry.reservationVectors, now: now ?? new Date().toISOString() });
    }
    if (routerStore) insertRouteDecision(routerStore, { record: entry.routeDecisionRecord, digest: entry.routeDecisionDigest });
    // Host entries claim ONLY through the trusted confirmed-batch path; the
    // batch was registered after the one native confirmation, and each entry
    // is single-use. Contained entries use the ordinary contained-only claim.
    const claim = entry.placement === "host"
      ? claimCardForConfirmedBatch({ boardPath, cardId: entry.cardId, role: entry.role, policy: null, now, confirmedBatch: batch })
      : claimCard({ boardPath, cardId: entry.cardId, role: entry.role, policy: null });
    if (!claim.ok) {
      if (routerStore && entry.reservationId) releaseReservation(routerStore, { reservationId: entry.reservationId, now: now ?? new Date().toISOString() });
      releaseBatchEntry(batch, entry.cardId);
      landed.push({
        title: entry.title, role: entry.role, model: entry.model, placement: entry.placement,
        status: ["lock-contention", "no-dispatchable-card", "already-claimed"].includes(claim.code) ? "race-lost" : "denied",
        ...(claim.reason ? { reason: claim.reason } : {}),
      });
      continue;
    }
    capacityTaken.add(entry.cardId);
    if (routerStore && entry.reservationId) {
      const bound = claimReservation(routerStore, { reservationId: entry.reservationId,
        claimId: claim.envelopeId, envelopeId: claim.envelopeId, now: now ?? new Date().toISOString() });
      if (!bound.ok) throw new Error(bound.reason);
      // L1: lease renewal runs through the production dispatch loop hook, not
      // only from tests. The authenticated envelope is the reservation identity.
      heartbeatBatchReservation({ routerStore, envelope: claim.envelope, now });
    }
    if (typeof spawnWorker !== "function") {
      // No guarded spawn seam in this context: the claim landed and the entry
      // is consumed as a claimed-but-not-started assignment; never spawn
      // outside the guarded seam.
      consumeBatchEntry(batch, entry.cardId);
      landed.push({ title: entry.title, role: entry.role, model: entry.model, placement: entry.placement, status: "claimed" });
      terminalReason = "spawn-seam-unavailable";
      continue;
    }
    let spawned;
    try {
      spawned = await spawnWorker({
        role: entry.role,
        repository: entry.repository,
        model: claim.envelope.model,
        provider: claim.envelope.provider,
        seatId: claim.envelope.seatId,
        endpointRef: entry.endpointRef,
        envelope: claim.envelope,
        placement: entry.placement,
        context, signal: null,
      });
    } catch (error) {
      spawned = { ok: false, reason: String(error?.message || error).slice(0, 256) };
    }
    if (spawned?.ok === true) {
      consumeBatchEntry(batch, entry.cardId);
      landed.push({ title: entry.title, role: entry.role, model: entry.model, placement: entry.placement, status: "started" });
    } else {
      // Delivery-unknown, partial start, or ambiguous read-back: the entry
      // stays reserved and triggers reconciliation — never reuse or another
      // start (§6.2). The reservation follows the claim through the terminal
      // settlement hook (production caller for settleBatchReservation).
      if (routerStore && entry.reservationId) settleBatchReservation({ routerStore, envelope: claim.envelope, outcome: "released", now });
      landed.push({
        title: entry.title, role: entry.role, model: entry.model, placement: entry.placement,
        status: "denied",
        reason: spawned?.reason ?? spawned?.code ?? "guarded spawn did not verify",
      });
      terminalReason = "spawn-unverified";
    }
  }
  return { landed, terminalReason };
}

// Dispatch-loop completion/heartbeat hooks. The authenticated envelope is
// the only accepted reservation identity; terminal transitions are idempotent.
export function heartbeatBatchReservation({ routerStore, envelope, now = null }) {
  if (!routerStore || typeof envelope?.reservationId !== "string") return { ok: true, skipped: true };
  return renewReservationLease(routerStore, { reservationId: envelope.reservationId, now: now ?? new Date().toISOString() });
}

export function settleBatchReservation({ routerStore, envelope, outcome, now = null }) {
  if (!routerStore || typeof envelope?.reservationId !== "string") return { ok: true, skipped: true };
  const input = { reservationId: envelope.reservationId, now: now ?? new Date().toISOString() };
  return outcome === "completed" ? consumeReservation(routerStore, input) : releaseReservation(routerStore, input);
}

// ---------------------------------------------------------------------------
// Interactive run (§6.2)
// ---------------------------------------------------------------------------

// One interactive capacity-filling batch under current policy: trusted board
// resolution, one scan, one semantic preview, one native confirmation, mint
// the immutable batch context, atomic claims, parallel guarded spawns.
export async function pulseRun({ boardPath, instruction, context = null, spawnWorker = null, now = null }) {
  if (typeof instruction !== "string" || instruction.trim() === "") {
    return { ok: false, code: "instruction-required", reason: "run requires the direct current-turn human instruction (fails closed)", scan: null, landedAssignments: [], batchTerminalReason: "instruction-required" };
  }
  const base = observeBoardForPulse({ boardPath });
  if (!base.ok) {
    return { ok: false, code: base.code, reason: base.reason, scan: null, landedAssignments: [], batchTerminalReason: base.code };
  }
  const { validated, effectivePolicy, pulsePolicy } = base;
  if (!pulsePolicy || pulsePolicy.enabled !== true) {
    return { ok: false, code: "pulse-disabled", reason: "Pulse is not enabled for this board (fails closed)", scan: null, landedAssignments: [], batchTerminalReason: "pulse-disabled" };
  }
  const check = pulseCheck({ boardPath, modelRegistry: context?.modelRegistry ?? null, scopedModels: context?.scopedModels ?? null, observedAt: now,
    activeSessions: context?.activeSessions ?? [], providerLimit: context?.providerLimit ?? null });
  if (!check.ok) {
    return { ok: false, code: check.code, reason: check.reason, scan: null, landedAssignments: [], batchTerminalReason: check.code };
  }
  const { scan } = check;
  const routed = await routePulseCheck(check, { ...(context?.routerSnapshot ?? {}), routerConfig: context?.routerConfig, now });
  if (!routed.ok) return { ok: false, code: routed.code, reason: routed.reason, scan, landedAssignments: [], batchTerminalReason: routed.code };
  const batch = mintBatchContext({ scan, cards: validated.cards, policy: effectivePolicy, instruction, now, routeDecisions: routed.decisions });
  // One semantic batch preview and one native confirmation for the exact
  // batch (§6.2 step 3-4). Headless contexts fail closed.
  if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
    return { ok: false, code: "native-confirmation-required", reason: "interactive Pulse run requires the native TUI for the one batch confirmation (fails closed)", scan, landedAssignments: [], batchTerminalReason: "no-confirmation" };
  }
  const previewLines = batch.entries.map((e) => `- ${e.title} → ${e.role} / ${e.model} (${e.placement})`);
  let confirmed;
  try {
    confirmed = await context.ui.confirm(
      "Run Pulse batch",
      [
        `Board: ${batch.boardPath}`,
        `Up to ${batch.maxConcurrency ?? "?"} parallel assignments from this confirmation.`,
        previewLines.length ? previewLines.join("\n") : "(no eligible cards right now)",
        "One confirmation for this exact batch; cards outside it require a fresh preview.",
      ].join("\n"),
    );
  } catch (error) {
    return { ok: false, code: "confirmation-failed", reason: String(error?.message || error).slice(0, 256), scan, landedAssignments: [], batchTerminalReason: "no-confirmation" };
  }
  if (confirmed !== true) {
    return { ok: true, cancelled: true, scan, landedAssignments: [], batchTerminalReason: "user-cancelled", batchId: batch.batchId };
  }
  // Interactive host spawning is permitted here only because this path has
  // already required the native TUI and one explicit batch confirmation. The
  // batch context is registered for the trusted in-memory confirmed-batch
  // claim path; each host entry is claimable exactly once from it.
  registerConfirmedBatchForClaims(batch);
  const { landed, terminalReason } = await executeBatch({ batch, boardPath, spawnWorker, context, now, allowHostDispatch: true, routerStore: context?.routerStore ?? null });
  return { ok: true, cancelled: false, scan, landedAssignments: landed, batchTerminalReason: terminalReason, batchId: batch.batchId };
}

// ---------------------------------------------------------------------------
// Automated tick (§7): deterministic fill without prompts, no model-driven
// polling. Only runs when the policy enables Pulse in automated mode.
// ---------------------------------------------------------------------------

export async function pulseTick({ boardPath, spawnWorker = null, context = null, now = null, routerRuntimeFor = null }) {
  const base = observeBoardForPulse({ boardPath });
  if (!base.ok) return { ok: false, code: base.code, reason: base.reason, landedAssignments: [] };
  const { effectivePolicy, pulsePolicy } = base;
  if (!pulsePolicy || pulsePolicy.enabled !== true) return { ok: true, skipped: true, reason: "pulse-disabled", landedAssignments: [] };
  if (pulsePolicy.mode !== "automated") return { ok: true, skipped: true, reason: "interactive-mode-tick-is-a-no-op", landedAssignments: [] };
  // W3: an automated tick refreshes its capacity snapshot per tick. A factory
  // supplied by the timer re-reads collector caches and health probes so
  // read-time freshness and the prior-reservation term are never frozen at
  // session setup. A factory failure fails the tick closed (no stale routing).
  let tickContext = context;
  if (typeof routerRuntimeFor === "function") {
    try {
      const refreshed = await routerRuntimeFor({ boardPath, now });
      tickContext = { ...(context ?? {}), ...(refreshed ?? {}) };
    } catch (error) {
      return { ok: false, code: "router-unavailable", reason: String(error?.message || error).slice(0, 512), landedAssignments: [] };
    }
  }
  const check = pulseCheck({ boardPath, modelRegistry: tickContext?.modelRegistry ?? null, scopedModels: tickContext?.scopedModels ?? null, observedAt: now,
    activeSessions: tickContext?.activeSessions ?? [], providerLimit: tickContext?.providerLimit ?? null });
  if (!check.ok) return { ok: false, code: check.code, reason: check.reason, landedAssignments: [] };
  const routed = await routePulseCheck(check, { ...(tickContext?.routerSnapshot ?? {}), routerConfig: tickContext?.routerConfig, now });
  if (!routed.ok) return { ok: false, code: routed.code, reason: routed.reason, landedAssignments: [] };
  const batch = mintBatchContext({ scan: check.scan, cards: check.validated.cards, policy: effectivePolicy, instruction: "automated-tick", now, routeDecisions: routed.decisions });
  // Automated ticks never infer host dispatch: allowHostDispatch stays false.
  const { landed, terminalReason } = await executeBatch({ batch, boardPath, spawnWorker, context: tickContext, now, allowHostDispatch: false, routerStore: tickContext?.routerStore ?? null });
  return { ok: true, skipped: false, scan: check.scan, landedAssignments: landed, batchTerminalReason: terminalReason };
}

// ---------------------------------------------------------------------------
// Guarded worker-creation seam (§2.5)
// ---------------------------------------------------------------------------

// The one Pulse spawn seam. Placement-aware and fail-closed: a host placement
// goes through the existing guarded Herdr lifecycle boundary (native
// confirmation, trusted repository, installed model roll, fixed argv,
// shell:false); any container/microvm placement is denied WITHOUT touching
// the lifecycle — Pulse never represents a contained assignment as contained
// while starting an ordinary host worker.
// §5.2 execution validation: the spawn step verifies the model/endpoint
// passed to Herdr exactly matches the authenticated envelope (model +
// provider + seat identity). A mismatch fails closed and is reported as a
// structured route-mismatch result (the caller logs the event).
export function validateSpawnMatchesEnvelope({ envelope, model, provider = null, seatId = null, endpointRef = null, routerConfig = null }) {
  if (envelope === null || typeof envelope !== "object") {
    return { ok: false, code: "route-mismatch", reason: "no authenticated envelope (fails closed)" };
  }
  if (typeof model !== "string" || model !== envelope.model) {
    return { ok: false, code: "route-mismatch", reason: `spawn model "${model}" does not match the authenticated envelope model "${envelope.model}" (fails closed)` };
  }
  if (typeof provider !== "string" || provider !== envelope.provider) {
    return { ok: false, code: "route-mismatch", reason: `spawn provider "${provider}" does not match the authenticated envelope provider "${envelope.provider}" (fails closed)` };
  }
  if (typeof seatId !== "string" || seatId !== envelope.seatId) {
    return { ok: false, code: "route-mismatch", reason: `spawn seat "${seatId}" does not match the authenticated envelope seat "${envelope.seatId}" (fails closed)` };
  }
  if (routerConfig !== null) {
    const seat = routerConfig?.seats?.find?.((s) => s.seatId === envelope.seatId);
    if (!seat || seat.model !== envelope.model || seat.provider !== envelope.provider || seat.endpointRef !== endpointRef
      || routerConfig?.endpoints?.[endpointRef]?.kind !== envelope.provider) {
      return { ok: false, code: "route-mismatch", reason: "spawn endpoint does not resolve to the authenticated envelope route (fails closed)" };
    }
  }
  return { ok: true, code: null, reason: null };
}

export function pulseWorkerSpawnSeam({ executeHerdrSpawnWorker } = {}) {
  if (typeof executeHerdrSpawnWorker !== "function") {
    throw new Error("pulseWorkerSpawnSeam requires the guarded herdr-lifecycle executeHerdrSpawnWorker");
  }
  return async ({ role, repository, model, placement, context, signal, envelope = null, provider = null, seatId = null, endpointRef = null }) => {
    if (placement !== "host") {
      return { ok: false, code: "containment-seam-unavailable", reason: CONTAINMENT_SEAM_UNAVAILABLE };
    }
    // §5.2 execution validation: the spawn must exactly match the
    // authenticated envelope's route identity. A mismatch fails closed
    // BEFORE any Herdr call is attempted.
    const routeCheck = validateSpawnMatchesEnvelope({ envelope, model, provider, seatId, endpointRef, routerConfig: context?.routerConfig ?? null });
    if (!routeCheck.ok) return routeCheck;
    // Board policy stores canonical repository paths, while the guarded
    // lifecycle accepts only registry names. Convert only a canonical sibling
    // of the coordinator repository; the lifecycle then revalidates the name,
    // registry membership, real path, and Git root before spawning.
    const coordinator = context?.cwd;
    const repositoryName = typeof repository === "string" ? basename(repository) : "";
    if (typeof coordinator !== "string" || coordinator === ""
        || typeof repository !== "string" || repository === ""
        || resolve(repository) !== resolve(coordinator, "..", repositoryName)) {
      return { ok: false, code: "repository-mismatch", reason: "the assignment repository is not a canonical sibling of the coordinator repository" };
    }
    return executeHerdrSpawnWorker({ placement: "tab", role, model, repository: repositoryName }, context, {}, signal);
  };
}

// ---------------------------------------------------------------------------
// Trusted semantic policy operations (§3.3)
// ---------------------------------------------------------------------------

const PULSE_DEFAULTS = Object.freeze({
  enabled: false,
  mode: "interactive",
  intervalSeconds: 300,
  fillOnStart: false,
  routing: {},
  stallTimeoutSeconds: 600,
  unattendedHostRiskAccepted: false,
});

const CHANGE_KINDS = Object.freeze([
  "mode", "intervalSeconds", "fillOnStart", "globalMaxConcurrent",
  "placement", "roleRoute", "stallTimeoutSeconds", "unattendedHostRiskAccepted",
]);

function writePolicyAtomic(path, policy) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function resolveRouteModels(pulse, { scopedModels = null } = {}) {
  const models = new Set();
  for (const entry of Object.values(pulse?.routing ?? {})) {
    for (const route of [...(entry?.preferred ?? []), ...(entry?.fallback ?? [])]) {
      if (typeof route?.model === "string") models.add(route.model);
    }
  }
  if (scopedModels === null) return { ok: true, models: [...models] };
  const scopedList = Array.isArray(scopedModels) ? scopedModels : [];
  // Empty scoped list means no scoping configured: every model is usable.
  if (scopedList.length === 0) return { ok: true, models: [...models] };
  const scopedIds = new Set(scopedList.map((entry) => typeof entry === "string" ? entry : entry?.model).filter((id) => typeof id === "string"));
  for (const model of models) {
    if (!scopedIds.has(model)) return { ok: false, reason: `model "${model}" is not in the session's scoped model list (fails closed)` };
  }
  return { ok: true, models: [...models] };
}

// One trusted semantic policy mutation. `instruction` is the direct user
// request; the operation derives everything else from trusted context,
// previews the semantic result once natively, and writes atomically after
// confirmation. Host-risk acceptance always requires native confirmation and
// fails closed headlessly (§3.3).
export async function pulsePolicyOperation({ action, instruction, changes = null, boardPath, context = null, scopedModels = null, now = null }) {
  if (!["enable", "disable", "configure"].includes(action)) {
    return { ok: false, code: "action-invalid", reason: `unknown policy action "${action}"`, persisted: false };
  }
  if (typeof instruction !== "string" || instruction.trim() === "") {
    return { ok: false, code: "instruction-required", reason: "the policy operation requires the direct current-turn human instruction (fails closed)", persisted: false };
  }
  if (typeof boardPath !== "string" || boardPath === "" || !existsSync(boardPath)) {
    return { ok: false, code: "board-unavailable", reason: "no board file found for this workspace (board-unavailable)", persisted: false };
  }
  const policyPath = automationPolicyPath(boardPath);
  if (!existsSync(policyPath)) {
    return { ok: false, code: "policy-absent", reason: "no automation policy exists for this board; create one before configuring Pulse (fails closed)", persisted: false };
  }
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    return { ok: false, code: "policy-invalid", reason: `the automation policy is unreadable: ${String(error?.message || error).slice(0, 256)}`, persisted: false };
  }
  const baseCheck = checkAutomationPolicy(policy, { boardPath });
  if (!baseCheck.ok) {
    return { ok: false, code: "policy-invalid", reason: baseCheck.reason, persisted: false };
  }
  let pulse = policy.pulse !== undefined
    ? JSON.parse(JSON.stringify(policy.pulse))
    : { ...PULSE_DEFAULTS, routing: {} };

  if (action === "enable") {
    if (policy.pulse === undefined) {
      return { ok: false, code: "pulse-unconfigured", reason: "no Pulse configuration exists for this board; configure routes first, then enable (fails closed)", persisted: false };
    }
    pulse.enabled = true;
  } else if (action === "disable") {
    if (policy.pulse === undefined) {
      return { ok: false, code: "pulse-unconfigured", reason: "Pulse is not configured for this board; nothing to disable", persisted: false };
    }
    pulse.enabled = false;
  } else {
    if (!Array.isArray(changes) || changes.length === 0) {
      return { ok: false, code: "changes-required", reason: "configure requires at least one closed change", persisted: false };
    }
    for (const change of changes) {
      if (change === null || typeof change !== "object" || Array.isArray(change)) {
        return { ok: false, code: "change-invalid", reason: "each change must be an object with a type (fails closed)", persisted: false };
      }
      const kind = change.type;
      if (!CHANGE_KINDS.includes(kind)) {
        return { ok: false, code: "change-invalid", reason: `unknown change type "${kind}" (fails closed)`, persisted: false };
      }
      if (kind === "mode") {
        if (!["interactive", "automated"].includes(change.value)) {
          return { ok: false, code: "change-invalid", reason: "mode must be interactive or automated (fails closed)", persisted: false };
        }
        pulse.mode = change.value;
      } else if (kind === "intervalSeconds") {
        if (!Number.isInteger(change.value) || change.value < 10 || change.value > 86400) {
          return { ok: false, code: "change-invalid", reason: "intervalSeconds must be an integer from 10 through 86400 (fails closed)", persisted: false };
        }
        pulse.intervalSeconds = change.value;
      } else if (kind === "fillOnStart") {
        if (typeof change.value !== "boolean") {
          return { ok: false, code: "change-invalid", reason: "fillOnStart must be a boolean (fails closed)", persisted: false };
        }
        pulse.fillOnStart = change.value;
      } else if (kind === "globalMaxConcurrent") {
        if (!Number.isInteger(change.value) || change.value < 1 || change.value > 32) {
          return { ok: false, code: "change-invalid", reason: "globalMaxConcurrent must be an integer from 1 through 32 (fails closed)", persisted: false };
        }
        policy = { ...policy, maxConcurrent: change.value };
      } else if (kind === "placement") {
        if (!PLACEMENTS.includes(change.value)) {
          return { ok: false, code: "change-invalid", reason: `placement must be one of ${PLACEMENTS.join(", ")} (fails closed)`, persisted: false };
        }
        policy = { ...policy, placement: change.value };
      } else if (kind === "stallTimeoutSeconds") {
        if (!Number.isInteger(change.value) || change.value < 30 || change.value > 86400) {
          return { ok: false, code: "change-invalid", reason: "stallTimeoutSeconds must be an integer from 30 through 86400 (fails closed)", persisted: false };
        }
        pulse.stallTimeoutSeconds = change.value;
      } else if (kind === "unattendedHostRiskAccepted") {
        if (change.value !== false) {
          // Host-risk acceptance always requires native interactive
          // confirmation; it cannot be created headlessly or from vague
          // language (§3.3).
          if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
            return { ok: false, code: "host-risk-headless-denied", reason: "unattended-host risk acceptance requires the native interactive TUI (fails closed; it cannot be recorded headlessly)", persisted: false };
          }
          let accepted;
          try {
            accepted = await context.ui.confirm(
              "Accept unattended host risk",
              [
                "This enables automated Pulse dispatch directly on the host for THIS board policy only:",
                `Board: ${boardPath}`,
                `Repositories: ${(policy.acceptedRepositories ?? []).join(", ")}`,
                `Roles/models: ${Object.keys(pulse.routing ?? {}).join(", ") || "(none configured)"}`,
                `Policy expiry: ${policy.expiry}`,
                "The acceptance is bound to this policy's board, repositories, roles, models, expiry, risk ceiling, and global concurrency. It is not global and cannot be inferred.",
              ].join("\n"),
            );
          } catch (error) {
            return { ok: false, code: "host-risk-confirmation-failed", reason: String(error?.message || error).slice(0, 256), persisted: false };
          }
          if (accepted !== true) {
            return { ok: false, code: "host-risk-not-accepted", reason: "unattended-host risk was not explicitly accepted (fails closed)", persisted: false };
          }
        }
        pulse.unattendedHostRiskAccepted = change.value === true;
      } else if (kind === "roleRoute") {
        const role = change.role;
        if (typeof role !== "string" || !policy.roles.includes(role)) {
          return { ok: false, code: "change-invalid", reason: `roleRoute role "${role}" is not declared in the policy roles (fails closed)`, persisted: false };
        }
        const normalizeRoutes = (list, label) => {
          if (!Array.isArray(list)) return { ok: false, reason: `${label} must be a list of routes (fails closed)` };
          const routes = [];
          for (const route of list) {
            if (route === null || typeof route !== "object" || typeof route.model !== "string"
              || !Number.isInteger(route.maxConcurrent) || route.maxConcurrent < 1 || route.maxConcurrent > 32) {
              return { ok: false, reason: `${label} entries must be {model, maxConcurrent} with capacity 1..32 (fails closed)` };
            }
            routes.push({ model: route.model, maxConcurrent: route.maxConcurrent });
          }
          return { ok: true, routes };
        };
        const preferred = normalizeRoutes(change.preferred, "preferred");
        if (!preferred.ok) return { ok: false, code: "change-invalid", reason: preferred.reason, persisted: false };
        if (preferred.routes.length === 0) {
          return { ok: false, code: "change-invalid", reason: "preferred must list at least one route (fails closed)", persisted: false };
        }
        const fallback = normalizeRoutes(change.fallback ?? [], "fallback");
        if (!fallback.ok) return { ok: false, code: "change-invalid", reason: fallback.reason, persisted: false };
        if (!Number.isInteger(change.maxConcurrent) || change.maxConcurrent < 1 || change.maxConcurrent > 32) {
          return { ok: false, code: "change-invalid", reason: "roleRoute maxConcurrent must be an integer from 1 through 32 (fails closed)", persisted: false };
        }
        pulse.routing = { ...(pulse.routing ?? {}), [role]: { preferred: preferred.routes, fallback: fallback.routes, maxConcurrent: change.maxConcurrent } };
      }
    }
    pulse.enabled = pulse.enabled ?? false;
  }

  // Revalidate the resulting pulse object in place against the declared roles.
  const pulseCheck = checkPulsePolicy(pulse, { roles: policy.roles });
  if (!pulseCheck.ok) {
    return { ok: false, code: "policy-invalid", reason: pulseCheck.reason, persisted: false };
  }
  const modelResolution = resolveRouteModels(pulse, { scopedModels });
  if (!modelResolution.ok) {
    return { ok: false, code: "model-unresolved", reason: modelResolution.reason, persisted: false };
  }
  const nextPolicy = { ...policy, pulse };
  const after = checkAutomationPolicy(nextPolicy, { boardPath });
  if (!after.ok) {
    return { ok: false, code: "policy-invalid", reason: after.reason, persisted: false };
  }

  // One semantic preview in native UI; write atomically after confirmation.
  if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
    return { ok: false, code: "native-confirmation-required", reason: "policy changes require the native TUI for the semantic preview (fails closed)", persisted: false };
  }
  const summary = [
    `Action: ${action} Pulse for board ${boardPath}`,
    `After: enabled=${pulse.enabled} mode=${pulse.mode} interval=${pulse.intervalSeconds}s fillOnStart=${pulse.fillOnStart}`,
    `Routing: ${Object.entries(pulse.routing).map(([role, entry]) => `${role}→${[...entry.preferred, ...entry.fallback].map((r) => r.model).join("|")}`).join("; ") || "(none)"}`,
    `Placement: ${nextPolicy.placement}; globalMaxConcurrent: ${nextPolicy.maxConcurrent}`,
    `Unattended-host risk accepted: ${pulse.unattendedHostRiskAccepted}`,
  ].join("\n");
  let confirmed;
  try {
    confirmed = await context.ui.confirm("Pulse policy change", summary);
  } catch (error) {
    return { ok: false, code: "confirmation-failed", reason: String(error?.message || error).slice(0, 256), persisted: false };
  }
  if (confirmed !== true) {
    return { ok: false, code: "confirmation-denied", reason: "the semantic preview was not confirmed; nothing was written", persisted: false };
  }
  try {
    writePolicyAtomic(policyPath, nextPolicy);
  } catch (error) {
    return { ok: false, code: "policy-write-failed", reason: String(error?.message || error).slice(0, 256), persisted: false };
  }
  return {
    ok: true,
    persisted: true,
    policy: {
      enabled: pulse.enabled,
      mode: pulse.mode,
      intervalSeconds: pulse.intervalSeconds,
      fillOnStart: pulse.fillOnStart,
      routing: pulse.routing,
      stallTimeoutSeconds: pulse.stallTimeoutSeconds,
      unattendedHostRiskAccepted: pulse.unattendedHostRiskAccepted,
      placement: nextPolicy.placement,
      maxConcurrent: nextPolicy.maxConcurrent,
      expiry: nextPolicy.expiry,
      board: nextPolicy.board,
    },
  };
}

// ---------------------------------------------------------------------------
// Timer lifecycle (§8)
// ---------------------------------------------------------------------------

// One session-scoped fixed-interval timer. Ticks never overlap (single-flight
// with skip, not queueing); a long tick delays the next tick rather than
// accumulating work. Missed ticks are never replayed. Injected schedule
// functions keep the lifecycle deterministically testable.
export function createPulseTimer({ intervalSeconds, fillOnStart = false, tick, scheduleFn = null, clearFn = null, now = null } = {}) {
  const setTimeoutFn = scheduleFn ?? setTimeout;
  const clearTimeoutFn = clearFn ?? clearTimeout;
  let handle = null;
  let running = false;
  let stats = { started: 0, ticks: 0, skippedOverlaps: 0, errors: 0, stopped: false };

  const runTick = async () => {
    if (running) {
      stats.skippedOverlaps += 1;
      scheduleNext();
      return;
    }
    running = true;
    stats.ticks += 1;
    try {
      await tick();
    } catch {
      // One compact failure observation; the next ordinary tick is scheduled
      // unless the tick itself reports policy invalid/revoked via stop=true.
      stats.errors += 1;
    } finally {
      running = false;
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    if (stats.stopped || handle !== null) return;
    handle = setTimeoutFn(() => {
      handle = null;
      // Returned promise is tracked for deterministic tests via runTick.
      runTick();
    }, intervalSeconds * 1000);
  };

  return {
    // Awaitable single tick execution (test/observation seam; production
    // callers use start/clear only).
    async runTickNow() {
      // Cancel any pending queued tick first: runTickNow takes over that
      // occurrence so it cannot double-fire, and the settled tick then
      // schedules exactly one ordinary next tick.
      if (handle !== null) {
        clearTimeoutFn(handle);
        handle = null;
      }
      await runTick();
    },
    start() {
      if (stats.stopped || handle !== null) return { ok: false, reason: "timer already started or stopped" };
      stats.started += 1;
      if (fillOnStart) {
        // One scan after startup initialization; this is not catch-up. It
        // queues one tick rather than running synchronously.
        handle = setTimeoutFn(() => {
          handle = null;
          void runTick();
        }, 0);
      } else {
        scheduleNext();
      }
      return { ok: true };
    },
    clear() {
      stats.stopped = true;
      if (handle !== null) {
        clearTimeoutFn(handle);
        handle = null;
      }
      return { ok: true };
    },
    stats() {
      return { ...stats };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool registration (§12.2)
// ---------------------------------------------------------------------------

export function registerPulseTools(pi, { resolveBoardPath: resolveBoardPathFn = null, spawnWorker = null, routerRuntimeFor = null } = {}) {
  const boardPathFor = (ctx) => {
    const cwd = typeof ctx === "string" ? ctx : ctx?.cwd;
    if (typeof resolveBoardPathFn === "function") return resolveBoardPathFn(ctx);
    return resolveBoardPath(cwd);
  };
  const registered = [];
  if (typeof pi?.registerTool !== "function") return { registered };
  pi.registerTool({
    name: "agentic_kanban_pulse",
    label: "Kanban Pulse",
    description:
      "Board Pulse: capacity scheduling for the validated task board. check = pure observation (no claims). run = interactive capacity-filling batch under current policy with one native confirmation. enable/disable/configure = trusted semantic policy mutation with native preview. Pulse is off unless the board policy enables it. This is not worker liveness observation (Herdr pulse).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["check", "run", "enable", "disable", "configure"] },
        instruction: { type: "string", description: "The direct current-turn human request, copied by the coordinator. Required for run/enable/disable/configure; empty or agent-invented instructions fail closed." },
        changes: {
          type: "array",
          description: "configure only: closed semantic change list (mode, intervalSeconds, fillOnStart, globalMaxConcurrent, placement, roleRoute, stallTimeoutSeconds, unattendedHostRiskAccepted).",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["mode", "intervalSeconds", "fillOnStart", "globalMaxConcurrent", "placement", "roleRoute", "stallTimeoutSeconds", "unattendedHostRiskAccepted"] },
              value: {},
              role: { type: "string" },
              preferred: { type: "array", items: { type: "object", additionalProperties: false, properties: { model: { type: "string" }, maxConcurrent: { type: "integer" } }, required: ["model", "maxConcurrent"] } },
              fallback: { type: "array", items: { type: "object", additionalProperties: false, properties: { model: { type: "string" }, maxConcurrent: { type: "integer" } }, required: ["model", "maxConcurrent"] } },
              maxConcurrent: { type: "integer" },
            },
            required: ["type"],
          },
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const fail = (code, reason) => {
        const value = { ok: false, code, reason, errors: [reason], nonAuthorizing: true, persisted: false };
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
      };
      const action = input?.action;
      const activeBoardPath = boardPathFor(ctx);
      let runtimeContext = ctx;
      let runtimeError = null;
      if (["check", "run"].includes(action) && typeof routerRuntimeFor === "function" && activeBoardPath) {
        try {
          // W4: `check` is pure observation, so the runtime is assembled
          // read-only (no store writes, no store creation) while `run` uses
          // the write-mode runtime its claims need.
          runtimeContext = { ...ctx, ...(await routerRuntimeFor(ctx, activeBoardPath, { readOnly: action === "check" })) };
        }
        catch (error) { runtimeError = String(error?.message || error).slice(0, 512); }
      }
      if (action === "check") {
        if (!activeBoardPath || !existsSync(activeBoardPath)) {
          return fail("board-unavailable", "no board file found for this workspace (board-unavailable)");
        }
        const result = pulseCheck({
          boardPath: activeBoardPath,
          modelRegistry: runtimeContext?.modelRegistry ?? null,
          scopedModels: runtimeContext?.scopedModels ?? null,
          observedAt: new Date().toISOString(),
          activeSessions: runtimeContext?.activeSessions ?? [],
          providerLimit: runtimeContext?.providerLimit ?? null,
        });
        if (!result.ok) return fail(result.code, result.reason);
        // Routing is part of the observation: when the router is available
        // the check carries the real route decisions; when it is not, the
        // scan is still reported (pure observation, zero scheduling
        // effects) with a structured routing failure — dispatch paths
        // (run/tick) fail closed separately.
        let routing;
        if (runtimeError !== null) {
          routing = { ok: false, code: "router-unavailable", reason: runtimeError };
        } else {
          const routed = await routePulseCheck(result, { ...(runtimeContext?.routerSnapshot ?? {}),
            routerConfig: runtimeContext?.routerConfig, now: runtimeContext?.routerNow ?? new Date().toISOString() });
          routing = routed.ok
            ? { ok: true, routeDecisions: routed.decisions.map((decision) => ({ cardId: decision.cardId,
                seatId: decision.selectedSeatId, routeDecisionDigest: decision.digest })) }
            : { ok: false, code: routed.code, reason: routed.reason };
        }
        const value = { ok: true, nonAuthorizing: true, persisted: false, scan: result.scan, routing };
        return {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          details: { ...value, diagnosticHash: result.diagnosticHash },
        };
      }
      if (action === "run") {
        if (!activeBoardPath || !existsSync(activeBoardPath)) {
          return fail("board-unavailable", "no board file found for this workspace (board-unavailable)");
        }
        if (runtimeError !== null) return fail("router-unavailable", runtimeError);
        const result = await pulseRun({
          boardPath: activeBoardPath,
          instruction: input?.instruction,
          context: runtimeContext,
          spawnWorker,
        });
        if (!result.ok) return fail(result.code, result.reason);
        const value = {
          ok: true, nonAuthorizing: true, persisted: false,
          cancelled: result.cancelled === true,
          scan: result.scan,
          landedAssignments: result.landedAssignments,
          batchTerminalReason: result.batchTerminalReason,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          details: { ...value, batchId: result.batchId ?? null },
        };
      }
      if (["enable", "disable", "configure"].includes(action)) {
        if (!activeBoardPath || !existsSync(activeBoardPath)) {
          return fail("board-unavailable", "no board file found for this workspace (board-unavailable)");
        }
        const result = await pulsePolicyOperation({
          action,
          instruction: input?.instruction,
          changes: input?.changes ?? null,
          boardPath: activeBoardPath,
          context: ctx,
          scopedModels: ctx?.scopedModels ?? null,
        });
        if (!result.ok) return fail(result.code, result.reason);
        const value = { ok: true, nonAuthorizing: false, persisted: result.persisted, policy: result.policy };
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
      }
      return fail("action-invalid", `unknown action "${action}"`);
    },
  });
  registered.push("agentic_kanban_pulse");
  return { registered };
}
