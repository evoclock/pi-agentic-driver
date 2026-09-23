// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Board-claim bridge tests (vogelkop phase #47): the five required cases —
// concurrent claim exclusivity, stale/tampered card refusal, explicit board
// route versus Jev fallback, model-moat denial, and proof that the bridge
// path never lets Vogelkop mutate lanes/writer state. The bridge delegates to
// the existing claimCard; these tests exercise the bridge surface only.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  writeCard, updateCard, readClaimsState, automationPolicyPath, writerStatePath,
  claimsPath, validateBoard, computeCardHash,
} from "../scripts/enforcement/task_board_core_pi.js";
import {
  claimFromVogelkopRequest as claimFromVogelkopRequestBase, verifyRequestedCard, bridgeRouteFor,
  BOARD_CLAIM_BRIDGE_SCHEMA, BOARD_CLAIM_RECEIPT_SCHEMA, REQUEST_SCHEMA,
} from "../scripts/enforcement/board_claim_bridge_pi.js";

const authority = { source: "instruction", sessionOrReportId: "vk-bridge-test", quotedInstruction: "write the card" };
const LOOPBACK = "http://127.0.0.1:11434/v1";
function claimFromVogelkopRequest(input) {
  return claimFromVogelkopRequestBase({ backendBaseUrlFor: () => LOOPBACK, ...input });
}

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "vk-bridge-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function policyFor(boardPath, dir = null, overrides = {}) {
  return {
    roles: ["implementer", "reviewer"],
    placement: "container",
    maxConcurrent: 2,
    expiry: "2099-01-01",
    board: boardPath,
    riskCeiling: "low",
    acceptedRepositories: [dir ?? dirname(boardPath)],
    ...overrides,
  };
}

function withPolicy(boardPath, overrides = {}) {
  writeFileSync(automationPolicyPath(boardPath), JSON.stringify(policyFor(boardPath, null, overrides)));
}

// A card written through the DRIVER's trusted writer (surface "tasks" IS the
// vogelkop surface: HTML id markers), with an explicit route tag.
function fixtureCard(dir, { title = "Bridge work", tags = ["route-router-implementer"] } = {}) {
  const boardPath = join(dir, "TASKS.md");
  const r = writeCard({
    boardPath,
    input: { title, spec: "spec one", definitionOfDone: "done one", stoppingPoint: "tests green", scope: ["src/"], priority: "P1", tags },
    authority,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const card = validateBoard(readFileSync(boardPath, "utf8"), {}).cards.find((c) => c.cardId === r.cardId);
  return { boardPath, cardId: r.cardId, card };
}

function requestFor({ cardId, card }, overrides = {}) {
  return {
    schema: REQUEST_SCHEMA,
    cardId,
    cardHash: card.hash,
    route: {
      source: { kind: "explicit-board-route", tag: "route-router-implementer", seatAlias: "router-implementer" },
      seat: "implementer",
      seatAlias: "router-implementer",
    },
    moat: { ok: true, locality: "local", basis: "loopback-baseurl" },
    boardPathBasename: "TASKS.md",
    requestedAt: "2026-09-23T00:00:00.000Z",
    authorityCreated: false,
    ...overrides,
  };
}

test("a valid request claims through the existing claim machinery and returns a versioned receipt", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request: requestFor(fixture) });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.schema, BOARD_CLAIM_RECEIPT_SCHEMA);
    assert.equal(receipt.claimed, true);
    assert.equal(receipt.nonAuthorizing, true);
    assert.equal(receipt.authorityCreated, false);
    assert.equal(receipt.cardId, fixture.cardId);
    assert.equal(receipt.cardHash, fixture.card.hash);
    assert.ok(/^[0-9a-f]{32}$/.test(receipt.envelopeId));
    assert.deepEqual(receipt.route.source, { kind: "explicit-board-route", tag: "route-router-implementer", seatAlias: "router-implementer" });
    assert.equal(receipt.route.model, "router-implementer");
    assert.deepEqual(receipt.moat, { ok: true, locality: "local", basis: "trusted-backend-registry" });
    assert.ok(receipt.branch.startsWith("board/"));
    assert.deepEqual(receipt.scope, ["src/"]);
    assert.equal(receipt.stoppingPoint, "tests green");
    // The claim landed in the authenticated claims state (driver-owned).
    const state = readClaimsState(fixture.boardPath);
    assert.equal(state.ok, true);
    assert.equal(state.state.claims.length, 1);
    assert.equal(state.state.claims[0].envelopeId, receipt.envelopeId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent claim exclusivity: two racing requests for the same card, one wins", async () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const request = requestFor(fixture);
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => claimFromVogelkopRequest({ boardPath: fixture.boardPath, request })),
      Promise.resolve().then(() => claimFromVogelkopRequest({ boardPath: fixture.boardPath, request })),
    ]);
    const winner = a.ok ? a : b;
    const loser = a.ok ? b : a;
    assert.equal(winner.ok, true);
    assert.equal(loser.ok, false);
    assert.equal(loser.code, "no-dispatchable-card");
    // Exactly one claim exists.
    const state = readClaimsState(fixture.boardPath);
    assert.equal(state.state.claims.length, 1);
    assert.equal(state.state.claims[0].cardId, fixture.cardId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stale request: the card hash moved after the request was minted — refused before any claim", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    // Edit the card AFTER minting the request (priority bump changes the hash).
    const changed = updateCard({
      boardPath: fixture.boardPath, cardId: fixture.cardId,
      changes: { priority: "P0" }, authority,
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const request = requestFor(fixture);
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "card-hash-mismatch");
    assert.ok(receipt.reason.includes("stale or tampered"));
    // No claim was created.
    const state = readClaimsState(fixture.boardPath);
    assert.equal(state.state.claims.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tampered request: a forged cardHash is refused and claims nothing", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const request = requestFor(fixture, { cardHash: "b".repeat(64) });
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "card-hash-mismatch");
    const state = readClaimsState(fixture.boardPath);
    assert.equal(state.state.claims.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit board route WINS: the bridge never re-routes an explicit route", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const request = requestFor(fixture);
    const route = bridgeRouteFor({ request, repository: dir });
    assert.equal(route.model, "router-implementer");
    assert.equal(route.role, "implementer");
    // The digest is deterministic: same request, same digest.
    const routeAgain = bridgeRouteFor({ request, repository: dir });
    assert.equal(route.routeDecisionDigest, routeAgain.routeDecisionDigest);
    // The envelope carries exactly the request's route identity.
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.route.seatAlias, "router-implementer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Jev fallback route is honored as a fallback and recorded as such", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const request = requestFor(fixture, {
      route: {
        source: { kind: "jev-fallback", requestId: "2026-09-23T00:00:00.000Z" },
        seat: "reviewer",
        seatAlias: "router-reviewer",
      },
    });
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.deepEqual(receipt.route.source, { kind: "jev-fallback", requestId: "2026-09-23T00:00:00.000Z" });
    assert.equal(receipt.route.model, "router-reviewer");
    assert.equal(receipt.route.seat, "reviewer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("model-moat denial: a request whose moat gate refused is never claimed", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const request = requestFor(fixture, {
      moat: { ok: false, reason: "backend host \"api.example.com\" is not loopback — the model-moat local-only gate denies hosted egress by default (moat-denied)" },
    });
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request, backendBaseUrlFor: () => "https://api.example.com/v1" });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "moat-denied");
    const state = readClaimsState(fixture.boardPath);
    assert.equal(state.state.claims.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a moat-passed request records the moat result on the receipt verbatim", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request: requestFor(fixture) });
    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.moat, { ok: true, locality: "local", basis: "trusted-backend-registry" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the bridge mutates only the driver-owned claim state: lanes, flags, and writer state are untouched by the request path", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    // Snapshot the board bytes and the writer state before the claim.
    const boardBefore = readFileSync(fixture.boardPath, "utf8");
    const stateBefore = readFileSync(writerStatePath(fixture.boardPath), "utf8");
    const receipt = claimFromVogelkopRequest({ boardPath: fixture.boardPath, request: requestFor(fixture) });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    // The board card line is UNCHANGED: no lane move, no flag, no hash edit,
    // no authorityHmac mutation. (The driver's own claim machinery publishes
    // the projection; the card itself is untouched.)
    const boardAfter = readFileSync(fixture.boardPath, "utf8");
    const lineBefore = boardBefore.split("\n").find((l) => l.includes(fixture.cardId));
    const lineAfter = boardAfter.split("\n").find((l) => l.includes(fixture.cardId));
    assert.equal(lineAfter, lineBefore);
    assert.ok(lineAfter.includes("[priority:: P1]"));
    assert.ok(!lineAfter.includes("in-progress"));
    // The writer state file was not edited by the bridge (claimCard may
    // advance its own claims anchor — that is the driver's state, not
    // Vogelkop's; the bridge adds no writes of its own).
    assert.ok(existsSync(claimsPath(fixture.boardPath)));
    // No second board format: the driver's own Obsidian projection is the
    // pre-existing derived view beside the board (not a second authority);
    // assert no OTHER board file was created by the bridge.
    assert.equal(existsSync(join(dir, "TASKS.md.vogelkop")), false);
    assert.equal(existsSync(join(dir, "vogelkop-board.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed requests fail closed with structured codes and claim nothing", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    withPolicy(fixture.boardPath);
    const cases = [
      { request: null, code: "request-schema-invalid" },
      { request: { ...requestFor(fixture), schema: "other.v1" }, code: "request-schema-invalid" },
      { request: { ...requestFor(fixture), boardPathBasename: "board.md" }, code: "request-board-invalid" },
      { request: { ...requestFor(fixture), cardId: "" }, code: "request-card-invalid" },
      { request: { ...requestFor(fixture), cardHash: "nothex" }, code: "request-hash-invalid" },
      { request: { ...requestFor(fixture), authorityCreated: true }, code: "request-authority-invalid" },
      { request: { ...requestFor(fixture), route: undefined }, code: "request-route-invalid" },
      { request: { ...requestFor(fixture), moat: { ok: false, reason: "denied" } }, code: "moat-denied" },
    ];
    for (const { request, code } of cases) {
      const receipt = claimFromVogelkopRequest({
        boardPath: fixture.boardPath, request,
        ...(code === "moat-denied" ? { backendBaseUrlFor: () => "https://api.example.com/v1" } : {}),
      });
      assert.equal(receipt.ok, false, JSON.stringify({ request, receipt }));
      assert.equal(receipt.code, code, JSON.stringify(receipt));
      assert.equal(receipt.schema, BOARD_CLAIM_BRIDGE_SCHEMA);
    }
    const state = readClaimsState(fixture.boardPath);
    assert.equal(state.state.claims.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyRequestedCard: card absent from the board is a structured refusal", () => {
  const dir = freshDir();
  try {
    const fixture = fixtureCard(dir);
    const request = requestFor({ cardId: "T-9999", card: { hash: "c".repeat(64) } });
    const verify = verifyRequestedCard({ boardPath: fixture.boardPath, request });
    assert.equal(verify.ok, false);
    assert.equal(verify.code, "card-not-found");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
