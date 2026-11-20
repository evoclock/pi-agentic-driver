import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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
  // Why: Keep example envelopes aligned with billing caps, safe paths, and merge-ready effect limits.
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
  // Why: Keep the example's allowed paths valid under the schema's path pattern.
  assert.ok(envelope.allowedPaths.every((path) => pathPattern.test(path)));
  for (const invalidPath of ["/etc/passwd", "../secret", "src/../secret", "C:/secret", "src\\secret"]) {
    // Why: Reject absolute paths, traversal segments, and Windows-style paths in scope declarations.
    assert.equal(pathPattern.test(invalidPath), false, `unsafe path accepted: ${invalidPath}`);
  }
  assert.ok(envelope.allowedEffects.every((effect) => schema.properties.allowedEffects.items.enum.includes(effect)));
  assert.ok(envelope.outOfEnvelope.every((reason) => schema.properties.outOfEnvelope.items.enum.includes(reason)));
  assert.ok(envelope.outOfEnvelope.length > 0);
  assert.ok(!("signature" in envelope) && !("lease" in envelope), "envelopes are repo policy, not per-task grants");
});

test("driver-mode lists only the requested driver jobs and leaves ordinary work direct", () => {
  // Why: Keep every supported job in the route index without routing ordinary work or hiding unavailable skills.
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
    "model-fidelity",
  ]);
  assert.match(text, /ordinary work is the default/i);
  assert.match(text, /poteto-mode/);
  assert.match(text, /skip/i, "unavailable pstack skills must be reported, not copied");
});

test("observability delegates test-only and production proofs to official check", (t) => {
  if (!existsSync(new URL('../scripts/ci-observability.sh', import.meta.url))) {
    t.skip('private observability script is not in this checkout');
    return;
  }
  // Why: Linux acceptance must allow test-only tips while retaining real fail-first and mutation proof for production.
  const commands = [...read("scripts/ci-observability.sh").matchAll(/^python3 scripts\/test_gate_runner\.py --phase \w+ --base "\$base".*$/gm)]
    .map(([line]) => line.split(" 2>&1")[0]);
  assert.ok(commands.length > 0, "observability must run the official gate");
  mkdirSync(join(root, ".scratch"), { recursive: true });
  const fixture = mkdtempSync(join(root, ".scratch/observability-gate-"));
  for (const directory of ["scripts", "tests", ".driver"]) mkdirSync(join(fixture, directory));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd: fixture, env, encoding: "utf8" }).trim();
  assert.match(read("scripts/test_gate_runner.py"), /check_base_freshness\.py/, "official runner must check freshness before baseline and lock publication");
  writeFileSync(join(fixture, "scripts/test_gate_runner.py"), read("scripts/test_gate_runner.py"));
  writeFileSync(join(fixture, "scripts/check_base_freshness.py"), read("scripts/check_base_freshness.py"));
  writeFileSync(join(fixture, ".gitignore"), ".driver/test-gate-evidence/\nscratch/\n__pycache__/\n");
  writeFileSync(join(fixture, ".driver/gate-rules.json"), JSON.stringify({ schema: "driver-gate-rules.v1", baseRef: "main", checks: [{ id: "python-tests", kind: "command", command: ["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"] }] }));
  const config = { schema: "driver-test-gate.v1", caps: { maxObservedTests: 100, commandTimeoutSeconds: 30 }, testCountRationales: { "python-tests": "Use unittest's host-observed Ran N total." } };
  writeFileSync(join(fixture, ".driver/test-gate.json"), JSON.stringify(config));
  writeFileSync(join(fixture, "subject.py"), "def value():\n    return 1\n");
  const spec = "import unittest\nfrom subject import value\nclass Contract(unittest.TestCase):\n    def test_value(self):\n        \"\"\"Why: assert the expected production value.\"\"\"\n        self.assertEqual(value(), 1)\n";
  writeFileSync(join(fixture, "tests/test_contract.py"), spec);
  git("init", "--template=", "-b", "main");
  git("add", ".");
  git("commit", "-m", "fixture base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(fixture, "tests/test_contract.py"), `${spec}        self.assertIsInstance(value(), int)\n`);
  const testOnly = spawnSync("bash", ["-c", `set -euo pipefail\nbase=${base}\n${commands.join("\n")}`], { cwd: fixture, env, encoding: "utf8", timeout: 60000 });
  assert.equal(testOnly.error, undefined);
  assert.equal(testOnly.status, 0, testOnly.stdout + testOnly.stderr);
  assert.match(testOnly.stdout, /test-only: head tests passed/);
  assert.match(testOnly.stdout, /"phase": "check"/);
  assert.doesNotMatch(testOnly.stdout, /new tests passed on the base commit/);
  writeFileSync(join(fixture, "subject.py"), "def value():\n    return 2\n");
  writeFileSync(join(fixture, "tests/test_contract.py"), spec.replace("value(), 1", "value(), 2"));
  config.mutations = { "subject-value": { id: "subject-value", path: "subject.py", before: "return 2", after: "return 1", testCheckId: "python-tests", testPaths: ["tests/test_contract.py"], reason: "The production value regression must be caught." } };
  writeFileSync(join(fixture, ".driver/test-gate.json"), JSON.stringify(config));
  const production = spawnSync("bash", ["-c", `set -euo pipefail\nbase=${base}\n${commands.join("\n")}`], { cwd: fixture, env, encoding: "utf8", timeout: 60000 });
  assert.equal(production.error, undefined);
  assert.equal(production.status, 0, production.stdout + production.stderr);
  assert.match(production.stdout, /RUN \[fail-first-base\]/);
  assert.match(production.stdout, /"mutationCaught": true/);
});

test("each driver principle has an explicit check", () => {
  // Why: Give every shipped driver principle a concrete check instead of guidance alone.
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
  // Why: Preserve per-worker sessions and profiles without treating defaults as permission or scheduling ordinary work.
  const defaults = read(".driver/defaults.md");
  assert.match(defaults, /session files? (?:stay )?on for every worker/i);
  assert.match(defaults, /one (?:separate )?Pi profile per bot/i);
  assert.match(defaults, /ordinary work is the default/i);
  assert.match(defaults, /not an active grant/i);
  assert.match(defaults, /not an action guard/i);
});

// Why: completed gate snapshots on tmpfs must be reclaimed before the next Node tests consume the same cgroup memory.
test("observability reclaims only completed base snapshots after a passing gate", (t) => {
  if (!existsSync(new URL('../scripts/ci-observability.sh', import.meta.url))) {
    t.skip('private observability script is not in this checkout');
    return;
  }
  const script = read("scripts/ci-observability.sh");
  const gate = script.indexOf('python3 scripts/test_gate_runner.py --phase check --base "$base"');
  const cleanup = script.indexOf('find "$gate_snapshots" -mindepth 1 -maxdepth 1 -type d -name "base-*" -exec rm -rf -- {} +');
  const nextTests = script.indexOf('node --test --test-reporter=tap tests/test_task_skill_observability.mjs');
  assert.ok(gate >= 0 && gate < cleanup && cleanup < nextTests, "cleanup must follow the gate, not replace it or run after Node");
  assert.match(script, /if \[\[ -d "\$gate_snapshots" && ! -L "\$gate_snapshots" \]\]; then/);
  assert.match(script, /du -sk "\$gate_snapshots" \| tee \/scratch\/evidence\/gate-snapshots-after\.log/);
});

const retirementInventoryPath = join(root, "docs/internal/flockmate/2026-10-24/pi-skill-retirement-inventory.md");
test("retirement inventory lists 54 ports and blocks 53 retirements", { skip: !existsSync(retirementInventoryPath) }, () => {
  // Why: Preserve the full port inventory and block skill retirement until the release workflow is proven.
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
