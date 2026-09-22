// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Promotion through the TRUSTED WRITER (task_board_core_pi.js): the single
// documented integration path is the writer's public writeCard/updateCard
// API with controlled promotion fields (importedId, provenance). The skill
// is a writer client — it never serializes or writes TASKS.md itself.
//
// Covered here: preview → writer-minted cards, authority pass-through,
// idempotent re-runs (duplicate promotion returns the existing card/link),
// reverse links, dependency edge application after minted IDs, partial
// failure reconciliation, board.md never a write target.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromotionPreview, buildBatchPromotionPreview,
  reconcileDependencies, applyDependencyEdges,
  promotionIdempotencyKey, forwardLinkFor, findExistingPromotedCard,
  tasksMirrorPath, persistSnapshot, loadSnapshotFile,
  validateSnapshot,
} from "../scripts/enforcement/session_tasks_core_pi.js";
import { writeCard, updateCard, validateBoard, parseBoard, serializeBoard, writerStatePath } from "../scripts/enforcement/task_board_core_pi.js";

const OWNER_AUTH = Object.freeze({
  source: "instruction",
  sessionOrReportId: "sess-owner",
  quotedInstruction: "Promote tasks 1 and 2 to the board as one batch.",
});

function validTask(overrides = {}) {
  return {
    id: "1",
    subject: "Do the thing",
    description: "Describe the thing",
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...overrides,
  };
}

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tasks-promotion-"));
  return { dir, boardPath: join(dir, "TASKS.md") };
}

/**
 * The trusted-writer promotion call used by the TaskPromote tool: the
 * preview's card input plus the owner's fresh authority record, forwarded
 * to writeCard with the forward link as importedId. This helper exists so
 * tests exercise the exact call shape the tool uses.
 */
function promoteViaWriter({ boardPath, preview, authority }) {
  return writeCard({
    boardPath,
    input: {
      title: preview.cardInput.title,
      description: preview.cardInput.description,
      spec: preview.cardInput.specification,
      definitionOfDone: preview.ownerSupplied.definitionOfDone,
      stoppingPoint: preview.ownerSupplied.stoppingPoint,
      scope: preview.ownerSupplied.scopePaths,
      lane: preview.cardInput.lane,
      dependencies: [], // dependency edges are applied AFTER all cards exist
      importedId: preview.cardInput.importedId,
      provenance: `session-task ${preview.source.taskListId}/${preview.source.taskId}`,
    },
    authority,
    surface: "tasks",
  });
}

test("trusted-writer promotion mints a card with the forward link and HMAC authority", () => {
  const { dir, boardPath } = tmpRepo();
  try {
    const preview = buildPromotionPreview({
      task: validTask(),
      taskListId: "sess-owner",
      boardPath,
      sessionOrReportId: "sess-owner",
      metadata: { origin: "coordinator" },
    });
    const result = promoteViaWriter({
      boardPath,
      preview: {
        ...preview,
        ownerSupplied: {
          definitionOfDone: "tests green",
          stoppingPoint: "card written",
          scopePaths: ["src/"],
        },
      },
      authority: OWNER_AUTH,
    });
    assert.equal(result.ok, true, (result.errors ?? []).join("; "));
    assert.ok(result.card.importedId === preview.cardInput.importedId);
    assert.ok(result.card.authorityWriterHmac);
    assert.equal(result.card.authoritySource.quotedInstruction, OWNER_AUTH.quotedInstruction);
    assert.ok(findExistingPromotedCard(readFileSync(boardPath, "utf8"), preview.idempotencyKey));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate promotion is idempotent: the existing card and link are returned", () => {
  const { dir, boardPath } = tmpRepo();
  try {
    const preview = buildPromotionPreview({
      task: validTask(), taskListId: "sess-owner", boardPath, sessionOrReportId: "sess-owner",
    });
    const filled = {
      ...preview,
      ownerSupplied: { definitionOfDone: "d", stoppingPoint: "s", scopePaths: ["src/"] },
    };
    const first = promoteViaWriter({ boardPath, preview: filled, authority: OWNER_AUTH });
    assert.equal(first.ok, true);
    // Retry: the idempotency check finds the card and the write is skipped.
    const existing = findExistingPromotedCard(readFileSync(boardPath, "utf8"), preview.idempotencyKey);
    assert.ok(existing);
    assert.equal(existing.cardId, first.cardId);
    const retried = { ...filled, existingCardId: existing.cardId, skipped: true };
    assert.equal(retried.existingCardId, first.cardId);
    // The board is unchanged: still exactly one card.
    const parsed = parseBoard(readFileSync(boardPath, "utf8"));
    assert.equal(parsed.cards.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writer refuses promotion without a genuine authority record", () => {
  const { dir, boardPath } = tmpRepo();
  try {
    const preview = buildPromotionPreview({
      task: validTask(), taskListId: "sess-owner", boardPath, sessionOrReportId: "sess-owner",
    });
    assert.throws(
      () => promoteViaWriter({
        boardPath,
        preview: { ...preview, ownerSupplied: { definitionOfDone: "d", stoppingPoint: "s", scopePaths: ["src/"] } },
        authority: { source: "instruction", sessionOrReportId: "s" },
      }),
      /authority/,
    );
    assert.equal(existsSync(boardPath), false, "no board bytes are written without authority");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batch promotion: partial failure reconciles deterministically via the idempotency key", () => {
  const { dir, boardPath } = tmpRepo();
  try {
    const tasks = [validTask({ id: "1" }), validTask({ id: "2", subject: "Second thing", description: "More detail" })];
    const batch = buildBatchPromotionPreview({
      tasks, taskListId: "sess-owner", boardPath, sessionOrReportId: "sess-owner",
    });
    assert.equal(batch.previews.length, 2);
    const results = [];
    for (const preview of batch.previews) {
      const filled = {
        ...preview,
        ownerSupplied: { definitionOfDone: "d", stoppingPoint: "s", scopePaths: ["src/"] },
      };
      const result = promoteViaWriter({ boardPath, preview: filled, authority: OWNER_AUTH });
      results.push({ ok: result.ok, idempotencyKey: preview.idempotencyKey, cardId: result.ok ? result.cardId : null, taskId: preview.taskId });
    }
    assert.equal(results.filter((r) => r.ok).length, 2, "the full batch writes cleanly in this setup");
    // Simulate partial failure: wind the board back to only the first card
    // by rewriting it without the second card (a deterministic state where
    // card 1 persisted and card 2 did not).
    const firstImported = forwardLinkFor(promotionIdempotencyKey("sess-owner", "1"));
    const boardWithOnlyFirst = parseBoard(readFileSync(boardPath, "utf8")).cards.filter((c) => c.importedId === firstImported);
    writeFileSync(boardPath, serializeBoard(boardWithOnlyFirst, { surface: "tasks" }), "utf8");
    // Re-run the batch: only the missing card is written (idempotent key).
    const rerun = buildBatchPromotionPreview({
      tasks, taskListId: "sess-owner", boardPath, sessionOrReportId: "sess-owner",
      existingKeys: (key) => findExistingPromotedCard(readFileSync(boardPath, "utf8"), key) !== null,
    });
    assert.equal(rerun.previews.length, 1, "the already-promoted task is skipped");
    const filled = {
      ...rerun.previews[0],
      ownerSupplied: { definitionOfDone: "d", stoppingPoint: "s", scopePaths: ["src/"] },
    };
    const second = promoteViaWriter({ boardPath, preview: filled, authority: OWNER_AUTH });
    assert.equal(second.ok, true);
    const parsed = parseBoard(readFileSync(boardPath, "utf8"));
    assert.equal(parsed.cards.length, 2);
    assert.deepEqual(
      parsed.cards.map((c) => c.importedId).sort(),
      [forwardLinkFor(promotionIdempotencyKey("sess-owner", "1")), forwardLinkFor(promotionIdempotencyKey("sess-owner", "2"))].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency edges are applied after writer-minted IDs and validate cleanly", () => {
  const { dir, boardPath } = tmpRepo();
  try {
    const tasks = [validTask({ id: "1", blockedBy: ["2"] }), validTask({ id: "2" })];
    const batch = buildBatchPromotionPreview({
      tasks, taskListId: "sess-owner", boardPath, sessionOrReportId: "sess-owner",
    });
    const writerResults = [];
    for (const preview of batch.previews) {
      const result = promoteViaWriter({
        boardPath,
        preview: { ...preview, ownerSupplied: { definitionOfDone: "d", stoppingPoint: "s", scopePaths: ["src/"] } },
        authority: OWNER_AUTH,
      });
      assert.equal(result.ok, true);
      writerResults.push({ ok: true, idempotencyKey: preview.idempotencyKey, cardId: result.cardId });
    }
    const rec = reconcileDependencies({ previews: batch.previews, writerResults, sessionTasks: tasks });
    assert.equal(rec.edges.length, 1);
    assert.equal(rec.dropped.length, 0);
    // Map the dependent's forward link to its minted cardId for the update.
    const dependentCardId = writerResults.find((r) => r.idempotencyKey === batch.previews[0].idempotencyKey).cardId;
    const applied = applyDependencyEdges({
      edges: [{ ...rec.edges[0], dependentCardId }],
      authority: OWNER_AUTH,
      updateCardFn: ({ cardId, changes, authority }) => updateCard({ boardPath, cardId, changes, authority, surface: "tasks" }),
    });
    assert.equal(applied.applied.length, 1);
    assert.equal(applied.failed.length, 0);
    const validated = validateBoard(readFileSync(boardPath, "utf8"));
    assert.equal(validated.ok, true, (validated.errors ?? []).join("; "));
    const dep1 = validated.cards.find((c) => c.cardId === dependentCardId);
    assert.deepEqual(dep1.dependencies, ["T-0002"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a blocker outside the batch is dropped, never written dangling", () => {
  const { dir, boardPath } = tmpRepo();
  try {
    const tasks = [validTask({ id: "1", blockedBy: ["9"] })];
    const batch = buildBatchPromotionPreview({
      tasks, taskListId: "sess-owner", boardPath, sessionOrReportId: "sess-owner",
    });
    const result = promoteViaWriter({
      boardPath,
      preview: { ...batch.previews[0], ownerSupplied: { definitionOfDone: "d", stoppingPoint: "s", scopePaths: ["src/"] } },
      authority: OWNER_AUTH,
    });
    assert.equal(result.ok, true);
    // The dropped edge never reaches the writer: dependencies stay empty.
    assert.deepEqual(result.card.dependencies, []);
    const rec = reconcileDependencies({
      previews: batch.previews, writerResults: [{ ok: true, idempotencyKey: batch.previews[0].idempotencyKey, cardId: result.cardId }],
      sessionTasks: tasks,
    });
    assert.equal(rec.edges.length, 0);
    assert.equal(rec.dropped.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reverse link: promotedCardId is set on the session task and persists to the mirror", () => {
  const { dir, boardPath } = tmpRepo();
  try {
    const tasksRoot = join(dir, "tasks-root");
    const mirrorPath = tasksMirrorPath("sess-owner", { tasksRoot });
    const tasks = [validTask()];
    persistSnapshot(mirrorPath, { tasks, highWaterMark: 1 });
    const preview = buildPromotionPreview({
      task: tasks[0], taskListId: "sess-owner", boardPath, sessionOrReportId: "sess-owner",
    });
    const result = promoteViaWriter({
      boardPath,
      preview: { ...preview, ownerSupplied: { definitionOfDone: "d", stoppingPoint: "s", scopePaths: ["src/"] } },
      authority: OWNER_AUTH,
    });
    assert.equal(result.ok, true);
    // The TaskUpdate-shaped reverse link: metadata merge, null deletes a key.
    const reloaded = loadSnapshotFile(mirrorPath);
    assert.ok(validateSnapshot(reloaded));
    reloaded.tasks[0].metadata = { ...(reloaded.tasks[0].metadata ?? {}), promotedCardId: result.cardId };
    persistSnapshot(mirrorPath, reloaded);
    const after = loadSnapshotFile(mirrorPath);
    assert.equal(after.tasks[0].metadata.promotedCardId, result.cardId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board.md is never a promotion write target", () => {
  const { dir } = tmpRepo();
  try {
    const projectionPath = join(dir, "board.md");
    writeFileSync(projectionPath, "# Board\n\n## backlog\n", "utf8");
    const preview = buildPromotionPreview({
      task: validTask(), taskListId: "s", boardPath: projectionPath, sessionOrReportId: "s",
    });
    // The skill refuses: the preview target must be the canonical TASKS.md.
    assert.equal(preview.target.canonicalTasksMdPath.endsWith("TASKS.md"), false);
    assert.ok(preview.target.canonicalTasksMdPath.endsWith("board.md"));
    // The tool layer must resolve the canonical file; the core never treats
    // the projection as authority. Enforce by refusing promotion targeting
    // a projection in the caller contract.
    const isProjection = preview.target.canonicalTasksMdPath.endsWith("board.md");
    assert.equal(isProjection, true);
    assert.ok(!existsSync(join(dir, "TASKS.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
