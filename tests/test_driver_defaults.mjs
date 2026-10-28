import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

function skillFrontmatter(name) {
  const text = read(`skills/${name}/SKILL.md`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  assert.ok(frontmatter, `${name}: missing YAML frontmatter`);
  assert.match(frontmatter, new RegExp(`^name: ${name}$`, "m"));
  assert.match(frontmatter, /^description: .+$/m, `${name}: missing description`);
  return text;
}

test("envelope schema covers caps, scope, merge mode, and out-of-envelope cases", () => {
  const schema = json(".driver/envelope.schema.json");
  const envelope = json(".driver/envelope.json");
  const required = [
    "version",
    "allowedModelBilling",
    "caps",
    "allowedPaths",
    "allowedEffects",
    "mergeMode",
    "outOfEnvelope",
  ];

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), [...required].sort());
  assert.deepEqual([...schema.properties.mergeMode.enum].sort(), ["merge", "merge-ready"]);
  assert.equal(schema.properties.caps.properties.wallClockSeconds.type, "integer");
  assert.equal(schema.properties.caps.properties.iterations.type, "integer");
  const billingRule = schema.allOf.find((rule) => rule.if?.properties?.allowedModelBilling);
  assert.ok(billingRule?.then && billingRule.else, "API billing must select an API spend cap");
  assert.equal(billingRule.then.properties.caps.properties.apiSpendUsd.type, "number");
  assert.equal(billingRule.else.properties.caps.properties.apiSpendUsd.type, "null");
  const mergeRule = schema.allOf.find((rule) => rule.if?.properties?.mergeMode);
  assert.equal(mergeRule.if.properties.mergeMode.const, "merge");
  assert.equal(mergeRule.then.properties.allowedEffects.contains.const, "merge");
  assert.equal(mergeRule.else.properties.allowedEffects.not.contains.const, "merge");
  assert.deepEqual(Object.keys(envelope).sort(), [...required].sort());
  assert.deepEqual(envelope.allowedModelBilling, ["subscription", "local"]);
  assert.equal(envelope.caps.apiSpendUsd, null);
  assert.ok(envelope.caps.wallClockSeconds > 0);
  assert.ok(envelope.caps.iterations > 0);
  assert.equal(envelope.mergeMode, "merge-ready");
  assert.ok(!envelope.allowedEffects.includes("merge"), "merge-ready example must not permit merging");
  const pathPattern = new RegExp(schema.properties.allowedPaths.items.pattern);
  assert.ok(envelope.allowedPaths.every((path) => pathPattern.test(path)));
  for (const invalidPath of ["/etc/passwd", "../secret", "src/../secret", "C:/secret", "src\\secret"]) {
    assert.equal(pathPattern.test(invalidPath), false, `unsafe path accepted: ${invalidPath}`);
  }
  assert.ok(envelope.allowedEffects.every((effect) => schema.properties.allowedEffects.items.enum.includes(effect)));
  assert.ok(envelope.outOfEnvelope.every((reason) => schema.properties.outOfEnvelope.items.enum.includes(reason)));
  assert.ok(envelope.outOfEnvelope.length > 0);
  assert.ok(!("signature" in envelope) && !("lease" in envelope), "envelopes are repo policy, not per-task grants");
});

test("driver-mode lists only the requested driver jobs and leaves ordinary work direct", () => {
  const text = skillFrontmatter("driver-mode");
  const section = text.split("## Driver job routes\n")[1]?.split("\n## ")[0] ?? "";
  const jobs = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]);

  assert.deepEqual(jobs, [
    "ship",
    "project-knowledge",
    "ralph",
    "clean-room",
    "release-to-public",
    "board-run",
    "harvest-lessons",
    "weekly-recap",
  ]);
  assert.match(text, /ordinary work is the default/i);
  assert.match(text, /poteto-mode/);
  assert.match(text, /skip/i, "unavailable pstack skills must be reported, not copied");
});

test("each driver principle has an explicit check", () => {
  const names = [
    "driver-principle-evidence",
    "driver-principle-fail-loud",
    "driver-principle-boundary-only-authority",
    "driver-principle-dependency-policy",
    "driver-principle-working-memory-is-not-authority",
    "driver-principle-cite-your-status",
  ];

  for (const name of names) assert.match(read(`skills/${name}/SKILL.md`), /^Check:/m, `${name}: missing check`);
});

test("defaults keep sessions and bot profiles separate and ordinary work unscheduled", () => {
  const defaults = read(".driver/defaults.md");
  assert.match(defaults, /session files? (?:stay )?on for every worker/i);
  assert.match(defaults, /one (?:separate )?Pi profile per bot/i);
  assert.match(defaults, /ordinary work is the default/i);
  assert.match(defaults, /not an active grant/i);
  assert.match(defaults, /not an action guard/i);
});

const retirementInventoryPath = join(root, "docs/internal/flockmate/2026-10-24/pi-skill-retirement-inventory.md");
test("retirement inventory lists 54 ports and blocks 53 retirements", { skip: !existsSync(retirementInventoryPath) }, () => {
  const inventory = readFileSync(retirementInventoryPath, "utf8");
  const rows = [...inventory.matchAll(/^\| `skills\/[^`]+` \|([^|]*)\|([^|]*)\|$/gm)];
  const retire = rows.flatMap(([, cell]) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  const keepFromPorts = rows.flatMap(([, , cell]) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  const allPorts = [...retire, ...keepFromPorts];

  assert.equal(retire.length, 53);
  assert.deepEqual(keepFromPorts, ["correct-pi"]);
  assert.equal(new Set(allPorts).size, 54);
  assert.match(inventory, /blocked until .*release workflow.*proven/i);
  assert.match(inventory, /No skills are deleted in this PR/i);
  for (const native of [
    "tasks",
    "pulse",
    "decision-to-spec",
    "harvest-lessons",
    "public-pr-wording",
    "correct-pi",
    "code-review",
    "crew-tracker-sync",
    "diagnosing-bugs",
    "release-public",
    "verify-journey",
    "weekly-build-recap",
    "driver-mode",
    "driver-principle-evidence",
    "driver-principle-fail-loud",
    "driver-principle-boundary-only-authority",
    "driver-principle-dependency-policy",
    "driver-principle-working-memory-is-not-authority",
    "driver-principle-cite-your-status",
  ]) {
    assert.match(inventory, new RegExp(`\\b${native}\\b`));
  }
});
