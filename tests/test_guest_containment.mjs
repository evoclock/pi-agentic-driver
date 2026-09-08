// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Guest containment step 1: taxonomy stability, severity-tiered killswitch
// decision core, and structured log schema/redaction (design
// GUEST_CONTAINMENT_DESIGN.md sections 2, 2.0, 4, 5). The decision core lives
// in the fixture script and is exercised through its test hooks.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/enforcement/linux_microvm_remote_fixture.sh");
const TAXONOMY_FILE = join(ROOT, "scripts/enforcement/guest_containment_taxonomy.v1.json");
// Pinned digest of the shipped taxonomy (design section 2: pinned per
// repository revision; the fixture embeds and verifies the same digest).
const TAXONOMY_SHA256 = "1b2c9cd424f682d800f8049423a5626a697be1b6f759b2a1d6bb07461978969a";

function runFixture(args) {
  return new Promise((resolve, reject) => {
    execFile("bash", [FIXTURE, ...args], (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
  });
}

function decide(stateDir, ruleId, subject = "") {
  return runFixture(["--gc-decide", stateDir, ruleId, subject]).then(JSON.parse);
}

async function tempState() {
  return mkdtemp(join(tmpdir(), "gc-test-"));
}

const EXPECTED_RULE_IDS = [
  "GC-PKG-001", "GC-PKG-002", "GC-PKG-003",
  "GC-FSW-001", "GC-FSW-002", "GC-FSW-003",
  "GC-SHR-001", "GC-SHR-002",
  "GC-NET-001", "GC-NET-002",
  "GC-CRED-001", "GC-CRED-002",
  "GC-LOG-001", "GC-LOG-002",
  "GC-TOOL-001", "GC-TOOL-002",
];

const TIER_CLASSES = {
  CRITICAL: ["GC-CRED", "GC-LOG", "GC-TOOL"],
  HIGH: ["GC-NET", "GC-SHR"],
  ELEVATED: ["GC-PKG", "GC-FSW"],
};

test("taxonomy loads, is complete, and its SHA-256 is stable", async () => {
  const raw = await readFile(TAXONOMY_FILE, "utf8");
  const taxonomy = JSON.parse(raw);
  assert.equal(taxonomy.schema, "guest-containment-taxonomy.v1");
  assert.deepEqual(taxonomy.rules.map((r) => r.id), EXPECTED_RULE_IDS);
  for (const rule of taxonomy.rules) {
    assert.equal(rule.action, "deny");
    for (const key of ["id", "class", "severity", "action", "match", "evidence", "since"]) {
      assert.ok(rule[key], `rule ${rule.id} missing ${key}`);
    }
  }
  for (const [tier, classes] of Object.entries(TIER_CLASSES)) {
    for (const cls of classes) {
      const rule = taxonomy.rules.find((r) => r.class === cls);
      assert.equal(rule.severity, tier, `${cls} must be ${tier}`);
    }
  }
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    TAXONOMY_SHA256,
    "shipped taxonomy digest changed; re-pin deliberately",
  );
});

test("fixture embeds the exact shipped taxonomy and self-verifies its digest", async () => {
  const sha = (await runFixture(["--gc-taxonomy-sha"])).trim();
  assert.equal(sha, TAXONOMY_SHA256);
  const fixtureSource = await readFile(FIXTURE, "utf8");
  const start = fixtureSource.indexOf("<<'GC_TAXONOMY_EOF'\n");
  const end = fixtureSource.indexOf("\nGC_TAXONOMY_EOF", start);
  assert.ok(start > 0 && end > start, "embedded taxonomy heredoc not found");
  const embedded = fixtureSource.slice(start + "<<'GC_TAXONOMY_EOF'\n".length, end) + "\n";
  const shipped = await readFile(TAXONOMY_FILE, "utf8");
  assert.equal(embedded, shipped, "embedded copy drifted from the shipped taxonomy");
});

test("CRITICAL rule trips the killswitch immediately", async () => {
  const dir = await tempState();
  try {
    const d = await decide(join(dir, "s"), "GC-CRED-001", "cat ~/.ssh/id_rsa");
    assert.equal(d.tripped, true);
    assert.equal(d.tier, "CRITICAL");
    assert.equal(d.mode, "immediate");
    const log = await readFile(join(dir, "s/containment.log.jsonl"), "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l));
    const ks = lines.at(-1);
    assert.equal(ks.schema, "agentic-driver.guest-containment.killswitch.v1");
    assert.equal(ks.trigger.rule, "GC-CRED-001");
    assert.equal(ks.trigger.mode, "immediate");
    assert.equal(ks.final, true);
    assert.match(ks.logSha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HIGH rule trips the killswitch immediately", async () => {
  const dir = await tempState();
  try {
    const d = await decide(join(dir, "s"), "GC-NET-002", "wget http://example.invalid");
    assert.equal(d.tripped, true);
    assert.equal(d.tier, "HIGH");
    assert.equal(d.mode, "immediate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ELEVATED rules accumulate pressure and trip only at the threshold", async () => {
  const dir = await tempState();
  const state = join(dir, "s");
  try {
    for (let i = 0; i < 4; i++) {
      const d = await decide(state, "GC-PKG-001", `npm install pkg-${i}`);
      assert.equal(d.tripped, false, `pressure ${d.pressure} must not trip below threshold`);
      assert.equal(d.tier, "ELEVATED");
      assert.equal(d.mode, "aggregate");
    }
    // Pressure is a per-class aggregate (design section 2.0).
    const peer = await decide(state, "GC-FSW-001", "/etc/passwd");
    assert.equal(peer.tripped, false);
    assert.equal(peer.pressure, 1);
    const trip = await decide(state, "GC-PKG-002", "npm publish");
    assert.equal(trip.tripped, true, "aggregate pressure within one class trips the killswitch");
    assert.equal(trip.mode, "aggregate");
    assert.equal(trip.pressure, 5);
    assert.equal(trip.threshold, 5);
    const log = await readFile(join(state, "containment.log.jsonl"), "utf8");
    const ks = JSON.parse(log.trim().split("\n").at(-1));
    assert.equal(ks.trigger.mode, "aggregate");
    assert.equal(ks.trigger.pressure, 5);
    assert.equal(ks.trigger.threshold, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ANOMALY residual class accumulates and does not trip below threshold", async () => {
  const dir = await tempState();
  const state = join(dir, "s");
  try {
    for (let i = 0; i < 9; i++) {
      const d = await decide(state, "unknown", `novel-path-${i}`);
      assert.equal(d.tripped, false, `anomaly pressure ${d.pressure} must not trip below threshold`);
      assert.equal(d.class, "unknown");
      assert.equal(d.tier, "ANOMALY");
    }
    const trip = await decide(state, "unknown", "novel-path-9");
    assert.equal(trip.tripped, true);
    assert.equal(trip.threshold, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("killswitch log carries the versioned schema, taxonomy digest, and redaction", async () => {
  const dir = await tempState();
  try {
    const out = JSON.parse(
      await runFixture(["--gc-log", join(dir, "s"), "watcher:fs", "GC-FSW-001", "path", "API_KEY=supersecret123 write /etc/cron.d/x"]),
    );
    assert.equal(out.schema, "agentic-driver.guest-containment.log.v1");
    assert.equal(out.taxonomy, "guest-containment-taxonomy.v1");
    assert.equal(out.taxonomySha256, TAXONOMY_SHA256);
    assert.equal(out.event.action, "deny");
    assert.equal(out.event.seq, 1);
    assert.match(out.event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(out.event.subject.type, "path");
    assert.doesNotMatch(out.event.subject.value, /supersecret123/);
    assert.match(out.event.subject.value, /\[REDACTED\]/);
    const stored = JSON.parse(await readFile(join(dir, "s/containment.log.jsonl"), "utf8"));
    assert.deepEqual(stored, out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("log truncates oversized subject values to the 512-byte bound", async () => {
  const dir = await tempState();
  try {
    const out = JSON.parse(
      await runFixture(["--gc-log", join(dir, "s"), "shim", "GC-FSW-001", "path", "x".repeat(4096)]),
    );
    assert.ok(Buffer.byteLength(out.event.subject.value) <= 512);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
