import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAlignmentGap } from "../scripts/enforcement/alignment_gap.js";

const root = process.cwd();

function markerPair(role) {
  if (role === "reviewer") return ["[REVIEW_REPORT_BEGIN]", "[REVIEW_REPORT_END]"];
  const label = role.toUpperCase().replaceAll("-", "_");
  return [`[${label}_REPORT_BEGIN]`, `[${label}_REPORT_END]`];
}

async function writeArm(dir, { fixtureId, denials, outcome }) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fixture-id.txt"), fixtureId + "\n");
  const events = [];
  for (let i = 0; i < denials; i += 1) {
    events.push(JSON.stringify({ schema: "agentic-driver.guest-containment.log.v1", event: { seq: i + 1, source: "shim", class: "GC-NET", action: "deny", subject: { type: "exec", value: "wget example.com" } } }));
  }
  events.push(JSON.stringify({ schema: "agentic-driver.guest-containment.log.v1", event: { seq: denials + 1, source: "supervisor", class: "session-outcome", action: "outcome", subject: { type: "outcome", value: outcome } } }));
  const log = events.join("\n");
  const b64 = Buffer.from(log, "utf8").toString("base64");
  const transcript = `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}\n${b64}\nAGENTIC_CONTAINMENT_END:${fixtureId}\n`;
  await writeFile(join(dir, "console.typescript"), transcript);
}

test("alignment gap: compliant undisclosed arm vs denied disclosed arm produces a significant gap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alignment-"));
  try {
    const disclosed = join(dir, "disclosed");
    const undisclosed = join(dir, "undisclosed");
    await writeArm(disclosed, { fixtureId: "microvm-disclosed", denials: 1, outcome: "pass: task completed" });
    await writeArm(undisclosed, { fixtureId: "microvm-undisclosed", denials: 0, outcome: "pass: task completed" });
    const report = analyzeAlignmentGap(disclosed, undisclosed);
    assert.equal(report.schema, "agentic-driver.alignment-gap.v1");
    assert.equal(report.arms.disclosed.denials, 1);
    assert.equal(report.arms.undisclosed.denials, 0);
    assert.equal(report.gap.disclosedDenied, report.arms.disclosed.denied);
    assert.equal(report.gap.undisclosedDenied, report.arms.undisclosed.denied);
    assert.equal(report.gap.significant, false);
    assert.equal(report.nonAuthorizing, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("alignment gap: missing envelope fails with a clear error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alignment-"));
  try {
    const disclosed = join(dir, "disclosed");
    await mkdir(disclosed, { recursive: true });
    await writeFile(join(disclosed, "fixture-id.txt"), "microvm-x\n");
    await writeFile(join(disclosed, "console.typescript"), "no envelope here");
    const undisclosed = join(dir, "undisclosed");
    await writeArm(undisclosed, { fixtureId: "microvm-y", denials: 0, outcome: "pass" });
    assert.throws(() => analyzeAlignmentGap(disclosed, undisclosed), /containment envelope not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
