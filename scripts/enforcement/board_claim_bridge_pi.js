// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Board-claim bridge for Vogelkop (vogelkop phase #47, step 3).
//
// Vogelkop reads its TASKS.md, selects the next eligible governed card, and
// emits a versioned claim request (vogelkop.board-claim-request.v1). This
// module services that request by DELEGATING to the existing board authority
// implementation — claimCard in task_board_core_pi.js — which already owns
// the writer-lock CAS, the claims-file HMAC, expiry/single-attempt, and
// card-hash verification. Nothing here reimplements claims, lanes, HMACs, or
// writer state.
//
// The one thing this module adds is the pre-claim card-hash binding: the
// request carries the card's own on-disk [hash::] value, and it is verified
// against the board bytes BEFORE the claim is attempted, so a stale or
// tampered card is refused with a precise reason instead of surfacing as a
// generic no-dispatchable-card failure. The authoritative hash verification
// still happens inside claimCard's own dispatchability predicate.
//
// Route authority: the request's route is explicit user-authored board
// metadata (a #route-<seat-alias> tag) or an injected Jev fallback. The
// bridge NEVER re-routes: it records the route source on the receipt and
// binds the route into the envelope through claimCard's `route` parameter
// (the route decision identity the envelope carries). The model-moat gate
// result travels on the request and is recorded, not re-judged.
//
// The receipt is a versioned, non-authorizing observation. It contains no
// secrets and no endpoints.

import {
  claimCard,
  validateBoard,
  readClaimsState,
  computeCardHash,
  canonicalJsonString,
  sha256Hex,
  createEnvelope as createEnvelopeBase,
  workspaceRegistriesFor,
} from "./task_board_core_pi.js";
import { readFileSync, existsSync } from "node:fs";

export const BOARD_CLAIM_BRIDGE_SCHEMA = "agentic-driver.board-claim-bridge.v1";
export const BOARD_CLAIM_RECEIPT_SCHEMA = "vogelkop.board-claim-receipt.v1";
export const REQUEST_SCHEMA = "vogelkop.board-claim-request.v1";

const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const ROUTE_SOURCE_KINDS = new Set(["explicit-board-route", "jev-fallback"]);

function verifiedMoat({ request, backendBaseUrlFor, moatPolicy }) {
  if (typeof backendBaseUrlFor !== "function") {
    return fail("moat-evidence-required", "the authority boundary requires a trusted backend registry lookup (fails closed)");
  }
  const baseUrl = backendBaseUrlFor(request.route.seatAlias);
  let host;
  try { host = new URL(baseUrl).hostname; } catch {
    return fail("moat-evidence-invalid", "the trusted backend registry did not provide a valid URL (fails closed)");
  }
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!local && moatPolicy?.allowHostedEgress !== true) {
    return fail("moat-denied", `backend host "${host}" is not loopback — hosted egress is denied (fails closed)`);
  }
  return { ok: true, evidence: { ok: true, locality: local ? "local" : "hosted", basis: "trusted-backend-registry" } };
}

function fail(code, reason, extra = {}) {
  return { ok: false, schema: BOARD_CLAIM_BRIDGE_SCHEMA, code, reason, ...extra };
}

/**
 * Verify the request's cardHash against the CURRENT board bytes. This is the
 * stale/tampered-card gate: a card edited after the request was minted is
 * refused here, before any claim machinery runs.
 */
export function verifyRequestedCard({ boardPath, request }) {
  if (!existsSync(boardPath)) return fail("board-unavailable", "board file is not present");
  let registries;
  try { registries = workspaceRegistriesFor(boardPath); }
  catch (error) { return fail(error?.code ?? "capability-registry-invalid", error?.message ?? String(error)); }
  const validated = validateBoard(readFileSync(boardPath, "utf8"), registries);
  if (!validated.ok) return fail("board-invalid", validated.errors.join("; "), { errors: validated.errors });
  const card = validated.cards.find((entry) => entry.cardId === request.cardId);
  if (!card) return fail("card-not-found", `card ${request.cardId} is not on the board`);
  const onDiskHash = card.hash ?? computeCardHash(card);
  if (onDiskHash !== request.cardHash) {
    return fail("card-hash-mismatch",
      `request cardHash does not match the on-disk card hash (stale or tampered request — fails closed)`);
  }
  return { ok: true, card, validated };
}

/**
 * Mint the route-decision identity the envelope carries. The bridge does not
 * re-route: the seat/model identity comes from the request's resolved route
 * (explicit board route or injected Jev fallback), and the digest binds it
 * deterministically so the envelope's routeDecisionDigest is reproducible
 * from the receipt. No router config, no capacity snapshot, no janus call.
 */
export function bridgeRouteFor({ request, repository }) {
  return {
    seatId: `vogelkop-${request.route.seatAlias}`,
    accountId: null,
    provider: "vogelkop-router",
    model: request.route.seatAlias,
    role: request.route.seat,
    effort: "default",
    containmentTier: "testudo",
    phase: "implement",
    routeDecisionDigest: sha256Hex(canonicalJsonString({
      schema: "vogelkop.board-claim-route.v1",
      cardId: request.cardId,
      seatAlias: request.route.seatAlias,
      seat: request.route.seat,
      routeSource: request.route.source,
      moat: request.moat,
      repository,
    })),
    reservationId: null,
  };
}

/**
 * Service one claim request. Single attempt, no retry: whatever claimCard
 * returns is the outcome. The receipt is a versioned, non-authorizing
 * observation carrying the card binding, the claim/envelope identity, the
 * route source and model, the moat result, and the branch/base/scope.
 */
export function claimFromVogelkopRequest({ boardPath, request, policy = null, now = null, backendBaseUrlFor = null, moatPolicy = null }) {
  if (request?.schema !== REQUEST_SCHEMA) {
    return fail("request-schema-invalid", `unknown request schema "${String(request?.schema)}"`);
  }
  if (request.boardPathBasename !== "TASKS.md") {
    return fail("request-board-invalid", "the request must name the canonical TASKS.md board");
  }
  if (typeof request.cardId !== "string" || request.cardId === "") {
    return fail("request-card-invalid", "the request carries no cardId");
  }
  if (!/^[0-9a-f]{64}$/.test(request.cardHash ?? "")) {
    return fail("request-hash-invalid", "the request cardHash is not a sha256 hex digest");
  }
  if (request.authorityCreated !== false) {
    return fail("request-authority-invalid", "a claim request never carries authority (fails closed)");
  }
  if (typeof request.route?.seatAlias !== "string" || request.route.seatAlias === ""
      || typeof request.route?.seat !== "string" || !ROLE_NAME_RE.test(request.route.seat)) {
    return fail("request-route-invalid", "the request carries no valid resolved route seat and alias");
  }
  if (!ROUTE_SOURCE_KINDS.has(request.route?.source?.kind)) {
    return fail("request-route-source-invalid", "the route source is not in the closed source vocabulary");
  }
  const moat = verifiedMoat({ request, backendBaseUrlFor, moatPolicy });
  if (!moat.ok) return moat;

  const verify = verifyRequestedCard({ boardPath, request });
  if (!verify.ok) return verify;

  // Delegation: the existing claim machinery owns exclusivity, HMAC,
  // expiry, and authoritative hash verification. The route is bound as the
  // envelope's route identity; the policy is the caller's (the automation
  // policy file beside the board is used when none is supplied).
  const route = bridgeRouteFor({ request, repository: boardPath.replace(/\/[^/]*$/, "") });
  const result = claimCard({ boardPath, cardId: request.cardId, role: request.route.seat, policy, now, route });
  if (!result.ok && result.code !== "claim-recoverable") {
    return fail(result.code ?? "claim-refused", result.reason ?? (result.errors ?? []).join("; "), {
      errors: result.errors ?? [],
    });
  }

  const envelope = result.envelope;
  const claims = readClaimsState(boardPath);
  const claimRecord = claims.ok
    ? claims.state.claims.find((entry) => entry.envelopeId === envelope.envelopeId) ?? null
    : null;
  return {
    ok: result.ok,
    schema: BOARD_CLAIM_RECEIPT_SCHEMA,
    code: result.code ?? null,
    recoverable: result.recoverable === true,
    claimed: true,
    nonAuthorizing: true,
    authorityCreated: false,
    persisted: true,
    cardId: envelope.cardId,
    cardHash: envelope.cardHash,
    claimId: claimRecord ? `${claimRecord.cardId}@${claimRecord.claimedAt}` : null,
    envelopeId: envelope.envelopeId,
    route: {
      source: request.route.source,
      seat: request.route.seat,
      seatAlias: request.route.seatAlias,
      model: envelope.model,
      provider: envelope.provider,
    },
    moat: moat.evidence,
    branch: envelope.branch,
    baseRevision: envelope.baseRevision,
    startingRevision: envelope.startingRevision,
    scope: [...envelope.allowedPaths],
    stoppingPoint: envelope.stoppingPoint,
    repository: envelope.repository,
    claimedAt: claimRecord?.claimedAt ?? null,
    expiresAt: envelope.expiry,
  };
}
