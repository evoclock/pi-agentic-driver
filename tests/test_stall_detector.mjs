import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStallNudge,
  createStallDetector,
  DEFAULT_STALL_CONFIG,
  STALL_REASONS,
  validateStallConfig,
} from "../scripts/enforcement/stall_detector_pi.js";

const toolCall = (toolName, input) => ({ toolName, input });
const assistant = (text, overrides = {}) => ({
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text }],
  ...overrides,
});

test("stall config is closed, bounded, and defaults to one enabled detector", () => {
  assert.deepEqual(validateStallConfig(DEFAULT_STALL_CONFIG), {
    ok: true,
    config: { enabled: true, idleTimeoutMs: 120_000, repeatedToolCalls: 3 },
    errors: [],
  });
  assert.equal(validateStallConfig({ ...DEFAULT_STALL_CONFIG, extra: true }).ok, false);
  assert.equal(validateStallConfig({ ...DEFAULT_STALL_CONFIG, enabled: "yes" }).ok, false);
  assert.equal(validateStallConfig({ ...DEFAULT_STALL_CONFIG, idleTimeoutMs: 0 }).ok, false);
  assert.equal(validateStallConfig({ ...DEFAULT_STALL_CONFIG, repeatedToolCalls: 1 }).ok, false);
});

test("idle timeout measures time since the latest progress", () => {
  let clock = 100;
  const detector = createStallDetector({ ...DEFAULT_STALL_CONFIG, idleTimeoutMs: 10 }, () => clock);
  assert.equal(detector.beginRun(), true);
  clock = 105;
  detector.observeProgress();
  clock = 114;
  assert.equal(detector.checkIdle(), null);
  clock = 115;
  assert.equal(detector.checkIdle(), "idle-timeout");
  assert.equal(detector.endRun(), "idle-timeout");
  assert.equal(detector.isRunning(), false);
});

test("repeated identical tool calls are detected by stable input, and a different call clears the signal", () => {
  const detector = createStallDetector(DEFAULT_STALL_CONFIG, () => 100);
  detector.beginRun();
  assert.equal(detector.observeToolCall(toolCall("read", { path: "src/a.js", options: { a: 1, b: 2 } })), null);
  assert.equal(detector.observeToolCall(toolCall("read", { options: { b: 2, a: 1 }, path: "src/a.js" })), null);
  assert.equal(detector.observeToolCall(toolCall("read", { path: "src/a.js", options: { a: 1, b: 2 } })), "repeated-tool-loop");
  assert.equal(detector.observeToolCall(toolCall("read", { path: "src/b.js" })), null);
  assert.equal(detector.observeToolCall(toolCall("read", { path: "src/b.js" })), null);
  assert.equal(detector.observeToolCall(toolCall("read", { path: "src/b.js" })), "repeated-tool-loop");
});

test("only a final explicit BLOCKED report triggers the blocked-brief signal", () => {
  const detector = createStallDetector(DEFAULT_STALL_CONFIG, () => 100);
  detector.beginRun();
  assert.equal(detector.observeAssistantMessage(assistant("[BLOCKED: permission needed]", { stopReason: "toolUse" })), null);
  assert.equal(detector.observeAssistantMessage(assistant("[BLOCKED: permission needed]", {
    content: [{ type: "text", text: "[BLOCKED: permission needed]" }, { type: "toolCall", name: "read" }],
  })), null);
  assert.equal(detector.observeAssistantMessage(assistant("BLOCKED: waiting for approval")), "blocked-brief");
  assert.equal(detector.observeAssistantMessage(assistant("The task is complete.")), null);
  assert.equal(detector.observeAssistantMessage(assistant("[BLOCKED]")), "blocked-brief");
});

test("each supported reason has one bounded, concrete chase prompt", () => {
  assert.deepEqual(STALL_REASONS, ["idle-timeout", "repeated-tool-loop", "blocked-brief"]);
  assert.match(buildStallNudge("idle-timeout"), /last confirmed step/);
  assert.match(buildStallNudge("repeated-tool-loop"), /one different next step/);
  assert.match(buildStallNudge("blocked-brief"), /exact blocker and stop/);
  assert.throws(() => buildStallNudge("other"), /Unknown stall reason/);
});

test("disabled stall detection observes no run or tool signals", () => {
  const detector = createStallDetector({ ...DEFAULT_STALL_CONFIG, enabled: false }, () => 100);
  assert.equal(detector.beginRun(), false);
  assert.equal(detector.observeToolCall(toolCall("read", { path: "a" })), null);
  assert.equal(detector.checkIdle(), null);
  assert.equal(detector.endRun(), null);
});
