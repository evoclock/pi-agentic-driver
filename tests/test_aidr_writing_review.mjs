import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

test("AI;DR applies an ASD-STE100-informed profile in simple and ste modes", () => {
  const report = reviewText(
    "Utilize the tool in order to carry out the task. The operator should set up the unit as soon as possible.",
    { mode: "simple", source: "text" },
  );
  const rules = report.standards["ASD-STE100"].rulesApplied;
  assert.equal(report.standard, "asd-ste100");
  assert.ok(rules.includes("STE-W1"));
  assert.ok(rules.includes("STE-V1"));
  assert.ok(rules.includes("STE-M1"));
  assert.ok(rules.includes("STE-A1"));
  assert.ok(report.metrics.steFindingCount >= 4);
  assert.match(report.rewriteInstructions.join(" "), /ASD-STE100/);

  const explicit = reviewText("Use one precise sentence.", { mode: "ste", source: "text", standard: "asd-ste100" });
  assert.equal(explicit.standards["ASD-STE100"].status, "advisory_clear");
});

test("AI;DR ignores frontmatter and fenced code while reviewing prose", () => {
  const report = reviewText(`---\ntitle: Example\n---\n\nA short paragraph.\n\n\`\`\`js\nconst value = ${"x".repeat(300)};\n\`\`\``, { source: "text" });
  assert.equal(report.metrics.wordCount, 3);
  assert.equal(report.metrics.longSentenceCount, 0);
});

test("AI;DR treats each list item as its own paragraph", () => {
  const item = "This list item contains enough words to test paragraph boundaries without making a claim about the technical content. ";
  const report = reviewText(`- ${item.repeat(4)}\n- ${item.repeat(4)}\n- ${item.repeat(4)}`, { source: "text" });
  assert.equal(report.metrics.longParagraphCount, 0);
  assert.equal(report.metrics.paragraphCount, 3);
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
  assert.deepEqual(registrations[0].parameters.properties.mode.enum, ["review", "simple", "analogy", "ste"]);
  assert.deepEqual(registrations[0].parameters.properties.standard.enum, ["none", "asd-ste100"]);
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
  assert.equal(result.details.review.standard, "asd-ste100");
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

test("AI;DR follow-ups bound sources, ship registration, and verify exact writes", async () => {
  const registrations = [];
  let messageEnd;
  registerAidrInterface({
    registerTool(tool) { registrations.push(tool); },
    on(event, handler) { if (event === "message_end") messageEnd = handler; },
  });
  const tool = registrations[0];
  let confirmations = 0;
  await messageEnd({ message: { role: "assistant", content: [{ type: "text", text: "Last response." }] } });
  for (const source of ["last-response", "text"]) {
    const result = await tool.execute(
      "id",
      { action: "apply", source, text: "Supplied text.", replacement: "Replacement." },
      undefined,
      undefined,
      { cwd: process.cwd(), ui: { async confirm() { confirmations += 1; return true; } } },
    );
    const report = JSON.parse(result.content[0].text);
    assert.equal(report.ok, false);
    assert.match(report.reason, /only for files/);
  }
  assert.equal(confirmations, 0);

  assert.throws(() => reviewText("x".repeat(256 * 1024 + 1)), /bounded review size/);
  const root = await mkdtemp(join(tmpdir(), "aidr-"));
  const path = join(root, "README.md");
  const original = "# Example\n";
  await writeFile(path, original);
  let oversizedConfirmations = 0;
  const oversized = await tool.execute(
    "id",
    { action: "apply", source: "file", path: "README.md", replacement: "x".repeat(256 * 1024 + 1) },
    undefined,
    undefined,
    { cwd: root, ui: { async confirm() { oversizedConfirmations += 1; return true; } } },
  );
  const oversizedReport = JSON.parse(oversized.content[0].text);
  assert.equal(oversizedReport.ok, false);
  assert.match(oversizedReport.reason, /bounded review size/);
  assert.equal(oversizedConfirmations, 0);
  assert.equal(await readFile(path, "utf8"), original);

  const entry = await readFile(new URL("../extensions/aidr.ts", import.meta.url), "utf8");
  assert.match(entry, /export default function registerAidr/);
  assert.match(entry, /registerAidrInterface/);
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(packageManifest.pi.extensions.includes("./extensions"));
  assert.ok(packageManifest.files.includes("extensions/aidr.ts"));
  assert.ok(packageManifest.files.includes("scripts/aidr_writing_review.js"));

  const review = reviewText("Utilize the tool.", { mode: "review", standard: "none" });
  assert.equal(review.standard, "none");
  assert.equal(review.standards, undefined);
  const explicitStandard = reviewText("Utilize the tool.", { mode: "review", standard: "asd-ste100" });
  assert.equal(explicitStandard.standard, "asd-ste100");
  assert.equal(explicitStandard.standards["ASD-STE100"].profile, "ASD-STE100-informed");
  const steMode = reviewText("Use the tool.", { mode: "ste", standard: "none" });
  assert.equal(steMode.standard, "asd-ste100");
  assert.match(steMode.standards["ASD-STE100"].limitation, /does not certify conformance/);

  const replacement = "# Replaced\n";
  const originalReadFileSync = fs.readFileSync;
  const actualPath = fs.realpathSync(path);
  let mismatchReads = 0;
  fs.readFileSync = (...args) => {
    const result = originalReadFileSync(...args);
    if (args[0] === actualPath && args.length === 1) {
      mismatchReads += 1;
      return Buffer.from("unexpected\n");
    }
    return result;
  };
  try {
    const mismatch = await tool.execute(
      "id",
      { action: "apply", source: "file", path: "README.md", replacement },
      undefined,
      undefined,
      { cwd: root, ui: { async confirm() { return true; } } },
    );
    const mismatchReport = JSON.parse(mismatch.content[0].text);
    assert.equal(mismatchReport.ok, false);
    assert.match(mismatchReport.reason, /did not match the confirmed replacement/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(mismatchReads, 1);
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.deepEqual(await readdir(root), ["README.md"]);
});
