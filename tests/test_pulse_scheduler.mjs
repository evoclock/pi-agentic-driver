// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Pulse scheduler tests (PULSE_DESIGN_v3 §15): manual check observation,
// tool registration surface, package/skill discovery, and lifecycle seams.
// Check never claims; run/enable/configure are not yet implemented and fail
// closed with a structured reason.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  writeCard, automationPolicyPath, writerStatePath,
} from "../scripts/enforcement/task_board_core_pi.js";
import { pulseCheck, registerPulseTools, resolveBoardPath } from "../scripts/enforcement/pulse_scheduler_pi.js";

const authority = { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "plan the work" };

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "pulse-scheduler-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function policyFor(boardPath, dir, overrides = {}) {
  return {
    roles: ["implementer", "reviewer"],
    placement: "container",
    maxConcurrent: 5,
    expiry: "2099-01-01",
    board: boardPath,
    riskCeiling: "low",
    acceptedRepositories: [dir],
    ...overrides,
  };
}

function pulsePolicy(overrides = {}) {
  return {
    enabled: true,
    mode: "interactive",
    intervalSeconds: 300,
    fillOnStart: true,
    routing: {
      implementer: {
        preferred: [{ model: "zai/glm-5.3", maxConcurrent: 4 }],
        fallback: [],
        maxConcurrent: 4,
      },
    },
    stallTimeoutSeconds: 600,
    unattendedHostRiskAccepted: false,
    ...overrides,
  };
}

function fixtureBoard(dir, { withPulse = true } = {}) {
  const boardPath = join(dir, "TASKS.md");
  const r1 = writeCard({ boardPath, input: { title: "First", spec: "spec one", definitionOfDone: "done one", stoppingPoint: "tests green", scope: ["src/"], priority: "P0" }, authority });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const policy = policyFor(boardPath, dir, withPulse ? { pulse: pulsePolicy() } : {});
  writeFileSync(automationPolicyPath(boardPath), JSON.stringify(policy));
  return boardPath;
}

function fakeRegistry(models) {
  return {
    get: (id) => models.includes(id) ? { id } : null,
    isAuthenticated: () => true,
  };
}

test("check on a workspace with no board reports board-unavailable and changes nothing", () => {
  const dir = freshDir();
  try {
    const result = pulseCheck({ boardPath: join(dir, "TASKS.md") });
    assert.equal(result.ok, false);
    assert.equal(result.code, "board-unavailable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("check without pulse policy: cards report REVIEW_REQUIRED, nothing proposed", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir, { withPulse: false });
    const result = pulseCheck({ boardPath, observedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(result.ok, true);
    assert.equal(result.scan.proposedDispatches.length, 0);
    assert.equal(result.scan.capacity.length, 0);
    assert.ok(result.scan.cards.every((c) => c.result === "REVIEW_REQUIRED"));
    assert.equal(result.scan.authorityCreated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("check with enabled pulse: ready card maps to route and proposal, no claim made", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir);
    const result = pulseCheck({
      boardPath,
      modelRegistry: fakeRegistry(["zai/glm-5.3"]),
      scopedModels: ["zai/glm-5.3"],
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.scan.cards.map((c) => c.result), ["READY_FOR_NEXT"]);
    assert.equal(result.scan.proposedDispatches.length, 1);
    assert.deepEqual(result.scan.proposedDispatches[0], { title: "First", role: "implementer", model: "zai/glm-5.3", placement: "container" });
    // Pure observation: no claims file, no claim, no board mutation.
    assert.equal(existsSync(join(dir, "TASKS.md.claims.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("check preserves an exact nested provider/model route", () => {
  const dir = freshDir();
  const model = "merge-gateway/zai/glm-5.3-flash";
  try {
    const boardPath = fixtureBoard(dir);
    const policyPath = automationPolicyPath(boardPath);
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    policy.pulse.routing.implementer.preferred[0].model = model;
    writeFileSync(policyPath, JSON.stringify(policy));
    const result = pulseCheck({
      boardPath, modelRegistry: fakeRegistry([model]), scopedModels: [model],
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.scan.proposedDispatches[0].model, model);
    assert.equal(result.scan.capacity[0].model, model);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("check with unauthenticated model: REVIEW_REQUIRED, capacity reports availability", () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir);
    const result = pulseCheck({
      boardPath,
      modelRegistry: fakeRegistry([]),
      scopedModels: [],
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.scan.cards.map((c) => c.result), ["REVIEW_REQUIRED"]);
    const capacity = result.scan.capacity.find((c) => c.model === "zai/glm-5.3");
    assert.equal(capacity.availability, "unknown");
    assert.equal(capacity.free, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveBoardPath prefers canonical TASKS.md and returns null with no cwd", () => {
  const dir = freshDir();
  try {
    assert.equal(resolveBoardPath(dir), join(dir, "TASKS.md"));
    writeFileSync(join(dir, "TASKS.md"), "## backlog\n");
    assert.equal(resolveBoardPath(dir), join(dir, "TASKS.md"));
    assert.equal(resolveBoardPath(""), null);
    assert.equal(resolveBoardPath(null), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool registers agentic_kanban_pulse; unknown action fails closed; check returns scan", async () => {
  const dir = freshDir();
  try {
    const boardPath = fixtureBoard(dir);
    const registered = [];
    const pi = { registerTool: (tool) => registered.push(tool) };
    const { registered: names } = registerPulseTools(pi);
    assert.deepEqual(names, ["agentic_kanban_pulse"]);
    const tool = registered[0];
    assert.equal(tool.name, "agentic_kanban_pulse");

    const unknown = await tool.execute("t1", { action: "run" }, null, null, { cwd: dir });
    const unknownValue = JSON.parse(unknown.content[0].text);
    assert.equal(unknownValue.ok, false);
    assert.equal(unknownValue.code, "instruction-required"); // run without a direct human instruction fails closed

    const check = await tool.execute("t2", { action: "check" }, null, null, { cwd: dir });
    const checkValue = JSON.parse(check.content[0].text);
    assert.equal(checkValue.ok, true);
    assert.equal(checkValue.nonAuthorizing, true);
    assert.equal(checkValue.scan.schema, "agentic-driver.board-pulse.v1");
    // Diagnostic hash only in details, never in public content.
    assert.equal(checkValue.diagnosticHash, undefined);
    assert.ok(typeof check.details.diagnosticHash === "string");

    const emptyDir = mkdtempSync(join(tmpdir(), "pulse-empty-"));
    const noBoard = await tool.execute("t3", { action: "check" }, null, null, { cwd: emptyDir });
    const noBoardValue = JSON.parse(noBoard.content[0].text);
    assert.equal(noBoardValue.ok, false);
    assert.equal(noBoardValue.code, "board-unavailable");
    rmSync(emptyDir, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("package manifest ships pulse extension, core modules, and skill; extension set includes pulse", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const file of [
    "extensions/pulse.ts",
    "scripts/enforcement/pulse_core_pi.js",
    "scripts/enforcement/pulse_scheduler_pi.js",
    "skills/pulse/SKILL.md",
  ]) assert.ok(pkg.files.includes(file), `missing: ${file}`);
  const pulseExtension = await import("../extensions/pulse.ts");
  assert.equal(typeof pulseExtension.default, "function");
  const registered = [];
  await pulseExtension.default({ registerTool: (tool) => registered.push(tool.name) });
  assert.deepEqual(registered, ["agentic_kanban_pulse"]);
  const skill = readFileSync(new URL("../skills/pulse/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.includes("agentic_kanban_pulse"));
  assert.ok(skill.includes("not worker liveness"));
});
