// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Pulse core (PULSE_DESIGN_v3 §2.2, §4, §5): a side-effect-free evaluation of
// one selected board. It consumes validated board cards, active claim
// observations, a validated automation policy (with its optional closed
// `pulse` object), and model-availability observations supplied by trusted
// adapters. It returns one Pulse result per card, composed free capacity per
// role/model route, and a deterministic scheduling proposal.
//
// It never reads files, claims cards, spawns workers, starts timers, or
// mutates policy. Eligibility grants no authority: the existing dispatcher
// owns atomic claim and envelope creation.

import {
  canonicalJsonString, sha256Hex, isDispatchable,
} from "./task_board_core_pi.js";
export { canonicalJsonString, sha256Hex };

export const PULSE_SCAN_SCHEMA = "agentic-driver.board-pulse.v1";

// The five closed Pulse results (§5). Exactly one per evaluated card.
export const PULSE_RESULTS = Object.freeze([
  "READY_FOR_NEXT", "BLOCKED", "STALE", "DENIED", "REVIEW_REQUIRED",
]);

const PRIORITY_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });
const AVAILABILITY = Object.freeze([
  "available", "full", "unauthenticated", "unavailable", "unknown",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Close the availability observation for one model. Only declared
// preferred/fallback route models are considered; anything else is unknown
// and unavailable for routing (§3.1: fails closed).
export function modelAvailability({ model, observations = null, declaredModels = null }) {
  if (declaredModels !== null && !declaredModels.includes(model)) return "unknown";
  const observed = isPlainObject(observations) ? observations[model] : undefined;
  if (observed === undefined) return "unknown";
  if (!isPlainObject(observed)) return "unknown";
  const status = observed.status;
  if (status === "available" || status === "full"
    || status === "unauthenticated" || status === "unavailable") return status;
  return "unknown";
}

// True only when the model can take new work this tick. "full" means the
// provider reported a live limit reached; the route is full, not unusable —
// UNLESS an explicit provider-limit observation says otherwise (router design
// §9 item 1): a bare "full" with no provider limit is treated as unusable
// because capacity cannot be verified, and capacity races must fail closed.
export function modelUsable(availability, { providerLimit = null, providerActive = null } = {}) {
  if (availability === "available") return true;
  if (availability === "full") {
    return Number.isInteger(providerLimit) && Number.isInteger(providerActive)
      && providerLimit > 0 && providerActive < providerLimit;
  }
  return false;
}

// Composed free capacity for one role/model route (§4.2):
//   free = min(configured route ceiling, role ceiling, policy-wide ceiling)
//          - unique active work for role/model
// Active work is deduplicated by attempt identity across claims and verified
// sessions; a session bound to an active claim counts once.
export function freeCapacity({ role, model, pulsePolicy, activeClaims = [], activeSessions = [], providerLimit = null }) {
  const routing = pulsePolicy?.routing ?? {};
  const roleEntry = routing[role];
  const routes = [...(roleEntry?.preferred ?? []), ...(roleEntry?.fallback ?? [])];
  const route = routes.find((entry) => entry?.model === model) ?? null;
  if (!route) return { free: 0, configured: 0, reason: `model "${model}" is not a declared route for role "${role}"` };

  // Deduplicate active work by attempt identity (envelope id when present,
  // else session id). A session matching an active claim counts once.
  const claimIdentities = new Set(
    (activeClaims ?? [])
      .filter((claim) => claim?.role === role && claimModel(claim) === model)
      .map((claim) => claim?.envelopeId ?? claim?.envelope?.envelopeId ?? `claim:${claim?.cardId}`)
      .filter((id) => typeof id === "string"),
  );
  const boundSessionIds = new Set(
    (activeClaims ?? []).map((claim) => claim?.sessionId).filter((id) => typeof id === "string"),
  );
  const orphanSessions = (activeSessions ?? []).filter((session) => {
    if (session?.role !== role || session?.model !== model) return false;
    if (typeof session?.sessionId !== "string") return false;
    if (boundSessionIds.has(session.sessionId)) return false;
    // An observed orphan session counts separately only after reconciliation
    // cannot bind it to an active attempt; ambiguity consumes capacity (§4.2).
    return session.reconciled === true || session.reconciled === undefined;
  });
  const active = claimIdentities.size + orphanSessions.length;

  const routeCeiling = route.maxConcurrent;
  const roleCeiling = roleEntry?.maxConcurrent ?? routeCeiling;
  // §9 item 2: the policy-wide ceiling is the automation policy's own
  // maxConcurrent (the actual global ceiling). The legacy pulsePolicy
  // .globalMaxConcurrent lookup is removed — that field never existed in the
  // closed pulse shape.
  const policyCeiling = Number.isInteger(pulsePolicy?.maxConcurrent)
    ? pulsePolicy.maxConcurrent
    : null;
  const configured = Math.min(routeCeiling, roleCeiling, policyCeiling ?? routeCeiling);
  const providerCap = Number.isInteger(providerLimit) && providerLimit >= 0 ? providerLimit : null;
  const ceiling = providerCap === null ? configured : Math.min(configured, providerCap);
  return { free: Math.max(0, ceiling - active), configured, reason: null };
}

// The model a claim is running under. Claims carry the exact model on their
// envelope when Pulse created them; legacy claims without one count against
// no specific model route — we attribute them to nothing rather than guess
// (no silent substitution).
function claimModel(claim) {
  return typeof claim?.envelope?.model === "string" ? claim.envelope.model : null;
}

// Ordered candidate routes for a role: preferred first, then fallback in
// declaration order (§3.1). Fallback is considered only when preferred
// routes are unavailable or full.
export function routesForRole(role, pulsePolicy) {
  const entry = pulsePolicy?.routing?.[role];
  if (!entry) return [];
  return [
    ...entry.preferred.map((route) => ({ ...route, tier: "preferred" })),
    ...entry.fallback.map((route) => ({ ...route, tier: "fallback" })),
  ];
}

// Evaluate one card and return exactly one Pulse result plus a reason (§5).
// Inputs are already trusted: the card comes from parseBoard/validateBoard,
// the policy from checkAutomationPolicy. Capacity never changes a card
// result — it only changes `capacity` and `proposedDispatches`.
export function evaluateCard({ card, boardIndex, activeClaims = [], pulsePolicy = null, modelObservations = null, declaredModels = null, acceptedRepositories = null, providerLimit = null, providerActive = null }) {
  // Provenance verification is the caller adapter's responsibility: it
  // supplies cards with `statePath` only when the trusted writer state is
  // available. The core stays side-effect-free and file-free.
  const failed = isDispatchable(card, boardIndex).failedConditions ?? [];
  const claimed = (activeClaims ?? []).some((claim) => claim?.cardId === card.cardId);
  if (claimed) failed.push("card is already claimed by an active authenticated attempt");
  if (failed.length > 0) {
    const text = failed.join("; ");
    if (claimed) {
      return { result: "BLOCKED", reason: "card is already claimed by an active authenticated attempt" };
    }
    if (/hash|provenance|authority|tampered/.test(text)) {
      return { result: "STALE", reason: text };
    }
    if (/expired|revoked|prohibited|not declared|placement|risk/i.test(text)) {
      return { result: "DENIED", reason: text };
    }
    if (/dependenc|lane|blocked|cancelled|flag/i.test(text)) {
      return { result: "BLOCKED", reason: text };
    }
    return { result: "REVIEW_REQUIRED", reason: text };
  }

  // Policy gate (§5 DENIED): no policy, expired/revoked policy, or a role the
  // policy does not declare and route.
  if (!isPlainObject(pulsePolicy) || pulsePolicy.enabled !== true) {
    return { result: "REVIEW_REQUIRED", reason: "Pulse is not enabled for this board" };
  }
  const role = typeof card.role === "string" && card.role !== "" ? card.role : "implementer";
  const routes = routesForRole(role, pulsePolicy);
  if (routes.length === 0) {
    return { result: "DENIED", reason: `no Pulse route is declared for role "${role}" (fails closed)` };
  }
  // Repository gate (§9): the card must identify a repository the policy
  // accepts. A card naming exactly one repository is unambiguous; otherwise
  // a single-repository policy supplies the default. Ambiguity fails closed.
  if (Array.isArray(acceptedRepositories) && acceptedRepositories.length > 0) {
    const named = Array.isArray(card.repositories) ? card.repositories.filter((r) => typeof r === "string" && r !== "") : [];
    const repository = named.length === 1 ? named[0]
      : named.length === 0 && acceptedRepositories.length === 1 ? acceptedRepositories[0]
      : null;
    if (repository === null || !acceptedRepositories.includes(repository)) {
      return { result: "DENIED", reason: "card repository is ambiguous or not in the policy acceptedRepositories (fails closed)" };
    }
  }
  // Route availability: at least one declared route must be usable. Without
  // an authorised fallback this is REVIEW_REQUIRED (§5), never a substitution.
  // "full" counts as usable only with an explicit provider limit (§9 item 1).
  const usable = routes.filter((route) => modelUsable(modelAvailability({
    model: route.model, observations: modelObservations, declaredModels,
  }), {
    providerLimit,
    providerActive: isPlainObject(providerActive) ? providerActive[route.model] : providerActive,
  }));
  if (usable.length === 0) {
    return { result: "REVIEW_REQUIRED", reason: `no usable declared route for role "${role}" (preferred unavailable without authorised fallback)` };
  }
  return { result: "READY_FOR_NEXT", reason: null, role, routes: usable };
}

// One full board scan (§4.3, §5). Deterministic: cards in board P0→P3 then
// card-ID order; capacity in role-then-route declaration order; proposals in
// selection order. No cross-board priority comparison happens here.
export function scanBoard({ cards, boardPath, boardRevision = null, policyRevision = null, activeClaims = [], pulsePolicy = null, modelObservations = null, declaredModels = null, observedAt = null, placement = null, activeSessions = [], providerLimit = null }) {
  const index = new Map(cards.map((card) => [card.cardId, card]));
  const ordered = [...cards].sort((a, b) =>
    (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
    || String(a.cardId).localeCompare(String(b.cardId)));

  const cardResults = [];
  const capacity = [];
  const proposedDispatches = [];
  // §9 item 2: the policy-wide ceiling is the automation policy's
  // maxConcurrent. §9 item 3: the production path supplies activeSessions
  // and providerLimit; the scan composes them into capacity.
  const policyWideRemaining = Number.isInteger(pulsePolicy?.maxConcurrent)
    ? pulsePolicy.maxConcurrent - (activeClaims ?? []).length
    : null;

  const roleOrder = pulsePolicy?.routing ? Object.keys(pulsePolicy.routing) : [];
  for (const role of roleOrder) {
    for (const route of routesForRole(role, pulsePolicy)) {
      const availability = modelAvailability({ model: route.model, observations: modelObservations, declaredModels });
      const free = freeCapacity({ role, model: route.model, pulsePolicy, activeClaims, activeSessions, providerLimit });
      capacity.push({
        role, model: route.model, configured: free.configured,
        activeClaims: (activeClaims ?? []).filter((claim) => claim?.role === role && claimModel(claim) === route.model).length,
        startingOrRunning: 0,
        providerLimit: Number.isInteger(providerLimit) && providerLimit >= 0 ? providerLimit : null,
        free: modelUsable(availability, { providerLimit, providerActive: (activeSessions ?? []).filter((s) => s?.model === route.model).length }) ? free.free : 0,
        availability,
      });
    }
  }

  const remainingByRoute = new Map(capacity.map((entry) => [`${entry.role}\u0000${entry.model}`, entry.free]));
  let globalRemaining = policyWideRemaining;
  // Placement for proposals is supplied by the scheduler adapter (the pulse
  // object does not carry it; the policy's placement field governs). In
  // automated mode containment is the default when available (§3.2); the core
  // never decides containment availability.
  const scanPlacement = placement;

  for (const card of ordered) {
    const evaluation = evaluateCard({
      card, boardIndex: index, boardPath, activeClaims, pulsePolicy,
      modelObservations, declaredModels,
      acceptedRepositories: pulsePolicy?.acceptedRepositories ?? null,
      providerLimit,
      providerActive: Object.fromEntries(routesForRole(
        typeof card.role === "string" && card.role !== "" ? card.role : "implementer",
        pulsePolicy,
      ).map((route) => [route.model, (activeSessions ?? []).filter((session) => session?.model === route.model).length])),
    });
    const entry = { title: card.title, role: evaluation.role ?? (typeof card.role === "string" && card.role !== "" ? card.role : "implementer"), result: evaluation.result, reason: evaluation.reason };
    cardResults.push(entry);
    if (evaluation.result !== "READY_FOR_NEXT") continue;

    // Propose at most free capacity and policy-wide remaining capacity (§4.3
    // step 5): preferred routes first, then declared fallback, in order.
    let proposed = false;
    for (const route of evaluation.routes) {
      const key = `${entry.role}\u0000${route.model}`;
      const remaining = remainingByRoute.get(key) ?? 0;
      if (remaining <= 0) continue;
      if (globalRemaining !== null && globalRemaining <= 0) break;
      remainingByRoute.set(key, remaining - 1);
      if (globalRemaining !== null) globalRemaining -= 1;
      proposedDispatches.push({ title: card.title, role: entry.role, model: route.model, placement: scanPlacement });
      proposed = true;
      break;
    }
    if (!proposed && evaluation.routes.length > 0) {
      // Ready but no free slot: the card result stays READY_FOR_NEXT (§5);
      // capacity alone gates the proposal.
      entry.reason = "ready; no free capacity on any declared route this tick";
    }
  }

  const scan = {
    schema: PULSE_SCAN_SCHEMA,
    board: boardPath,
    boardRevision,
    policyRevision,
    observedAt: observedAt ?? null,
    cards: cardResults,
    capacity,
    proposedDispatches,
    authorityCreated: false,
  };
  // Internal diagnostic hash only (§5): canonical input is the closed public
  // result, serialized by the existing canonical JSON helper and SHA-256
  // hashed. It grants no authority and is not part of the public shape.
  const diagnosticHash = sha256Hex(canonicalJsonString(scan));
  return { scan, diagnosticHash };
}
