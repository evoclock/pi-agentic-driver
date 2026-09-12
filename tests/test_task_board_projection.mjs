// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTaskBoard,
  registerTaskBoardInterface,
  TASK_BOARD_SCHEMA,
  TASK_BOARD_TOOL,
  TASK_BOARD_CARD_FIELDS,
} from "../scripts/enforcement/task_board_projection_pi.js";
import taskBoardExtension from "../extensions/task-board.ts";

function store(tasks) {
  const state = tasks.map((task) => ({ ...task }));
  const calls = [];
  return {
    calls,
    list: () => { calls.push("list"); return state.map((task) => ({ ...task })); },
  };
}

test("projection derives cards from the task sequence", () => {
  const board = deriveTaskBoard(store([
    { id: "1", subject: "first task", status: "pending", blockedBy: [], owner: "" },
    { id: "2", subject: "second task", status: "in_progress", blockedBy: ["1"], owner: "implementer" },
  ]));
  assert.equal(board.ok, true);
  assert.equal(board.schema, TASK_BOARD_SCHEMA);
  assert.equal(board.cardCount, 2);
  assert.deepEqual(board.cards.map((card) => card.id), ["1", "2"]);
  assert.equal(board.nonAuthorizing, true);
  assert.equal(board.persisted, false);
});

test("cards expose exactly the projected fields", () => {
  const board = deriveTaskBoard(store([
    { id: "1", subject: "s", status: "pending", blockedBy: [], owner: null, extra: "dropped" },
  ]));
  const card = board.cards[0];
  assert.deepEqual(Object.keys(card).sort(), [...TASK_BOARD_CARD_FIELDS].sort());
  assert.equal(card.subject, "s");
  assert.equal(card.status, "pending");
  assert.equal(card.owner, null);
  assert.equal("extra" in card, false);
});

test("blockedBy is normalized and missing fields get defaults", () => {
  const board = deriveTaskBoard(store([
    { id: "a", blockedBy: ["b", 42, "", null, "c"] },
    { id: "b" },
  ]));
  assert.deepEqual(board.cards[0].blockedBy, ["b", "c"]);
  assert.equal(board.cards[0].status, "pending");
  assert.equal(board.cards[0].subject, "");
  assert.equal(board.cards[1].blockedBy.length, 0);
});

test("malformed entries are skipped, not guessed", () => {
  const board = deriveTaskBoard(store([
    null,
    42,
    { subject: "no id" },
    { id: "ok", status: "pending" },
  ]));
  assert.equal(board.cardCount, 1);
  assert.equal(board.cards[0].id, "ok");
});

test("empty task store yields an empty board", () => {
  const board = deriveTaskBoard(store([]));
  assert.equal(board.ok, true);
  assert.equal(board.cardCount, 0);
  assert.deepEqual(board.cards, []);
});

test("missing or malformed task store fails closed without mutating anything", () => {
  assert.throws(() => deriveTaskBoard(null), /read-only task store/);
  assert.throws(() => deriveTaskBoard({}), /read-only task store/);
  assert.throws(
    () => deriveTaskBoard({ list: () => "not-a-list" }),
    /did not return a task list/,
  );
  const failing = { list: () => { throw new Error("io failure"); } };
  assert.throws(() => deriveTaskBoard(failing), /could not be read/);
});

test("the board never mutates the task store: no write path", () => {
  const calls = [];
  const watched = {
    list: () => { calls.push("list"); return [{ id: "1", status: "pending" }]; },
    create: () => { calls.push("create"); },
    update: () => { calls.push("update"); },
    delete: () => { calls.push("delete"); },
    markDone: () => { calls.push("markDone"); },
  };
  deriveTaskBoard(watched);
  assert.deepEqual(calls, ["list"]);
  const board = deriveTaskBoard(store([{ id: "1" }]));
  assert.equal(Object.isFrozen(board), true);
  assert.equal(Object.isFrozen(board.cards), true);
  assert.equal(Object.isFrozen(board.cards[0]), true);
  assert.equal(Object.isFrozen(board.cards[0].blockedBy), true);
});

test("registered tool is read-only: no parameters, no write action", async () => {
  const registered = [];
  const pi = { registerTool: (tool) => registered.push(tool) };
  await taskBoardExtension({ registerTool: (tool) => registered.push(tool) });
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, TASK_BOARD_TOOL);
  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(/write|create|update|mutate/i.test(JSON.stringify(tool.parameters)), false);

  const result = await tool.execute.call({ taskStore: store([{ id: "1", subject: "x", status: "pending" }]) });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.cardCount, 1);
  assert.equal(result.details.nonAuthorizing, true);

  const failed = await tool.execute.call({ taskStore: null });
  assert.equal(failed.details.ok, false);
  assert.equal(failed.details.cardCount, 0);
  assert.equal(failed.details.nonAuthorizing, true);
});
