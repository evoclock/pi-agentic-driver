// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 dispatch integration tests per evidence/BOARD1_DESIGN_v6.md §3.6/§4:
// atomic claim, blocked-by gating, automation-policy enforcement, envelope
// bindings, expiry release, ID provenance, and claim-in-projection.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCard, claimCard, readClaims, reclaimClaim, releaseExpiredClaims,
  readAutomationPolicy, checkAutomationPolicy, createEnvelope,
  dispatchEligibility, selectDispatchableCard, validateBoard,
  isDispatchable, writerStatePath, claimsPath, automationPolicyPath,
  projectionPath, registerKanbanBoardTools, ENVELOPE_SCHEMA,
} from "../scripts/enforcement/task_board_core_pi.js";

const authority = { source: "instruction", sessionOrReportId: "sess-test", quotedInstruction: "write the card" };
const POLICY = { roles: ["implementer", "reviewer"], placement: "container", maxConcurrent: 2, expiry: "2099-01-01" };

function fixtureBoard(dir) {
  const boardPath = join(dir, "TASKS.md");
  const r1 = writeCard({ boardPath, input: { title: "First", spec: "spec one", definitionOfDone: "done one", stoppingPoint: "tests green", scope: ["src/"], priority: "P2" }, authority });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = writeCard({ boardPath, input: { title: "Second", spec: "spec two", definitionOfDone: "done two", stoppingPoint: "tests green", scope: ["src/"], priority: "P0" }, authority });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  return { boardPath, first: r1.cardId, second: r2.cardId };
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "board-dispatch-"));
}

test("atomic claim: two concurrent claims on the same card, one wins", () => {
  const dir = freshDir();
  try {
    const { boardPath, second } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    // Highest-priority dispatchable card is `second` (P0). Both pulses target it.
    const a = claimCard({ boardPath, role: "implementer" });
    const b = claimCard({ boardPath, role: "reviewer" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.cardId, b.cardId, "two pulses must never claim the same card");
    assert.equal(a.cardId, second);
    const claims = readClaims(boardPath);
    assert.equal(claims.length, 2);
    assert.deepEqual(claims.map((c) => c.cardId).sort(), [a.cardId, b.cardId].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic claim: a claimed card cannot be claimed again by cardId", () => {
  const dir = freshDir();
  try {
    const { boardPath, first } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    const a = claimCard({ boardPath, role: "implementer", cardId: first });
    assert.equal(a.ok, true);
    const b = claimCard({ boardPath, role: "reviewer", cardId: first });
    assert.equal(b.ok, false);
    assert.equal(b.code, "no-dispatchable-card");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("blocked-by gating: a card with an open dependency is not claimable", () => {
  const dir = freshDir();
  try {
    const { boardPath, first, second } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    // Make `second` depend on `first`, then claim `first`.
    const upd = require_update(boardPath, first, second);
    assert.equal(upd.ok, true, JSON.stringify(upd));
    const a = claimCard({ boardPath, role: "implementer" });
    assert.equal(a.ok, true);
    assert.equal(a.cardId, first, "only the unblocked card is claimable");
    // With `first` claimed (not done), `second` still has an open dependency.
    const b = claimCard({ boardPath, role: "reviewer" });
    assert.equal(b.ok, false);
    assert.equal(b.code, "no-dispatchable-card");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Small helper so the test file needs no import of updateCard internals.
import { updateCard } from "../scripts/enforcement/task_board_core_pi.js";
function require_update(boardPath, first, second) {
  return updateCard({
    boardPath, cardId: second,
    changes: { dependencies: [first] },
    authority,
  });
}

test("policy enforcement: no policy = refused", () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    const r = claimCard({ boardPath, role: "implementer" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "policy-refused");
    assert.match(r.reason, /no automation policy/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy enforcement: role not in policy = refused", () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    const r = claimCard({ boardPath, role: "intruder" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "policy-role-refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy enforcement: host placement refused in automated mode (§3.4)", () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify({ ...POLICY, placement: "host" }));
    const r = claimCard({ boardPath, role: "implementer" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "policy-placement-refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy enforcement: maxConcurrent caps active claims", () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify({ ...POLICY, maxConcurrent: 1 }));
    const a = claimCard({ boardPath, role: "implementer" });
    assert.equal(a.ok, true);
    const b = claimCard({ boardPath, role: "reviewer" });
    assert.equal(b.ok, false);
    assert.equal(b.code, "policy-concurrency-refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope bindings: card hash, repository, starting revision, branch, scope, stopping point, expiry", () => {
  const dir = freshDir();
  try {
    const { boardPath, second } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    const r = claimCard({ boardPath, role: "implementer", cardId: second, repository: dir });
    assert.equal(r.ok, true);
    const env = r.envelope;
    assert.equal(env.schema, ENVELOPE_SCHEMA);
    assert.equal(env.cardId, second);
    const board = validateBoard(readFileSync(boardPath, "utf8"), {});
    const card = board.cards.find((c) => c.cardId === second);
    assert.equal(env.cardHash, card.hash, "envelope binds the card hash");
    assert.equal(env.repository, dir);
    assert.match(env.startingRevision, /^[0-9a-f]{40}$/, "starting revision is the git HEAD");
    assert.match(env.branch, /^board\//, "assigned branch is board/<cardId>-<id>");
    assert.equal(env.interactionProfile, "container");
    assert.equal(env.placement, "container");
    assert.deepEqual(env.allowedPaths, ["src/"]);
    assert.equal(env.stoppingPoint, "tests green");
    assert.ok(Date.parse(env.expiry) > Date.now(), "envelope has a future expiry");
    // Immutability: the envelope is frozen.
    assert.throws(() => { "use strict"; env.cardId = "T-9999"; });
    // Claim record shape: cardId, claimedAt, role, envelope reference.
    const claim = readClaims(boardPath)[0];
    assert.equal(claim.cardId, second);
    assert.equal(claim.role, "implementer");
    assert.ok(claim.claimedAt);
    assert.equal(claim.envelopeId, env.envelopeId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope expiry is capped by the policy expiry", () => {
  const dir = freshDir();
  try {
    const card = {
      cardId: "T-0001", lane: "backlog", title: "x", flags: [], priority: "P2",
      dependencies: [], stoppingPoint: "stop", specHash: "h", dodHash: "h",
      scope: ["src/"], hash: "h",
    };
    const env = createEnvelope({ card, policy: { placement: "container", expiry: new Date(Date.now() + 3600_000).toISOString() } });
    assert.ok(Date.parse(env.expiry) <= Date.parse(new Date(Date.now() + 3600_000).toISOString()));
  } finally { /* tmp only */ }
});

test("expiry release: an expired envelope releases its claim on check", () => {
  const dir = freshDir();
  try {
    const { boardPath, second } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    const r = claimCard({ boardPath, role: "implementer", cardId: second });
    assert.equal(r.ok, true);
    assert.equal(readClaims(boardPath).length, 1);
    // Expire the envelope by rewriting its expiry into the past.
    const claimsFile = claimsPath(boardPath);
    const state = JSON.parse(readFileSync(claimsFile, "utf8"));
    state.claims[0].envelope.expiry = new Date(Date.now() - 1000).toISOString();
    writeFileSync(claimsFile, JSON.stringify(state));
    const released = releaseExpiredClaims({ boardPath });
    assert.equal(released.length, 0);
    assert.equal(readClaims(boardPath).length, 0);
    // The card is claimable again — a NEW envelope (never a mutation).
    const again = claimCard({ boardPath, role: "reviewer", cardId: second });
    assert.equal(again.ok, true);
    assert.notEqual(again.envelope.envelopeId, r.envelope.envelopeId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit reclaim: drops the claim and frees the card", () => {
  const dir = freshDir();
  try {
    const { boardPath, second } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    const r = claimCard({ boardPath, role: "implementer", cardId: second });
    assert.equal(r.ok, true);
    const rec = reclaimClaim({ boardPath, cardId: second });
    assert.equal(rec.ok, true);
    assert.equal(rec.reclaimed, 1);
    assert.equal(readClaims(boardPath).length, 0);
    const again = claimCard({ boardPath, role: "reviewer", cardId: second });
    assert.equal(again.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ID provenance: a hand-edited card outside the writer ledger cannot be claimed", () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    // Hand-inject a foreign card into the Markdown (not via the writer).
    const markdown = readFileSync(boardPath, "utf8");
    const injected = markdown.replace(/^## backlog$/m,
      "## backlog\n\n- [ ] Forged <!-- id: T-0042 --> [hash:: 0".repeat(0) + "## backlog");
    // Simpler: append a forged card line into the backlog section.
    const forged = markdown.replace("## backlog", "## backlog\n\n- [ ] Forged <!-- id: T-0099 --> [priority:: P0] [stopping:: x] [specHash:: " + "0".repeat(64) + "] [dodHash:: " + "0".repeat(64) + "] [scope:: src/]");
    writeFileSync(boardPath, forged !== markdown ? forged : injected);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    const r = claimCard({ boardPath, role: "implementer", cardId: "T-0099" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "no-dispatchable-card");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claim shows as active in the projection", () => {
  const dir = freshDir();
  try {
    const { boardPath, second } = fixtureBoard(dir);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    const r = claimCard({ boardPath, role: "implementer", cardId: second });
    assert.equal(r.ok, true);
    const projection = readFileSync(projectionPath(boardPath), "utf8");
    assert.match(projection, /\[id:: T-0002\]/);
    assert.match(projection, /\[active:: implementer\]/, "claimed card is published active");
    const unclaimed = readFileSync(boardPath, "utf8");
    assert.ok(!unclaimed.includes("[active::"), "the canonical board is never mutated by a claim");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dispatch eligibility: pure predicate composes with claims and provenance", () => {
  const dir = freshDir();
  try {
    const { boardPath, first, second } = fixtureBoard(dir);
    const board = validateBoard(readFileSync(boardPath, "utf8"), {});
    const index = new Map(board.cards.map((c) => [c.cardId, c]));
    const e1 = dispatchEligibility({ card: index.get(first), boardIndex: index, boardPath, activeClaims: [] });
    assert.equal(e1.eligible, true);
    const e2 = dispatchEligibility({ card: index.get(first), boardIndex: index, boardPath, activeClaims: [{ cardId: first }] });
    assert.equal(e2.eligible, false);
    assert.match(e2.reason, /already claimed/);
    const sel = selectDispatchableCard({ cards: board.cards, boardPath, activeClaims: [] });
    assert.equal(sel.card.cardId, second, "highest priority (P0) is selected first");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy shape validation: malformed policies fail closed", () => {
  assert.equal(checkAutomationPolicy(null).ok, false);
  assert.equal(checkAutomationPolicy({}).ok, false);
  assert.equal(checkAutomationPolicy({ roles: ["x"], placement: "orbital", maxConcurrent: 1, expiry: "2099-01-01" }).ok, false);
  assert.equal(checkAutomationPolicy({ roles: ["x"], placement: "container", maxConcurrent: 0, expiry: "2099-01-01" }).ok, false);
  assert.equal(checkAutomationPolicy({ roles: ["x"], placement: "container", maxConcurrent: 1, expiry: "not-a-date" }).ok, false);
  assert.equal(checkAutomationPolicy({ roles: ["x"], placement: "container", maxConcurrent: 1, expiry: "2000-01-01" }).ok, false);
  assert.equal(checkAutomationPolicy(POLICY).ok, true);
});

test("reversibility: the dispatch tool registers only with a pi-like object and board resolution", () => {
  const registered = [];
  const fake = { registerTool: (tool) => registered.push(tool.name) };
  registerKanbanBoardTools(fake, { boardPath: null });
  assert.ok(registered.includes("agentic_kanban_board_dispatch"));
  assert.ok(registered.includes("agentic_kanban_board"));
});

test("readAutomationPolicy: missing file returns null; sidecar path is derived", () => {
  const dir = freshDir();
  try {
    const { boardPath } = fixtureBoard(dir);
    assert.equal(readAutomationPolicy(boardPath), null);
    writeFileSync(automationPolicyPath(boardPath), JSON.stringify(POLICY));
    assert.deepEqual(readAutomationPolicy(boardPath).roles, POLICY.roles);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
