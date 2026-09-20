// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Ranking adapter (ROUTER_DESIGN_TASK68 §6.4): the janus HTTP client for
// route_rank + rank_confidence, with the deterministic preference-order
// fallback as the default path. Ranking is bounded (max 8 candidates),
// audit-only in its confidence output, and NEVER blocks dispatch: any janus
// failure — unavailable, timeout, malformed — falls back to the config's
// preference order. The fallback path works with janus absent entirely.
//
// No network calls happen inside any lock; the adapter is injected into the
// route-decision engine as `janusRank`.

import { canonicalJsonString, sha256Hex } from "./router_schemas_pi.js";

export const RANKING_MAX_CANDIDATES = 8;
export const RANKING_TIMEOUT_MS = 3000;

// Build the candidate state per seat (§6.4): no credentials, no endpoint
// URLs. locality is local | hosted; quota bucket is high | medium | low |
// reserve-zone (derived from the reserve evaluation, never from model
// output); phase-suitability tags come from the seat's capability set.
export function rankingCandidates({ eligibleSeatIds, seatsById, quotaBuckets = {} }) {
  return (Array.isArray(eligibleSeatIds) ? eligibleSeatIds : [])
    .slice(0, RANKING_MAX_CANDIDATES)
    .map((seatId) => {
      const seat = seatsById.get(seatId);
      if (!seat) return null;
      return {
        seatId,
        kind: seat.kind,
        costClass: seat.costClass,
        locality: seat.kind === "local" ? "local" : "hosted",
        quotaBucket: quotaBuckets[seatId] ?? null,
        phaseTags: [...(Array.isArray(seat.capabilities) ? seat.capabilities : [])],
      };
    })
    .filter((c) => c !== null);
}

export function candidateSetDigest(candidates) {
  return sha256Hex(canonicalJsonString(candidates));
}

// The ranking question (§6.4): route_rank (choice over candidate seatIds)
// plus rank_confidence (score 0..5). rank_confidence is AUDIT-ONLY: it is
// recorded in the ranking observation and never influences eligibility,
// ordering, or tie-breaking.
export function rankingQuestion(candidates) {
  return {
    questions: {
      route_rank: {
        type: "choice",
        options: candidates.map((c) => c.seatId),
        prompt: "Which seat class should take this work?",
      },
      rank_confidence: {
        type: "score",
        min: 0,
        max: 5,
        prompt: "How confident is the route ranking?",
      },
    },
    state: { candidates },
  };
}

// Apply a janus ranking response to the fallback order. Returns the ranked
// order only when the response is well-formed AND covers exactly the
// fallback set (no invented seats, none dropped); otherwise null (→
// deterministic fallback). rank_confidence is parsed for the audit record
// only.
export function applyRankingResponse({ response, fallbackOrder }) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) return null;
  const answers = response.answers ?? response;
  const rank = answers?.route_rank;
  if (typeof rank !== "string" || !fallbackOrder.includes(rank)) return null;
  // A single choice reorders deterministically: chosen first, remaining
  // seats keep their deterministic preference order.
  const ranked = [rank, ...fallbackOrder.filter((id) => id !== rank)];
  const confidence = answers?.rank_confidence;
  return {
    order: ranked,
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 5 ? Number(confidence) : null,
  };
}

// The injected adapter surface. `fetchFn` is injectable for tests (no
// network calls in tests). On ANY failure — fetch throws, non-2xx, timeout,
// malformed body — this returns null and the caller falls back.
export function createJanusRankAdapter({ janusUrl, fetchFn = null, timeoutMs = RANKING_TIMEOUT_MS } = {}) {
  if (typeof janusUrl !== "string" || janusUrl === "") {
    // No janus configured: the fallback IS the path.
    return async () => null;
  }
  const doFetch = fetchFn ?? globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== "function") return async () => null;
  return async ({ candidates, question, requestId }) => {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(`${janusUrl.replace(/\/$/, "")}/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, ...question }),
        signal: controller?.signal,
      });
      if (!res || typeof res.ok !== "boolean" || !res.ok) return null;
      const body = await res.json();
      return body;
    } catch {
      return null; // unavailable, timeout, malformed — never blocks
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// The full ranking step used by the route-decision path: rank or fall back,
// and record the observation for audit. Never throws; never blocks.
export async function rankOrFallback({ config, eligibleSeatIds, seatsById, quotaBuckets = {}, janusRank = null, now }) {
  const preferenceOrder = (config?.preferences?.order ?? []).map((e) => e.seatId)
    .filter((id) => eligibleSeatIds.includes(id));
  const rest = eligibleSeatIds.filter((id) => !preferenceOrder.includes(id));
  const fallbackOrder = [...preferenceOrder, ...rest];
  if (fallbackOrder.length === 0) return { order: [], used: false, requestId: null, digest: null, confidence: null, outcome: "no-candidates" };

  const candidates = rankingCandidates({ eligibleSeatIds: fallbackOrder, seatsById, quotaBuckets });
  const digest = candidateSetDigest(candidates);
  if (config?.ranking?.enabled !== true || typeof janusRank !== "function") {
    return { order: fallbackOrder, used: false, requestId: null, digest, confidence: null, outcome: "fallback-disabled" };
  }
  const requestId = `rank-${now}-${digest.slice(0, 12)}`;
  const question = rankingQuestion(candidates);
  let response = null;
  try {
    response = await janusRank({ candidates, question, requestId });
  } catch {
    response = null;
  }
  const applied = applyRankingResponse({ response, fallbackOrder });
  if (applied === null) {
    return { order: fallbackOrder, used: false, requestId, digest, confidence: null, outcome: "fallback-failed" };
  }
  return { order: applied.order, used: true, requestId, digest, confidence: applied.confidence, outcome: "ranked" };
}
