// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// `tasks validate` (rule 30): a read-only setup-time validator in the shape
// of nudge_validate_pi.js and router_validate_pi.js. It loads everything
// exactly as the runtime would, checks it, and exits 0 only when the tasks
// surface is operational — otherwise nonzero with a machine-readable error
// list. It never mutates state, never writes the board, never promotes.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  SESSION_TASKS_SCHEMA,
  resolveTaskListId, tasksMirrorPath, loadSnapshotFile,
  validateSnapshot, validateSessionTask,
  promotionIdempotencyKey, findExistingPromotedCard, resolveCallerOrigin, hasTasksCapability,
  TASKS_CAPABILITY_ENV,
} from "./session_tasks_core_pi.js";
import { validateBoard } from "./task_board_core_pi.js";

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readTasksConfig(repoRoot) {
  const candidates = [
    join(repoRoot, ".agentic-driver", "tasks.json"),
    join(homedir(), ".config", "agentic-driver", "tasks.json"),
  ];
  for (const candidate of candidates) {
    const value = readJsonIfExists(candidate);
    if (value !== null) return { path: candidate, value };
  }
  return { path: null, value: null };
}

/**
 * Validate the tasks surface. Pure observation: no writes, no promotion.
 * Returns { valid, operational, checks, errors, warnings }.
 */
export function validateTasksSetup({
  repoRoot = process.cwd(),
  session = null,
  boardPath = null,
  tasksRoot = null,
  capabilityEnv = process.env,
  resolveOrigin = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const checks = {};
  const root = typeof repoRoot === "string" && repoRoot !== "" ? resolve(repoRoot) : process.cwd();

  // 1. taskListId resolution (the same chain the runtime uses).
  const taskListId = resolveTaskListId({ session });
  checks.taskListId = taskListId ? { ok: true, taskListId } : { ok: false, reason: "no PI_TASK_LIST_ID, CLAUDE_CODE_TASK_LIST_ID, or session id" };
  if (!taskListId) errors.push("taskListId could not be resolved (PI_TASK_LIST_ID, then CLAUDE_CODE_TASK_LIST_ID, then the session id)");

  // 2. Session snapshot shape (picc-tasks mirror file).
  let snapshot = null;
  if (taskListId) {
    const mirrorPath = tasksMirrorPath(taskListId, { tasksRoot });
    checks.snapshot = { ok: true, path: mirrorPath, present: existsSync(mirrorPath) };
    if (existsSync(mirrorPath)) {
      snapshot = loadSnapshotFile(mirrorPath);
      if (snapshot === null) {
        checks.snapshot = { ok: false, path: mirrorPath, present: true, reason: "the snapshot does not satisfy agentic-driver.session-tasks.v1" };
        errors.push(`session snapshot at ${mirrorPath} does not satisfy ${SESSION_TASKS_SCHEMA}`);
      } else {
        const ids = snapshot.tasks.map((task) => task.id);
        if (new Set(ids).size !== ids.length) {
          errors.push("session snapshot has duplicate task ids");
        }
        const hwmMax = snapshot.tasks.reduce((max, task) => {
          const n = Number.parseInt(task.id, 10);
          return Number.isNaN(n) ? max : Math.max(max, n);
        }, 0);
        if (snapshot.highWaterMark < hwmMax) {
          errors.push(`highWaterMark ${snapshot.highWaterMark} is below the largest task id ${hwmMax}`);
        }
        for (const task of snapshot.tasks) {
          if (!validateSessionTask(task)) {
            errors.push(`task ${task.id} is outside the closed session-task shape`);
          }
          if (task.metadata?.origin !== undefined && task.metadata?.origin !== null
            && !["coordinator", "worker", "legacy-unknown"].includes(task.metadata.origin)) {
            errors.push(`task ${task.id} metadata.origin "${task.metadata.origin}" is outside the closed origin values`);
          }
        }
      }
    } else {
      warnings.push(`no session snapshot present at ${mirrorPath} (a fresh session has none; not an error)`);
    }
  }

  // 3. Board availability + validity (TASKS.md first; board.md never).
  let resolvedBoardPath = boardPath;
  if (!resolvedBoardPath) {
    // TASKS.md first; board.md is a derived projection and is never the
    // promotion target. When only a projection exists, the canonical path
    // is reported so the error names the right fix.
    const canonical = join(root, "TASKS.md");
    resolvedBoardPath = existsSync(canonical) ? canonical : canonical;
  }
  if (resolvedBoardPath.endsWith("board.md")) {
    checks.board = { ok: false, path: resolvedBoardPath, reason: "board.md is a projection; it is never the promotion target" };
    errors.push("board.md must never be the promotion target; the canonical TASKS.md is required");
  } else if (existsSync(resolvedBoardPath)) {
    const markdown = readFileSync(resolvedBoardPath, "utf8");
    const validated = validateBoard(markdown);
    checks.board = { ok: validated.ok, path: resolvedBoardPath, cards: validated.cards.length };
    if (!validated.ok) errors.push(...validated.errors.map((e) => `board invalid: ${e}`));
    // 4. Linkage integrity: every promotedCardId on session tasks must
    //    resolve to a card whose importedId points back at the task.
    if (snapshot && taskListId) {
      const brokenLinks = [];
      for (const task of snapshot.tasks) {
        const cardLink = task.metadata?.promotedCardId ?? task.metadata?.promotedcardid;
        if (typeof cardLink !== "string" || cardLink === "") continue;
        const card = validated.cards.find((c) => c.cardId === cardLink);
        if (!card) { brokenLinks.push(`task ${task.id} -> card ${cardLink}: card not found`); continue; }
        const expectedImported = findExistingPromotedCard(markdown, promotionIdempotencyKey(taskListId, task.id));
        if (!expectedImported || expectedImported.cardId !== cardLink) {
          brokenLinks.push(`task ${task.id} -> card ${cardLink}: card importedId does not link back`);
        }
      }
      checks.linkage = { ok: brokenLinks.length === 0, brokenLinks };
      errors.push(...brokenLinks);
    }
  } else {
    checks.board = { ok: false, path: resolvedBoardPath, reason: "no TASKS.md in this workspace" };
    warnings.push("no TASKS.md found for the workspace; promotion is unavailable until a board exists (a write tool call bootstraps one)");
  }
  // 5. Promotion target configuration.
  const config = readTasksConfig(root);
  if (config.value === null) {
    checks.promotionConfig = { ok: true, path: null, defaults: true };
    checks.promotionConfig.defaults = true;
  } else {
    const value = config.value;
    const problems = [];
    if (value.schema !== undefined && value.schema !== "agentic-driver.tasks.v1") {
      problems.push(`schema "${value.schema}" is not recognized`);
    }
    if (value.promotion !== undefined) {
      const p = value.promotion;
      if (p === null || typeof p !== "object" || Array.isArray(p)) {
        problems.push("promotion must be an object");
      } else {
        for (const [key, val] of Object.entries(p)) {
          if (key === "completedTasks" && !["skip", "promote-as-done"].includes(val)) {
            problems.push(`promotion.completedTasks "${val}" must be skip or promote-as-done`);
          }
          if (key === "batchAtSessionEnd" && !["offered", "off"].includes(val)) {
            problems.push(`promotion.batchAtSessionEnd "${val}" must be offered or off`);
          }
        }
      }
    }
    checks.promotionConfig = { ok: problems.length === 0, path: config.path, problems };
    errors.push(...problems.map((p) => `promotion config: ${p}`));
  }

  // 6. Origin provenance + worker capability (observation only).
  const origin = typeof resolveOrigin === "function" ? resolveOrigin() : resolveCallerOrigin();
  checks.origin = { ok: true, origin: origin.origin, proven: origin.proven, reason: origin.reason };
  checks.capability = {
    ok: true,
    loaded: hasTasksCapability({ env: capabilityEnv }),
    marker: TASKS_CAPABILITY_ENV,
  };
  if (!checks.capability.loaded) {
    warnings.push(`tasks skill capability not declared (${TASKS_CAPABILITY_ENV}); session tools still work, worker briefs must set the marker explicitly`);
  }

  const valid = errors.length === 0;
  // Operational means ready end-to-end: valid state AND a resolvable board
  // AND linkage clean. A missing snapshot is tolerated (fresh session).
  const operational = valid
    && Boolean(taskListId)
    && Boolean(checks.board?.ok);
  return { valid, operational, checks, errors, warnings };
}

function formatTasksValidateReport(report) {
  const lines = [];
  lines.push("tasks validate — unified session tasks + promotion (v1)");
  for (const [name, check] of Object.entries(report.checks)) {
    const ok = check.ok ? "ok" : "FAIL";
    const detail = check.reason ?? check.taskListId ?? check.path ?? check.origin ?? "";
    lines.push(`  [${ok}] ${name}${detail ? `: ${detail}` : ""}`);
  }
  for (const warning of report.warnings) lines.push(`  [warn] ${warning}`);
  for (const error of report.errors) lines.push(`  [error] ${error}`);
  lines.push(`result: ${report.operational ? "operational" : "not operational"}`);
  return lines.join("\n");
}

function isEntrypoint() {
  try {
    return pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : null;
  };
  const report = validateTasksSetup({
    repoRoot: take("--repo-root") ?? process.cwd(),
    session: take("--session"),
    boardPath: take("--board"),
    tasksRoot: take("--tasks-root"),
  });
  process.stdout.write(`${formatTasksValidateReport(report)}\n`);
  if (!report.valid || !report.operational) {
    process.stderr.write(`${JSON.stringify({
      valid: report.valid, operational: report.operational,
      errors: report.errors, warnings: report.warnings,
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.exit(0);
}
