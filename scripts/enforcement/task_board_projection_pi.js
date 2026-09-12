// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Read-only task board projection. Derives task cards (id, subject, status,
// blockedBy, owner) from the existing task sequence that
// agentic_worker_dispatch consumes. Governance boundary: the board is a
// projection, never an authority store. Agents read it and act within card
// states; they never own admission, completion, reconciliation, or migration.
// There is no write path from the agent to the board: this module exports no
// mutation function, the registered tool accepts no parameters, and every
// returned structure is frozen.

export const TASK_BOARD_TOOL = "agentic_task_board";
export const TASK_BOARD_SCHEMA = "agentic-driver.task-board.v1";
export const TASK_BOARD_CARD_FIELDS = Object.freeze(["id", "subject", "status", "blockedBy", "owner"]);

const REGISTRATIONS = new WeakSet();

function boardResult(details) {
  return { schema: TASK_BOARD_SCHEMA, nonAuthorizing: true, persisted: false, ...details };
}

function normalizeCard(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  const id = typeof task.id === "string" && task.id.trim() !== "" ? task.id : null;
  if (id === null) return null;
  const status = typeof task.status === "string" && task.status.trim() !== "" ? task.status : "pending";
  const blockedBy = Array.isArray(task.blockedBy)
    ? Object.freeze(task.blockedBy.filter((entry) => typeof entry === "string" && entry.trim() !== ""))
    : Object.freeze([]);
  const owner = typeof task.owner === "string" && task.owner.trim() !== "" ? task.owner : null;
  const subject = typeof task.subject === "string" ? task.subject : "";
  return Object.freeze({ id, subject, status, blockedBy, owner });
}

// Derive the board projection from a read-only task store. The store is only
// ever read through list(); nothing here mutates it, and a store that returns
// a malformed list fails closed with an observed error instead of guessing.
export function deriveTaskBoard(taskStore) {
  if (!taskStore || typeof taskStore.list !== "function") {
    throw Object.assign(new Error("a read-only task store is required to derive the board"), {
      code: "task-store-invalid",
      status: "denied",
    });
  }
  let tasks;
  try {
    tasks = taskStore.list();
  } catch (error) {
    throw Object.assign(new Error(`the task store could not be read: ${String(error?.message || error).slice(0, 256)}`), {
      code: "task-store-unreadable",
      status: "blocked",
    });
  }
  if (!Array.isArray(tasks)) {
    throw Object.assign(new Error("the task store did not return a task list"), {
      code: "task-store-invalid",
      status: "denied",
    });
  }
  const cards = [];
  for (const task of tasks) {
    const card = normalizeCard(task);
    if (card) cards.push(card);
  }
  return Object.freeze({
    ...boardResult({ ok: true, action: "read" }),
    cards: Object.freeze(cards),
    cardCount: cards.length,
    derivedAt: new Date().toISOString(),
  });
}

export function registerTaskBoardInterface(pi) {
  if (typeof pi?.registerTool !== "function" || REGISTRATIONS.has(pi)) return;
  REGISTRATIONS.add(pi);
  pi.registerTool({
    name: TASK_BOARD_TOOL,
    label: "Task Board Projection",
    description: "Read-only projection of task cards (id, subject, status, blockedBy, owner) derived from the existing task sequence. The board is a projection, never an authority store: agents read it and act within card states; there is no write path from the agent to the board.",
    promptSnippet: "Use agentic_task_board to read the task board projection; it is read-only and grants no authority over admission, completion, reconciliation, or migration.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      const taskStore = this?.taskStore ?? globalThis.__agenticDriverTaskStore ?? null;
      let value;
      try {
        value = deriveTaskBoard(taskStore);
      } catch (error) {
        value = boardResult({
          ok: false,
          action: "read",
          status: error?.status || "blocked",
          code: error?.code || "board-derivation-failed",
          error: String(error?.message || error).slice(0, 512),
          cards: Object.freeze([]),
          cardCount: 0,
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        details: value,
      };
    },
  });
}

export default registerTaskBoardInterface;
