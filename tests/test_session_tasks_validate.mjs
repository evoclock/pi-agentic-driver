// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// `tasks validate` (rule 30) tests: exit codes via the entrypoint, exact-key
// failures, linkage integrity, board-unavailable handling. Read-only: the
// validator must never mutate state.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTasksSetup } from "../scripts/enforcement/session_tasks_validate_pi.js";
import { tasksMirrorPath, persistSnapshot } from "../scripts/enforcement/session_tasks_core_pi.js";
import { writeCard } from "../scripts/enforcement/task_board_core_pi.js";

const ENTRY = new URL("../scripts/enforcement/session_tasks_validate_pi.js", import.meta.url).pathname;

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tasks-validate-"));
  return dir;
}

const AUTH = { source: "instruction", sessionOrReportId: "sess-v", quotedInstruction: "promote task 1" };

function seedPromotedCard(boardPath, { taskListId = "sess-v", taskId = "1", cardId = "T-0001" } = {}) {
  const result = writeCard({
    boardPath,
    input: {
      title: "Task", spec: "spec", definitionOfDone: "dod", stoppingPoint: "stop",
      scope: ["src/"], importedId: null,
    },
    authority: AUTH,
    surface: "tasks",
  });
  return result;
}

test("validate is not operational without a board and exits nonzero", () => {
  const dir = tmpRepo();
  try {
    const report = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot: join(dir, "tasks-root") });
    assert.equal(report.valid, true);
    assert.equal(report.operational, false);
    // Entry point: nonzero exit with machine-readable errors.
    const proc = spawnSync(process.execPath, [ENTRY, "--repo-root", dir, "--session", "sess-v", "--tasks-root", join(dir, "tasks-root")], { encoding: "utf8" });
    assert.equal(proc.status, 1);
    const parsed = JSON.parse(proc.stderr);
    assert.equal(parsed.operational, false);
    assert.ok(Array.isArray(parsed.errors));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate is operational with a valid board and exits 0", () => {
  const dir = tmpRepo();
  try {
    const result = seedPromotedCard(join(dir, "TASKS.md"));
    assert.equal(result.ok, true);
    const proc = spawnSync(process.execPath, [ENTRY, "--repo-root", dir, "--session", "sess-v", "--tasks-root", join(dir, "tasks-root")], { encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /operational/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate rejects a malformed session snapshot with a machine-readable error", () => {
  const dir = tmpRepo();
  try {
    seedPromotedCard(join(dir, "TASKS.md"));
    const tasksRoot = join(dir, "tasks-root");
    const mirror = tasksMirrorPath("sess-v", { tasksRoot });
    mkdirSync(join(mirror, ".."), { recursive: true });
    writeFileSync(mirror, JSON.stringify({ tasks: [{ id: "1", status: "bogus" }], highWaterMark: 1 }), "utf8");
    const report = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot });
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => /closed session-task shape|session-tasks\.v1/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate rejects a high-water mark below the largest task id", () => {
  const dir = tmpRepo();
  try {
    seedPromotedCard(join(dir, "TASKS.md"));
    const tasksRoot = join(dir, "tasks-root");
    persistSnapshot(tasksMirrorPath("sess-v", { tasksRoot }), {
      tasks: [{ id: "5", subject: "s", description: "d", status: "pending", blocks: [], blockedBy: [] }],
      highWaterMark: 2,
    });
    const report = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot });
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => /highWaterMark 2 is below the largest task id 5/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate checks linkage integrity: promotedCardId must resolve both ways", () => {
  const dir = tmpRepo();
  try {
    seedPromotedCard(join(dir, "TASKS.md"));
    const tasksRoot = join(dir, "tasks-root");
    persistSnapshot(tasksMirrorPath("sess-v", { tasksRoot }), {
      tasks: [{ id: "1", subject: "s", description: "d", status: "pending", blocks: [], blockedBy: [], metadata: { promotedCardId: "T-9999" } }],
      highWaterMark: 1,
    });
    const report = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot });
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => /task 1 -> card T-9999: card not found/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate refuses board.md as a promotion target", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "board.md"), "# Board\n\n## backlog\n", "utf8");
    // Explicit targeting of the projection is refused outright.
    const targeted = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot: join(dir, "tasks-root"), boardPath: join(dir, "board.md") });
    assert.equal(targeted.valid, false);
    assert.ok(targeted.errors.some((e) => /board\.md must never be the promotion target/.test(e)));
    // Auto-resolution never selects the projection: only the canonical
    // TASKS.md path is considered, so a projection-only workspace reports
    // board-unavailable, not a projection-backed board.
    const auto = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot: join(dir, "tasks-root") });
    assert.equal(auto.checks.board.path.endsWith("TASKS.md"), true);
    assert.equal(auto.checks.board.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate rejects unknown promotion config keys and bad enum values", () => {
  const dir = tmpRepo();
  try {
    seedPromotedCard(join(dir, "TASKS.md"));
    mkdirSync(join(dir, ".agentic-driver"), { recursive: true });
    writeFileSync(join(dir, ".agentic-driver", "tasks.json"), JSON.stringify({
      schema: "agentic-driver.tasks.v1",
      promotion: { completedTasks: "always", batchAtSessionEnd: "automatic" },
    }), "utf8");
    const report = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot: join(dir, "tasks-root") });
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => /completedTasks "always" must be skip or promote-as-done/.test(e)));
    assert.ok(report.errors.some((e) => /batchAtSessionEnd "automatic" must be offered or off/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate accepts a valid promotion config", () => {
  const dir = tmpRepo();
  try {
    seedPromotedCard(join(dir, "TASKS.md"));
    mkdirSync(join(dir, ".agentic-driver"), { recursive: true });
    writeFileSync(join(dir, ".agentic-driver", "tasks.json"), JSON.stringify({
      schema: "agentic-driver.tasks.v1",
      promotion: { completedTasks: "skip", batchAtSessionEnd: "offered" },
    }), "utf8");
    const report = validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot: join(dir, "tasks-root") });
    assert.equal(report.valid, true);
    assert.equal(report.checks.promotionConfig.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate never mutates state", () => {
  const dir = tmpRepo();
  try {
    seedPromotedCard(join(dir, "TASKS.md"));
    const before = readdirSync(dir).sort().join(",");
    validateTasksSetup({ repoRoot: dir, session: "sess-v", tasksRoot: join(dir, "tasks-root") });
    const after = readdirSync(dir).sort().join(",");
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate reports unproven origin as audit metadata, not an error", () => {
  const dir = tmpRepo();
  try {
    seedPromotedCard(join(dir, "TASKS.md"));
    const report = validateTasksSetup({
      repoRoot: dir, session: "sess-v", tasksRoot: join(dir, "tasks-root"),
      resolveOrigin: () => ({ origin: "legacy-unknown", proven: false, reason: "unproven" }),
    });
    assert.equal(report.checks.origin.origin, "legacy-unknown");
    assert.equal(report.valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
