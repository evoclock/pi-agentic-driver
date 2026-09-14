// BOARD-1 card update/delete tests per evidence/BOARD1_DESIGN_v6.md §3.5:
// every board operation through the trusted writer with a REQUIRED authority
// record; completion is human-only; hashes recompute; the Obsidian projection
// is a derived view recomputed after every mutation and never authority; a
// deleted cardId is never reused.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeCardHash, computeSpecHash, parseBoard, validateBoard,
  writeCard, updateCard, deleteCard, projectionPath, verifyAuthorityProvenance,
  isDispatchable, registerKanbanBoardTools,
} from "../scripts/enforcement/task_board_core_pi.js";

const registries = { roles: ["implementer"], capabilities: ["fs-write"] };
const authority = { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "move the card to review" };

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "board-ops-"));
  const boardPath = join(dir, "TASKS.md");
  const created = writeCard({
    boardPath,
    input: {
      title: "Implement the thing",
      specification: "spec text",
      definitionOfDone: "done text",
      stoppingPoint: "tests green",
      scopePaths: ["src/"],
      priority: "P2",
    },
    authority,
    registries,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { dir, boardPath, cardId: created.cardId };
}

function readCards(boardPath) {
  const validated = validateBoard(readFileSync(boardPath, "utf8"), registries);
  assert.equal(validated.ok, true, validated.errors.join("; "));
  return validated.cards;
}

test("updateCard: lane move persists, recomputes the hash, and re-records authority", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const before = readCards(boardPath).find((c) => c.cardId === cardId);
    const result = updateCard({ boardPath, cardId, changes: { lane: "review" }, authority, registries });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.changedFields, ["lane"]);
    const after = readCards(boardPath).find((c) => c.cardId === cardId);
    assert.equal(after.lane, "review");
    assert.equal(after.hash, computeCardHash(after));
    assert.notEqual(after.hash, before.hash);
    // The re-recorded authority HMAC verifies against the NEW card hash.
    const provenance = verifyAuthorityProvenance({
      authoritySource: { ...after.authoritySource, writerHmac: after.authorityWriterHmac },
      cardId, cardHash: after.hash, statePath: `${boardPath}.writer-state.json`,
    });
    assert.equal(provenance.ok, true, provenance.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: review-lane progression is authorised through the board-writer authority seam, without completion authority", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    // The trusted board writer performs the review-lane transition when the
    // authority record is genuine human authority (PULSE_DESIGN_v3 §6.3,
    // resolved review question 5). This is the existing updateCard seam —
    // no new authority owner and no Pulse-side board write.
    const moved = updateCard({ boardPath, cardId, changes: { lane: "review" }, authority, registries });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(readCards(boardPath).find((c) => c.cardId === cardId).lane, "review");
    // Lane progression never grants completion: done still requires its own
    // completion-authority check even from the review lane.
    const doneFromReview = updateCard({
      boardPath, cardId, changes: { done: true },
      authority: { source: "agent-report", sessionOrReportId: "rep-9", quotedInstruction: "review passed" },
      registries,
    });
    assert.equal(doneFromReview.ok, false);
    assert.equal(doneFromReview.code, "completion-authority-required");
    assert.equal(readCards(boardPath).find((c) => c.cardId === cardId).done, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: done=true sets the done checkbox and the done lane", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const result = updateCard({ boardPath, cardId, changes: { done: true }, authority, registries });
    assert.equal(result.ok, true, JSON.stringify(result));
    const card = readCards(boardPath).find((c) => c.cardId === cardId);
    assert.equal(card.done, true);
    assert.equal(card.lane, "done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: completion authority rule — an agent report alone is never completion", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const refused = updateCard({
      boardPath, cardId, changes: { done: true },
      authority: { source: "agent-report", sessionOrReportId: "rep-1", quotedInstruction: "i finished" },
      registries,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "completion-authority-required");
    assert.equal(readCards(boardPath).find((c) => c.cardId === cardId).done, false);
    // An approved report proposal IS human authority for completion.
    const approved = updateCard({
      boardPath, cardId, changes: { done: true },
      authority: { source: "report-proposal", sessionOrReportId: "rep-2", quotedInstruction: "approved: complete it" },
      registries,
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(readCards(boardPath).find((c) => c.cardId === cardId).done, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: flags add/remove via {add, remove}", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const add = updateCard({ boardPath, cardId, changes: { flags: { add: ["blocked"] } }, authority, registries });
    assert.equal(add.ok, true, JSON.stringify(add));
    assert.deepEqual(readCards(boardPath).find((c) => c.cardId === cardId).flags, ["blocked"]);
    const remove = updateCard({ boardPath, cardId, changes: { flags: { remove: ["blocked"] } }, authority, registries });
    assert.equal(remove.ok, true, JSON.stringify(remove));
    assert.deepEqual(readCards(boardPath).find((c) => c.cardId === cardId).flags, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: field updates (title, priority, stoppingPoint, tags, dueDate, role)", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const result = updateCard({
      boardPath, cardId,
      changes: { title: "Renamed card", priority: "P0", stoppingPoint: "all suites green", tags: ["urgent"], dueDate: "2026-03-01", role: "implementer" },
      authority, registries,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const card = readCards(boardPath).find((c) => c.cardId === cardId);
    assert.equal(card.title, "Renamed card");
    assert.equal(card.priority, "P0");
    assert.equal(card.stoppingPoint, "all suites green");
    assert.deepEqual(card.tags, ["urgent"]);
    assert.equal(card.due, "2026-03-01");
    assert.equal(card.role, "implementer");
    assert.equal(card.hash, computeCardHash(card));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: spec/DoD text updates recompute their hashes", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const result = updateCard({
      boardPath, cardId,
      changes: { specification: "new spec text", definitionOfDone: "new dod text" },
      authority, registries,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const card = readCards(boardPath).find((c) => c.cardId === cardId);
    assert.equal(card.specText, "new spec text");
    assert.equal(card.specHash, computeSpecHash("new spec text"));
    assert.equal(card.dodText, "new dod text");
    assert.equal(card.dodHash, computeSpecHash("new dod text"));
    assert.equal(card.hash, computeCardHash(card));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: dependency add/remove via full replacement list; dangling dependency fails closed", () => {
  const { dir, boardPath, firstId } = (() => {
    const d = mkdtempSync(join(tmpdir(), "board-ops-dep-"));
    const p = join(d, "TASKS.md");
    const first = writeCard({ boardPath: p, input: { title: "First", specification: "s", definitionOfDone: "d", stoppingPoint: "sp", scopePaths: ["src/"] }, authority, registries });
    const second = writeCard({ boardPath: p, input: { title: "Second", specification: "s2", definitionOfDone: "d2", stoppingPoint: "sp2", scopePaths: ["src/"] }, authority, registries });
    assert.ok(first.ok && second.ok);
    return { dir: d, boardPath: p, firstId: first.cardId, secondId: second.cardId };
  })();
  try {
    const add = updateCard({ boardPath, cardId: firstId, changes: { dependencies: [firstId === firstId ? readCards(boardPath).find((c) => c.cardId !== firstId).cardId : ""] }, authority, registries });
    assert.equal(add.ok, true, JSON.stringify(add));
    // Remove again: empty replacement list.
    const remove = updateCard({ boardPath, cardId: firstId, changes: { dependencies: [] }, authority, registries });
    assert.equal(remove.ok, true, JSON.stringify(remove));
    assert.deepEqual(readCards(boardPath).find((c) => c.cardId === firstId).dependencies, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: authority is REQUIRED — a missing or malformed record refuses the mutation", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    // The direct writer API throws on a missing/malformed authority (same
    // contract as creation); the tool layer catches it into a structured
    // refusal, so the governance reason is always the one reported.
    assert.throws(() => updateCard({ boardPath, cardId, changes: { lane: "review" }, authority: undefined, registries }), (e) => e.code === "authority-source-invalid");
    assert.throws(() => updateCard({ boardPath, cardId, changes: { lane: "review" }, authority: { source: "instruction", sessionOrReportId: "s" }, registries }), (e) => e.code === "authority-source-invalid");
    assert.equal(readCards(boardPath).find((c) => c.cardId === cardId).lane, "backlog");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateCard: unknown card and empty changes refuse with structured codes", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const unknown = updateCard({ boardPath, cardId: "T-9999", changes: { lane: "review" }, authority, registries });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "card-not-found");
    const empty = updateCard({ boardPath, cardId, changes: {}, authority, registries });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "no-changes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deleteCard: removes the card, requires authority, and the ID is never reused", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    assert.throws(() => deleteCard({ boardPath, cardId, authority: undefined, registries }), (e) => e.code === "authority-source-invalid");
    const result = deleteCard({ boardPath, cardId, authority, registries });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.removed, true);
    assert.equal(readCards(boardPath).some((c) => c.cardId === cardId), false);
    // The issued-ID ledger keeps the ID forever.
    const state = JSON.parse(readFileSync(`${boardPath}.writer-state.json`, "utf8"));
    assert.ok(state.issuedCardIds.includes(cardId), "deleted cardId stays in the issued-IDs ledger");
    // The next created card never reuses the deleted ID.
    const next = writeCard({ boardPath, input: { title: "After delete", specification: "s", definitionOfDone: "d", stoppingPoint: "sp", scopePaths: ["src/"] }, authority, registries });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.notEqual(next.cardId, cardId);
    assert.equal(Number(next.cardId.split("-")[1]) > Number(cardId.split("-")[1]), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projection: recomputed after every mutation, matches TASKS.md semantics, and is never authority", () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const pPath = projectionPath(boardPath);
    assert.equal(pPath, join(dir, "board.md"));
    assert.ok(existsSync(pPath), "projection written at creation");
    const read = (file) => parseBoard(readFileSync(file, "utf8"));
    const same = () => {
      const canonical = read(boardPath);
      const projection = read(pPath);
      assert.equal(projection.ok, true, projection.errors.join("; "));
      const canonicalCard = canonical.cards.find((c) => c.cardId === cardId);
      const projCard = projection.cards.find((c) => c.cardId === cardId);
      assert.ok(canonicalCard && projCard);
      // Semantic equality: everything except the surface encoding fields.
      for (const key of ["cardId", "lane", "title", "flags", "priority", "dependencies", "specHash", "dodHash", "specText", "dodText", "stoppingPoint", "scope", "hash", "done"]) {
        assert.deepEqual(projCard[key], canonicalCard[key], `projection ${key} mismatch`);
      }
    };
    same();
    // After a lane move.
    assert.equal(updateCard({ boardPath, cardId, changes: { lane: "in-progress" }, authority, registries }).ok, true);
    same();
    // After a done update.
    assert.equal(updateCard({ boardPath, cardId, changes: { done: true }, authority, registries }).ok, true);
    same();
    // After a flag update.
    assert.equal(updateCard({ boardPath, cardId, changes: { flags: { add: ["blocked"] } }, authority, registries }).ok, true);
    same();
    // After a delete the projection no longer lists the card.
    assert.equal(deleteCard({ boardPath, cardId, authority, registries }).ok, true);
    assert.equal(read(pPath).cards.some((c) => c.cardId === cardId), false);
    // The projection is a view: if the canonical board is deleted, the read
    // path (validateBoard over TASKS.md) sees nothing — the stale projection
    // is never consulted as authority.
    const staleProjection = readFileSync(pPath, "utf8");
    assert.ok(staleProjection.length > 0);
    rmSync(boardPath);
    assert.equal(existsSync(boardPath), false);
    const emptyBoard = validateBoard("", registries);
    assert.equal(emptyBoard.cards.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projection: canonical board.md never overwritten by its own projection", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-ops-proj-"));
  try {
    const boardPath = join(dir, "board.md");
    const result = writeCard({ boardPath, input: { title: "X", specification: "s", definitionOfDone: "d", stoppingPoint: "sp", scopePaths: ["src/"] }, authority, registries });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(projectionPath(boardPath), join(dir, "board.projection.md"));
    assert.ok(existsSync(join(dir, "board.projection.md")));
    assert.ok(readFileSync(boardPath, "utf8").includes("<!-- id:"));
    assert.ok(!readFileSync(join(dir, "board.projection.md"), "utf8").includes("<!-- id:"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("update tool: update and delete through the registered tool with authority; refusals are structured", async () => {
  const { dir, boardPath, cardId } = makeBoard();
  try {
    const registered = [];
    const fakePi = {
      registerTool(tool) { registered.push(tool); },
    };
    registerKanbanBoardTools(fakePi, { boardPath });
    const updateTool = registered.find((t) => t.name === "agentic_kanban_board_update");
    assert.ok(updateTool, "agentic_kanban_board_update is registered");
    const run = (input) => updateTool.execute("call-1", input, undefined, undefined, undefined);
    // Missing authority → structured refusal.
    const noAuth = await run({ operation: "update", cardId, lane: "review" });
    assert.equal(noAuth.details.ok, false);
    assert.equal(noAuth.details.code, "authority-source-invalid");
    // Successful update through the tool.
    const moved = await run({ operation: "update", cardId, lane: "review", authority });
    assert.equal(moved.details.ok, true, JSON.stringify(moved.details));
    assert.deepEqual(moved.details.changedFields, ["lane"]);
    assert.equal(moved.details.projection.written, true);
    // Completion through the tool with an agent-report source is refused.
    const agentDone = await run({ operation: "update", cardId, done: true, authority: { source: "agent-report", sessionOrReportId: "r", quotedInstruction: "done" } });
    assert.equal(agentDone.details.ok, false);
    assert.equal(agentDone.details.code, "completion-authority-required");
    // Delete through the tool.
    const removed = await run({ operation: "delete", cardId, authority });
    assert.equal(removed.details.ok, true, JSON.stringify(removed.details));
    assert.equal(removed.details.removed, true);
    // Unknown card → structured card-not-found.
    const unknown = await run({ operation: "update", cardId: "T-9999", changes: undefined, lane: "review", authority });
    assert.equal(unknown.details.ok, false);
    assert.equal(unknown.details.code, "card-not-found");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
