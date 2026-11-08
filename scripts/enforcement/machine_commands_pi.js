// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only
// Host-bound commands shared by both transports. Context is installed by the host,
// never supplied by a remote caller; receipts and approval records are not authority.
import { WORKER_DISPATCH_TERMINAL_STATES, runWorkerJourney } from "./herdr_async_dispatch_pi.js";
import { claimCard, updateCard, consumeEnvelope, readClaimsState } from "./task_board_core_pi.js";
import { getReservation, reservationForEnvelope, reconcileReservationFromClaim, releaseReservation } from "./router_store_pi.js";

const FINISH = new Set([...WORKER_DISPATCH_TERMINAL_STATES, "expired", "reclaimed"]);
const SETTLE = Object.freeze({ abandon: "reclaimed", expire: "expired", "confirmed-missing": "reclaimed" });
const refuse = (code, reason) => ({ ok: false, status: code, code, reason });
const outcome = (value) => value?.ok === false ? { ...value, status: value.status ?? value.code } : value;
const runOutcome = async (promise) => { const value = await promise; return { ok: true, status: value.state, ...value }; };

export function createMachineCommands({ boardPath, routerStore = null, durable = null, journey = null,
  verifySpawn = null, verifyMissing = null, verifyReceipt = null, verifyJourneyFinish = null,
  authorizeCard = null, routeForClaim = null } = {}) {
  if (typeof boardPath !== "string" || !boardPath) throw new Error("host boardPath required");
  const liveClaim = (envelopeId) => {
    const read = readClaimsState(boardPath);
    if (!read.ok) return refuse("needs-reconciliation", read.reason);
    return read.state.claims.find((claim) => claim.envelopeId === envelopeId) ?? null;
  };
  const paired = async (action, { envelopeId, idempotencyKey }) => {
    if (typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) return refuse("invalid-input", "idempotencyKey required");
    const claim = liveClaim(envelopeId);
    if (claim?.ok === false) return claim;
    // A prior board settlement may need its SQLite half finished after interruption.
    const state = readClaimsState(boardPath);
    const event = state.ok && state.state.events.findLast((item) => item.action === "settle" && item.envelopeId === envelopeId);
    if (!claim && (event?.key !== idempotencyKey || event.reason !== SETTLE[action])) return refuse("claim-not-found", "no matching live claim or settlement");
    const reservationId = claim?.envelope?.reservationId ?? (routerStore && reservationForEnvelope(routerStore, envelopeId)?.reservationId);
    if (!routerStore || !reservationId) return refuse("needs-reconciliation", "bound reservation is unavailable");
    const reservation = getReservation(routerStore, reservationId);
    if (!reservation || reservation.envelopeId !== envelopeId || reservation.claimId !== envelopeId ||
        !["claimed", "released"].includes(reservation.state)) return refuse("needs-reconciliation", "reservation does not match the live claim or is already settled differently");
    if (claim && reservation.state !== "claimed") return refuse("needs-reconciliation", "live claim has a settled reservation");
    if (claim) {
      if (typeof verifyMissing !== "function") return refuse("needs-approval", "host settlement verification is unavailable");
      const proof = await verifyMissing({ action, claim });
      if (proof?.verified !== true) return refuse("needs-reconciliation", "claim and reservation remain held pending verified settlement");
    }
    const consumed = consumeEnvelope({ boardPath, envelopeId, reason: SETTLE[action], settleKey: idempotencyKey });
    if (!consumed.ok) return outcome(consumed);
    const released = releaseReservation(routerStore, { reservationId, now: new Date().toISOString() });
    if (!released.ok) return refuse("needs-reconciliation", "board settled; reservation still requires settlement");
    return { ok: true, status: SETTLE[action], envelopeId, reservationId, idempotent: consumed.idempotent === true && released.idempotent === true };
  };
  return Object.freeze({
    "journey.finish": async ({ envelopeId, reason, recheck }) => {
      if (!FINISH.has(reason)) return refuse("invalid-input", "unknown terminal reason");
      const claim = liveClaim(envelopeId);
      if (claim?.ok === false) return claim;
      if (!claim) return outcome(consumeEnvelope({ boardPath, envelopeId, reason, recheck }));
      if (claim.envelope.reservationId) return refuse("needs-reconciliation", "bound reservation requires paired settlement");
      if (typeof verifyJourneyFinish !== "function" || await verifyJourneyFinish({ claim, reason }) !== true) {
        return refuse("needs-approval", "host journey terminal evidence required");
      }
      return outcome(consumeEnvelope({ boardPath, envelopeId, reason, recheck }));
    },
    "journey.start": (params) => journey?.taskStore
      ? runWorkerJourney(params, journey.context, { ...(journey.options ?? {}), taskStore: journey.taskStore }, journey.signal)
      : refuse("needs-approval", "host journey context is unavailable"),
    "board.claim": async ({ cardId = null, role }) => {
      if (typeof routeForClaim !== "function") return refuse("needs-approval", "host route authority unavailable");
      const claimed = claimCard({ boardPath, cardId, role, route: await routeForClaim({ cardId, role }) });
      if (!claimed.ok) return outcome(claimed);
      if (claimed.envelope.reservationId) {
        if (!routerStore) return refuse("needs-reconciliation", "claim held; router store unavailable");
        const bound = reconcileReservationFromClaim(routerStore, { claim: claimed.claim, now: new Date().toISOString() });
        if (!bound.ok) return refuse("needs-reconciliation", `claim held; ${bound.reason}`);
      }
      return claimed;
    },
    "board.complete": async ({ cardId, authority, recheck }) => typeof authorizeCard === "function" && await authorizeCard("complete", cardId, authority) === true
      ? outcome(updateCard({ boardPath, cardId, authority, changes: { done: true, recheck } })) : refuse("needs-approval", "host card authority required"),
    "board.cancel": async ({ cardId, authority }) => typeof authorizeCard === "function" && await authorizeCard("cancel", cardId, authority) === true
      ? outcome(updateCard({ boardPath, cardId, authority, changes: { flags: { add: ["cancelled"] } } })) : refuse("needs-approval", "host card authority required"),
    "board.reopen": async ({ cardId, authority }) => typeof authorizeCard === "function" && await authorizeCard("reopen", cardId, authority) === true
      ? outcome(updateCard({ boardPath, cardId, authority, changes: { done: false, lane: "backlog", flags: { remove: ["cancelled"] } } })) : refuse("needs-approval", "host card authority required"),
    "run.invoke": ({ requestId, goal }) => durable?.transport
      ? runOutcome(durable.driver.invokeWorker({ requestId, goal, transport: durable.transport, signal: durable.signal ?? new AbortController().signal }))
      : refuse("needs-approval", "host worker transport is unavailable"),
    "run.abort": ({ runId }) => durable?.driver ? runOutcome(durable.driver.cancel(runId)) : refuse("needs-reconciliation", "durable driver unavailable"),
    "run.reconcile": async ({ runId, evidence }) => !durable?.driver ? refuse("needs-reconciliation", "durable driver unavailable")
      : evidence?.verified === true && (typeof verifyReceipt !== "function" || await verifyReceipt({ runId, evidence }) !== true)
        ? refuse("needs-reconciliation", "host receipt verification required")
        : runOutcome(durable.driver.reconcile(runId, evidence)),
    "run.record-receipt": async ({ runId, stepId, requestKey, receipt }) => !durable?.driver ? refuse("needs-reconciliation", "durable driver unavailable")
      : typeof verifyReceipt !== "function" || await verifyReceipt({ runId, stepId, requestKey, receipt }) !== true
        ? refuse("needs-reconciliation", "host receipt verification required")
        : runOutcome(durable.driver.report(runId, { stepId, requestKey, receipt })),
    "reservation.verify": async ({ envelopeId }) => {
      const claim = liveClaim(envelopeId);
      if (claim?.ok === false) return claim;
      if (!claim) return refuse("claim-not-found", "claim is not live");
      if (!routerStore || !claim.envelope.reservationId) return refuse("needs-reconciliation", "bound reservation unavailable");
      const row = getReservation(routerStore, claim.envelope.reservationId);
      if (!row || row.envelopeId !== envelopeId || row.state !== "claimed") return refuse("needs-reconciliation", "reservation and claim differ; no automatic repair");
      if (typeof verifySpawn !== "function") return refuse("unverified", "host spawn read-back unavailable; claim and reservation held");
      const observed = await verifySpawn(claim);
      return observed?.verified === true ? { ok: true, status: "verified", envelopeId }
        : refuse("unverified", "spawn not verified; claim and reservation held for retry or reconciliation");
    },
    "reservation.abandon": (input) => paired("abandon", input),
    "reservation.expire": (input) => paired("expire", input),
    "reservation.confirmed-missing": (input) => paired("confirmed-missing", input),
  });
}
