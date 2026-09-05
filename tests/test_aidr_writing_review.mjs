import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractAssistantText,
  registerAidrInterface,
  reviewText,
} from "../scripts/aidr_writing_review.js";

test("AI;DR applies the four principles and suggests bullets", () => {
  const report = reviewText(
    "In order to make this clear, it is important to note that the first item is removed from the queue. First, inspect it. Second, remove it. Third, continue.",
    { mode: "analogy", source: "text" },
  );
  assert.equal(report.schema, "agentic-driver.aidr.v1");
  assert.equal(report.status, "needs_revision");
  assert.equal(report.metrics.bulletOpportunity, true);
  assert.equal(report.principles.humanity.status, "manual");
  assert.match(report.analogyExample, /bag of bread/);
  assert.match(report.findings.map((item) => item.kind).join(","), /clutter/);
});

test("AI;DR ignores frontmatter and fenced code while reviewing prose", () => {
  const report = reviewText(`---\ntitle: Example\n---\n\nA short paragraph.\n\n\`\`\`js\nconst value = ${"x".repeat(300)};\n\`\`\``, { source: "text" });
  assert.equal(report.metrics.wordCount, 3);
  assert.equal(report.metrics.longSentenceCount, 0);
});

test("AI;DR extracts assistant text only", () => {
  assert.equal(
    extractAssistantText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "First." },
        { type: "toolCall", name: "read" },
        { type: "text", text: "Second." },
      ],
    }),
    "First.\nSecond.",
  );
  assert.equal(extractAssistantText({ role: "user", content: [{ type: "text", text: "No" }] }), "");
});

test("AI;DR registers a closed read-only tool and captures last response", async () => {
  const registrations = [];
  const handlers = {};
  registerAidrInterface({
    registerTool(tool) { registrations.push(tool); },
    on(event, handler) { handlers[event] = handler; },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "agentic_aidr");
  assert.equal(registrations[0].parameters.additionalProperties, false);
  await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "A response to review." }] } });
  const result = await registrations[0].execute("id", { source: "last-response", mode: "review" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.source, "last-response");
  assert.equal(result.details.authorityCreated, false);
});

test("AI;DR reviews a README without writing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aidr-"));
  const path = join(root, "README.md");
  const original = "# Example\n\nIn order to explain this, it is important to note that the prose is too long.\n";
  await writeFile(path, original);
  const registrations = [];
  registerAidrInterface({ registerTool(tool) { registrations.push(tool); }, on() {} });
  const result = await registrations[0].execute("id", { source: "file", path: "README.md", mode: "simple" }, undefined, undefined, { cwd: root });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.mode, "simple");
  assert.equal(await readFile(path, "utf8"), original);
});

test("AI;DR applies an exact file replacement only after native confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "aidr-"));
  const path = join(root, "README.md");
  const original = "# Example\n\nThis is padded prose in order to test the fixer.\n";
  const replacement = "# Example\n\nThis direct prose tests the fixer.\n";
  await writeFile(path, original);
  const registrations = [];
  const confirmations = [];
  registerAidrInterface({ registerTool(tool) { registrations.push(tool); }, on() {} });
  const result = await registrations[0].execute(
    "id",
    { action: "apply", source: "file", path: "README.md", replacement, mode: "simple" },
    undefined,
    undefined,
    { cwd: root, ui: { async confirm(title, message) { confirmations.push({ title, message }); return true; } } },
  );
  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, "applied");
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /- This is padded prose/);
  assert.match(confirmations[0].message, /\+ This direct prose/);
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.notEqual(result.details.beforeHash, result.details.afterHash);
});

test("AI;DR refuses a file that drifts after the diff preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "aidr-"));
  const path = join(root, "README.md");
  const original = "# Example\n";
  await writeFile(path, original);
  const registrations = [];
  registerAidrInterface({ registerTool(tool) { registrations.push(tool); }, on() {} });
  const result = await registrations[0].execute(
    "id",
    { action: "apply", source: "file", path: "README.md", replacement: "# Changed\n" },
    undefined,
    undefined,
    {
      cwd: root,
      ui: {
        async confirm() {
          await writeFile(path, "# Drifted\n");
          return true;
        },
      },
    },
  );
  assert.equal(result.details.ok, false);
  assert.match(result.details.reason, /changed after review/);
  assert.equal(await readFile(path, "utf8"), "# Drifted\n");
});

test("AI;DR does not write when native confirmation declines", async () => {
  const root = await mkdtemp(join(tmpdir(), "aidr-"));
  const path = join(root, "README.md");
  const original = "# Example\n";
  await writeFile(path, original);
  const registrations = [];
  registerAidrInterface({ registerTool(tool) { registrations.push(tool); }, on() {} });
  const result = await registrations[0].execute(
    "id",
    { action: "apply", source: "file", path: "README.md", replacement: "# Changed\n" },
    undefined,
    undefined,
    { cwd: root, ui: { async confirm() { return false; } } },
  );
  assert.equal(result.details.ok, false);
  assert.equal(await readFile(path, "utf8"), original);
});

test("AI;DR rejects unsupported file types and paths outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "aidr-"));
  const registrations = [];
  registerAidrInterface({ registerTool(tool) { registrations.push(tool); }, on() {} });
  const unsupported = await registrations[0].execute("id", { source: "file", path: "secret.json" }, undefined, undefined, { cwd: root });
  assert.equal(unsupported.details.ok, false);
  const outside = await registrations[0].execute("id", { source: "file", path: "../README.md" }, undefined, undefined, { cwd: root });
  assert.equal(outside.details.ok, false);
});
