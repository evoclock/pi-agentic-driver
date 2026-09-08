// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Guest containment step 1: taxonomy stability, severity-tiered killswitch
// decision core, and structured log schema/redaction (design
// GUEST_CONTAINMENT_DESIGN.md sections 2, 2.0, 4, 5). The decision core lives
// in the fixture script and is exercised through its test hooks.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/enforcement/linux_microvm_remote_fixture.sh");
const TAXONOMY_FILE = join(ROOT, "scripts/enforcement/guest_containment_taxonomy.v1.json");
// Pinned digest of the shipped taxonomy (design section 2: pinned per
// repository revision; the fixture embeds and verifies the same digest).
const TAXONOMY_SHA256 = "2d3f781c1594a5cefb77560419faff1619bc90012fc20b339a79110dbaa847c9";
const INITRAMFS = "a".repeat(64);

function runFixture(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile("bash", [FIXTURE, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
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

// --- Step 2: detection (shims, watchers, liveness) ---

test("shim denies an unlisted executable after the learning window with a redacted command line", async () => {
  const dir = await tempState();
  try {
    // Window forced closed: nothing is learned, so even the first invocation
    // is judged against the locked allowlist.
    const out = JSON.parse(await runFixture([
      "--gc-shim", join(dir, "s"), "npm", "install", "--registry=https://evil/TOKEN=abc123",
    ], { GC_LEARNING_WINDOW_SECONDS: "0" }));
    assert.equal(out.decision, "deny");
    assert.equal(out.rule, "GC-PKG-001");
    const log = await readFile(join(dir, "s/containment.log.jsonl"), "utf8");
    const event = JSON.parse(log.trim().split("\n").at(-1)).event;
    assert.doesNotMatch(event.subject.value, /abc123/);
    assert.match(event.subject.value, /\[REDACTED\]/);
    assert.match(event.subject.value, /npm install/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("observed-first-use allowlist: learning window allows, lock denies unlisted", async () => {
  const dir = await tempState();
  try {
    // Long window: events allowed and recorded as learned.
    const learn = JSON.parse(await runFixture([
      "--gc-shim", join(dir, "s"), "ls", "-la",
    ], { GC_LEARNING_WINDOW_SECONDS: "999" }));
    assert.equal(learn.decision, "allow");
    assert.equal(learn.learned, true);
    // Force the window closed: the observed tool stays allowed...
    const locked = JSON.parse(await runFixture([
      "--gc-shim", join(dir, "s"), "ls",
    ], { GC_LEARNING_WINDOW_SECONDS: "0" }));
    assert.equal(locked.decision, "allow");
    assert.equal(locked.learned, false);
    // ...while an unobserved tool is now denied.
    const unlisted = JSON.parse(await runFixture([
      "--gc-shim", join(dir, "s"), "curl", "http://example.invalid",
    ], { GC_LEARNING_WINDOW_SECONDS: "0" }));
    assert.equal(unlisted.decision, "deny");
    assert.equal(unlisted.rule, "GC-NET-002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classified dangerous commands deny even during the learning window", async () => {
  const dir = await tempState();
  try {
    const out = JSON.parse(await runFixture([
      "--gc-shim", join(dir, "s"), "pip", "install", "requests",
    ]));
    assert.equal(out.decision, "deny");
    assert.equal(out.rule, "GC-PKG-001");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs-watcher detects writes outside the allowlist and shim-tree tampering", async () => {
  const dir = await tempState();
  try {
    assert.equal(JSON.parse(await runFixture(["--gc-fs-detect", join(dir, "s"), "/tmp/session/scratch.txt"])).decision, "allow");
    const deny = JSON.parse(await runFixture(["--gc-fs-detect", join(dir, "s"), "/etc/passwd"]));
    assert.equal(deny.decision, "deny");
    assert.equal(deny.rule, "GC-FSW-001");
    const selfMod = JSON.parse(await runFixture(["--gc-fs-detect", join(dir, "s"), "/shims/wget"]));
    assert.equal(selfMod.rule, "GC-FSW-002");
    // find -newer sweep fallback path: multiple candidate paths in one sweep.
    const sweep = (await runFixture(["--gc-fs-sweep", join(dir, "s2"), "/tmp/session/a", "/var/lib/evil"]))
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(sweep.map((d) => d.decision), ["allow", "deny"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("net-watcher denies any socket entry immediately (GC-NET-001)", async () => {
  const dir = await tempState();
  try {
    const out = JSON.parse(await runFixture([
      "--gc-net-detect", join(dir, "s"), "  1: 00350033:0035 00000000:0000 0A",
    ]));
    assert.equal(out.decision, "deny");
    assert.equal(out.rule, "GC-NET-001");
    const log = await readFile(join(dir, "s/containment.log.jsonl"), "utf8");
    const ks = JSON.parse(log.trim().split("\n").at(-1));
    assert.equal(ks.schema, "agentic-driver.guest-containment.killswitch.v1");
    assert.equal(ks.trigger.rule, "GC-NET-001");
    // The guest supervisor observes the kill flag.
    assert.equal(await readFile(join(dir, "s/kill"), "utf8"), "immediate\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dead monitor loop is a containment-integrity killswitch", async () => {
  const dir = await tempState();
  try {
    const out = JSON.parse(await runFixture(["--gc-liveness", join(dir, "s"), "1 0 1"]));
    assert.equal(out.decision, "deny");
    assert.equal(out.rule, "containment-integrity");
    assert.equal(out.tier, "CRITICAL");
    assert.equal(out.mode, "immediate");
    const healthy = JSON.parse(await runFixture(["--gc-liveness", join(dir, "s2"), "1 1 1"]));
    assert.equal(healthy.decision, "allow");
    const log = await readFile(join(dir, "s/containment.log.jsonl"), "utf8");
    const ks = JSON.parse(log.trim().split("\n").at(-1));
    assert.equal(ks.trigger.rule, "containment-integrity");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guest payload: init embeds the core verbatim, shims dispatch, proof mode unchanged", async () => {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  // The guest init runs the containment session only when /job.sh exists;
  // the marker proof path is byte-identical in behavior (mounts, marker, sync, poweroff).
  assert.match(fixtureSource, /if \[ ! -x \/job\.sh \]; then\n  sync\n  \/bin\/poweroff -f\nfi/);
  assert.match(fixtureSource, /PATH=\/shims:\/bin/);
  assert.ok(fixtureSource.includes('gc_liveness'));
  assert.ok(fixtureSource.includes('gc_net_detect'));
  assert.ok(fixtureSource.includes('gc_fs_detect'));
  assert.match(fixtureSource, /awk '\/\^# --- guest containment core\/\{flag=1\} \/\^# Test hooks:\/\{flag=0\} flag' "\$0"/);
  // inotifyd upgrade is optional; the sweep fallback is unconditional in the fs loop branch.
  assert.match(fixtureSource, /have_inotifyd=true/);
  assert.ok(fixtureSource.includes('find / -newer'));
});

// --- Step 3: containment envelope + host receipt v2 ---

import {
  LINUX_MICROVM_CUTOVER_SCHEMA,
  LINUX_MICROVM_CUTOVER_SCHEMA_V2,
  parseReceipt,
  runLinuxMicroVMCutover,
  validateLinuxMicroVMReceipt,
} from "../scripts/enforcement/linux_microvm_cutover_pi.js";

function compact(value) {
  return JSON.stringify(value);
}

function stubFactsShape(fixtureId, host = "test-microvm-host") {
  return {
    host, arch: "x86_64", kernel: "6.8.0-generic",
    libvirt: "qemu:///system",
    qemu: "QEMU emulator version 10.2.1",
    qemuBinaryPath: "/usr/bin/qemu-system-x86_64",
    kvmAccessible: true,
    fixtureDomain: `agentic-driver-${fixtureId}`, fixtureDomainState: "absent",
  };
}

function stubV1Receipt(fixtureId, scriptHash, host = "test-microvm-host") {
  const domain = `agentic-driver-${fixtureId}`;
  const marker = `AGENTIC_MICROVM_PROBE:${fixtureId}`;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return {
    schema: LINUX_MICROVM_CUTOVER_SCHEMA, ok: true, status: "VERIFIED",
    authorityCreated: false, runtimeActivated: false, persisted: false,
    identity: { remoteHost: host, fixtureId, domain },
    marker: { value: marker, sha256: digest(marker) },
    scriptHash, initramfsSha256: INITRAMFS,
    teardown: {
      domain: { name: domain, transient: true, destroyOnExit: true, destroyRequested: true, absent: true, checked: true, check: "virsh dominfo/list" },
      acl: { beforeSha256: "b".repeat(64), afterSha256: "b".repeat(64), equal: true, checked: true, initramfsEntryRemoved: true },
    },
    context: {
      filesystem: { summary: "disk=absent host-share=absent credentials=absent gpu=absent", disk: false, hostShare: false, credentials: false, gpu: false, sha256: digest(JSON.stringify({ disk: false, hostShare: false, credentials: false, gpu: false, initramfsSha256: INITRAMFS })) },
      network: { summary: "network=absent", guest: false, sha256: digest(JSON.stringify({ network: false })) },
      guestMounts: ["proc", "sysfs", "devtmpfs"],
    },
  };
}

function containmentBlock(logSha, { tripped = true, rule = "GC-CRED-001" } = {}) {
  return {
    schema: "agentic-driver.guest-containment.log.v1",
    taxonomySha256: TAXONOMY_SHA256,
    logSha256: logSha,
    events: 3,
    denials: 2,
    histogram: tripped ? { "GC-CRED": 1, unknown: 1 } : { unknown: 1 },
    killswitch: {
      tripped,
      rule: tripped ? rule : null,
      class: tripped ? "GC-CRED" : null,
      tier: tripped ? "CRITICAL" : null,
      guestPoweroff: true,
      final: true,
    },
  };
}

function stubV2Receipt(fixtureId, scriptHash, logSha, options = {}) {
  const receipt = stubV1Receipt(fixtureId, scriptHash);
  receipt.schema = LINUX_MICROVM_CUTOVER_SCHEMA_V2;
  receipt.containment = containmentBlock(logSha, options);
  return receipt;
}

function envelopeTranscript(fixtureId, payloadLines, { crlf = true, includeEnvelope = true, digestOverride = null } = {}) {
  const payload = payloadLines.join("\n") + "\n";
  // Guest semantics (design section 5): the trigger event is appended, the
  // digest covers the log up to and including it, then the terminal killswitch
  // line embedding that digest is appended.
  const event = compact({
    schema: "agentic-driver.guest-containment.killswitch.v1", session: fixtureId,
    trigger: { rule: "GC-CRED-001", class: "GC-CRED", tier: "CRITICAL", mode: "immediate", pressure: null, threshold: null },
    final: true,
  });
  const chained = payload + event + "\n";
  const sha = digestOverride ?? createHash("sha256").update(chained).digest("hex");
  const killswitch = compact({
    schema: "agentic-driver.guest-containment.killswitch.v1", session: fixtureId,
    trigger: { rule: "GC-CRED-001", class: "GC-CRED", tier: "CRITICAL", mode: "immediate", pressure: null, threshold: null },
    logSha256: sha, final: true,
  });
  const full = chained + killswitch + "\n";
  let body = `noise\r\nAGENTIC_MICROVM_PROBE:${fixtureId}\r\n`;
  if (includeEnvelope) {
    const b64 = Buffer.from(full, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
    body += `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}\r\n${crlf ? b64.replaceAll("\n", "\r\n") : b64}\r\nAGENTIC_CONTAINMENT_END:${fixtureId}\r\nmore unbound guest output\r\n`;
  }
  return { body, expectedLogSha: sha, full };
}

function envelopePayloadLines(fixtureId) {
  return [
    compact({ schema: "agentic-driver.guest-containment.log.v1", session: fixtureId, taxonomy: "guest-containment-taxonomy.v1", taxonomySha256: TAXONOMY_SHA256,
      event: { ts: "2026-01-01T00:00:00Z", seq: 1, source: "shim", class: "unknown", action: "deny", subject: { type: "exec", value: "npm install [REDACTED]" } } }),
    compact({ schema: "agentic-driver.guest-containment.log.v1", session: fixtureId, taxonomy: "guest-containment-taxonomy.v1", taxonomySha256: TAXONOMY_SHA256,
      event: { ts: "2026-01-01T00:00:01Z", seq: 2, source: "shim", class: "GC-CRED", action: "deny", subject: { type: "exec", value: "cat ~/.ssh/id_rsa" } } }),
  ];
}

function envelopeExtract(transcript, fixtureId) {
  return new Promise((resolve) => {
    const child = spawnSync("bash", [FIXTURE, "--gc-envelope-extract", transcript, fixtureId], { encoding: "utf8" });
    resolve({ status: child.status, stdout: child.stdout, stderr: child.stderr });
  });
}

test("envelope parse recomputes the log digest from a pty-mangled (CRLF) transcript", async () => {
  const fixtureId = "microvm-" + "a".repeat(24);
  const { body, expectedLogSha } = envelopeTranscript(fixtureId, envelopePayloadLines(fixtureId));
  const dir = await tempState();
  const transcript = join(dir, "console.typescript");
  await readFile(FIXTURE, "utf8"); // sanity
  const { writeFileSync } = await import("node:fs");
  writeFileSync(transcript, body);
  const result = await envelopeExtract(transcript, fixtureId);
  assert.equal(result.status, 0, result.stderr);
  const block = JSON.parse(result.stdout);
  assert.equal(block.taxonomySha256, TAXONOMY_SHA256);
  assert.equal(block.logSha256, expectedLogSha, "digest recomputed from decoded payload must match the guest log");
  // Records counted up to the trigger event (terminal killswitch line excluded).
  assert.equal(block.events, 3);
  assert.equal(block.denials, 2);
  assert.equal(block.killswitch.tripped, true);
  assert.equal(block.killswitch.rule, "GC-CRED-001");
  assert.equal(block.killswitch.guestPoweroff, true);
  assert.equal(block.killswitch.final, true);
  await rm(dir, { recursive: true, force: true });
});

test("missing containment evidence fails closed (containment-evidence-missing)", async () => {
  const fixtureId = "microvm-" + "b".repeat(24);
  const dir = await tempState();
  const transcript = join(dir, "console.typescript");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(transcript, `noise\r\nAGENTIC_MICROVM_PROBE:${fixtureId}\r\nno envelope here\r\n`);
  const result = await envelopeExtract(transcript, fixtureId);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /containment-evidence-missing/);
  await rm(dir, { recursive: true, force: true });
});

test("a clean session without killswitch ends with the session-end terminal event", async () => {
  const fixtureId = "microvm-" + "c".repeat(24);
  const lines = envelopePayloadLines(fixtureId);
  lines.push(compact({ schema: "agentic-driver.guest-containment.log.v1", session: fixtureId, taxonomy: "guest-containment-taxonomy.v1", taxonomySha256: TAXONOMY_SHA256,
    event: { ts: "2026-01-01T00:00:02Z", seq: 3, source: "supervisor", class: "session-end", action: "complete", summary: true } }));
  const payload = lines.join("\n") + "\n";
  const b64 = Buffer.from(payload, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
  const dir = await tempState();
  const transcript = join(dir, "console.typescript");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(transcript, `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}\r\n${b64.replaceAll("\n", "\r\n")}\r\nAGENTIC_CONTAINMENT_END:${fixtureId}\r\n`);
  const result = await envelopeExtract(transcript, fixtureId);
  assert.equal(result.status, 0, result.stderr);
  const block = JSON.parse(result.stdout);
  assert.equal(block.killswitch.tripped, false);
  assert.equal(block.killswitch.rule, null);
  await rm(dir, { recursive: true, force: true });
});

test("a tampered killswitch digest chain is rejected", async () => {
  const fixtureId = "microvm-" + "d".repeat(24);
  const { body } = envelopeTranscript(fixtureId, envelopePayloadLines(fixtureId), { digestOverride: "0".repeat(64) });
  const dir = await tempState();
  const transcript = join(dir, "console.typescript");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(transcript, body);
  const result = await envelopeExtract(transcript, fixtureId);
  assert.notEqual(result.status, 0);
  await rm(dir, { recursive: true, force: true });
});

test("v2 receipt with a closed containment block validates; killswitch trip is VERIFIED", () => {
  const fixtureId = "microvm-" + "e".repeat(24);
  const scriptHash = "1".repeat(64);
  const logSha = "2".repeat(64);
  const receipt = stubV2Receipt(fixtureId, scriptHash, logSha);
  const validated = validateLinuxMicroVMReceipt(receipt, stubFactsShape(fixtureId), fixtureId, scriptHash, { containment: true });
  assert.equal(validated.status, "VERIFIED");
  assert.equal(validated.containment.killswitch.tripped, true);
});

test("containment run without the v2 receipt is containment-evidence-missing (fail-closed)", () => {
  const fixtureId = "microvm-" + "f".repeat(24);
  const scriptHash = "1".repeat(64);
  assert.throws(
    () => validateLinuxMicroVMReceipt(stubV1Receipt(fixtureId, scriptHash), stubFactsShape(fixtureId), fixtureId, scriptHash, { containment: true }),
    (error) => error.reasonCode === "containment-evidence-missing",
  );
});

test("v1 receipts without a containment block still validate (backward compat)", () => {
  const fixtureId = "microvm-" + "0".repeat(24);
  const scriptHash = "1".repeat(64);
  const validated = validateLinuxMicroVMReceipt(stubV1Receipt(fixtureId, scriptHash), stubFactsShape(fixtureId), fixtureId, scriptHash);
  assert.equal(validated.status, "VERIFIED");
});

test("containment block fields are closed and digest-typed", () => {
  const fixtureId = "microvm-" + "9".repeat(24);
  const scriptHash = "1".repeat(64);
  const bad = stubV2Receipt(fixtureId, scriptHash, "2".repeat(64));
  bad.containment.logSha256 = "zz";
  assert.throws(() => validateLinuxMicroVMReceipt(bad, stubFactsShape(fixtureId), fixtureId, scriptHash, { containment: true }));
  const badHistogram = stubV2Receipt(fixtureId, scriptHash, "2".repeat(64));
  badHistogram.containment.histogram = { "GC-CRED": "two" };
  assert.throws(() => validateLinuxMicroVMReceipt(badHistogram, stubFactsShape(fixtureId), fixtureId, scriptHash, { containment: true }));
  const badTrip = stubV2Receipt(fixtureId, scriptHash, "2".repeat(64));
  badTrip.containment.killswitch.rule = null;
  assert.throws(() => validateLinuxMicroVMReceipt(badTrip, stubFactsShape(fixtureId), fixtureId, scriptHash, { containment: true }));
});

test("receipt-extra-output is relaxed solely for envelope markers on v2 receipts", () => {
  const fixtureId = "microvm-" + "7".repeat(24);
  const scriptHash = "1".repeat(64);
  const v2 = JSON.stringify(stubV2Receipt(fixtureId, scriptHash, "2".repeat(64)));
  const withEnvelope = `AGENTIC_MICROVM_RECEIPT: ${v2}\nAGENTIC_CONTAINMENT_BEGIN:${fixtureId}\nAGENTIC_CONTAINMENT_END:${fixtureId}\n`;
  assert.equal(parseReceipt(withEnvelope).schema, LINUX_MICROVM_CUTOVER_SCHEMA_V2);
  // Other unbound output still fails, even on v2.
  assert.throws(() => parseReceipt(`AGENTIC_MICROVM_RECEIPT: ${v2}\nrandom guest chatter\n`), (error) => error.reasonCode === "receipt-extra-output");
  // Envelope markers beside a v1 receipt are still extra output.
  const v1 = JSON.stringify(stubV1Receipt(fixtureId, scriptHash));
  assert.throws(() => parseReceipt(`AGENTIC_MICROVM_RECEIPT: ${v1}\nAGENTIC_CONTAINMENT_BEGIN:${fixtureId}\n`), (error) => error.reasonCode === "receipt-extra-output");
});

// --- Step 4: elastic resource allocation (user-configured, never model-set) ---

import {
  registerLinuxMicroVMCutoverInterface,
  LINUX_MICROVM_CUTOVER_TOOL,
} from "../scripts/enforcement/linux_microvm_cutover_pi.js";

function targetConfigFile(dir, extra = {}) {
  const path = join(dir, "microvm-target.v1.json");
  writeFileSync(path, JSON.stringify({ schema: "agentic-driver.microvm-target.v1", sshTarget: "user@test-microvm-host", ...extra }));
  return path;
}

function allocationHarness(confirmBodies, executedArgs) {
  return {
    context: { mode: "tui", hasUI: true, ui: { confirm: async (_title, body) => { confirmBodies.push(body); return true; } } },
    options: {
      isolationSwitch: { get: () => true },
      targetPath: undefined,
      execute: (executable, args) => {
        executedArgs.push([executable, ...args]);
        // The fixture run carries the fixture id; build a matching receipt.
        const fixtureId = executable === "ssh" ? args[4] : /microvm-[0-9a-f]{24}/.exec(args[1])?.[0];
        const scriptHash = executable === "ssh" ? args[5] : createHash("sha256").update(arguments[2]?.input ?? "").digest("hex");
        return { code: 0, stdout: `AGENTIC_MICROVM_RECEIPT: ${JSON.stringify(stubV1Receipt(fixtureId ?? "microvm-" + "3".repeat(24), scriptHash))}\n`, stderr: "" };
      },
      observeFacts: (execute, fixtureId) => stubFactsShape(fixtureId),
    },
  };
}

test("configured allocation flows into the confirmation text and fixture args", async () => {
  const dir = await tempState();
  try {
    const targetPath = targetConfigFile(dir, { vcpu: 4, memoryMiB: 2048 });
    const confirmBodies = [];
    const executed = [];
    const harness = allocationHarness(confirmBodies, executed);
    const value = await runLinuxMicroVMCutover(harness.context, { ...harness.options, targetPath, userConfigPath: "/nonexistent/user-config.json" });
    assert.equal(value.ok, true, JSON.stringify(value.reason ?? {}));
    assert.match(confirmBodies[0], /\b4 vCPU, 2048 MiB\b/);
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    assert.ok(fixtureExec, "fixture run expected over ssh");
    // Identity args are fixture-internal; the allocation args are last.
    assert.deepEqual(fixtureExec.slice(-2), ["4", "2048"]);
    assert.equal(fixtureExec.length, 9); // exe + target bash -s -- id hash vcpu mem
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unconfigured allocation keeps the proof defaults (1 vCPU, 128 MiB)", async () => {
  const dir = await tempState();
  try {
    const targetPath = targetConfigFile(dir);
    const confirmBodies = [];
    const executed = [];
    const harness = allocationHarness(confirmBodies, executed);
    const value = await runLinuxMicroVMCutover(harness.context, { ...harness.options, targetPath, userConfigPath: "/nonexistent/user-config.json" });
    assert.equal(value.ok, true, JSON.stringify(value.reason ?? {}));
    assert.match(confirmBodies[0], /\b1 vCPU, 128 MiB\b/);
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    assert.deepEqual(fixtureExec.slice(-2), ["1", "128"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid allocation rejects the whole target config (fail-closed)", async () => {
  const dir = await tempState();
  try {
    const targetPath = targetConfigFile(dir, { vcpu: 0 });
    const confirmBodies = [];
    const executed = [];
    const harness = allocationHarness(confirmBodies, executed);
    const value = await runLinuxMicroVMCutover(harness.context, { ...harness.options, targetPath, userConfigPath: "/nonexistent/user-config.json" });
    assert.equal(value.ok, false);
    assert.equal(value.reason.code, "target-not-configured");
    assert.equal(executed.length, 0, "no run may start with an invalid allocation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the model cannot set the allocation: the tool surface stays closed", async () => {
  const tools = {};
  const pi = { registerTool: (tool) => { tools[tool.name] = tool; }, registerCommand: () => {} };
  registerLinuxMicroVMCutoverInterface(pi);
  const tool = tools[LINUX_MICROVM_CUTOVER_TOOL];
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["target"]);
  // Passing an allocation-looking parameter is rejected before any execution.
  const executed = [];
  let returned;
  const context = { mode: "tui", hasUI: true, ui: { confirm: async () => true, notify: () => {} } };
  const result = await tool.execute("id", { vcpu: 64 }, undefined, undefined, context);
  returned = result;
  assert.equal(returned.details.ok, false);
  assert.equal(returned.details.reason.code, "model-parameters-not-allowed");
});

// --- Repair step: B1, H1, H2, H4, M1, M3, M4 ---

test("B1: the real receipt printf emits parseable JSON for v1 and v2 shapes", () => {
  const common = ["v1", "test-host", "microvm-" + "4".repeat(24), "agentic-driver-fid",
    "AGENTIC_MICROVM_PROBE:x", "a".repeat(64), "1".repeat(64), "b".repeat(64)];
  const v1 = runFixtureSync([
    "--gc-receipt-print", ...common, "-", "agentic-driver-fid", "true", "true", "c".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64),
  ]);
  const parsed1 = JSON.parse(v1);
  assert.equal(parsed1.schema, "v1");
  assert.equal(parsed1.containment, undefined);
  const segment = JSON.stringify(containmentBlock("2".repeat(64)));
  const v2 = runFixtureSync([
    "--gc-receipt-print", ...common, `,"containment":${segment}`,
    "agentic-driver-fid", "true", "true", "c".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64),
  ]);
  const parsed2 = JSON.parse(v2);
  assert.equal(parsed2.containment.killswitch.tripped, true);
});

function runFixtureSync(args) {
  const child = spawnSync("bash", [FIXTURE, ...args], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

test("H1: the log freezes at trip — appends after a killswitch trip are refused", async () => {
  const dir = await tempState();
  try {
    const state = join(dir, "s");
    await decide(state, "GC-CRED-001", "cat ~/.ssh/id_rsa");
    const before = await readFile(join(state, "containment.log.jsonl"), "utf8");
    await runFixture(["--gc-log", state, "watcher:proc", "unknown", "proc", "post-trip"]);
    const after = await readFile(join(state, "containment.log.jsonl"), "utf8");
    assert.equal(after, before, "post-trip appends must not reach the log");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H1: trailing post-trip records do not invalidate the evidence digest chain", async () => {
  const fixtureId = "microvm-" + "5".repeat(24);
  const { body, expectedLogSha } = envelopeTranscript(fixtureId, envelopePayloadLines(fixtureId));
  // Append noise after the envelope payload ends: the chain is verified at the
  // killswitch line's position, not by assuming it is last.
  const dir = await tempState();
  const transcript = join(dir, "console.typescript");
  writeFileSync(transcript, body.replace("more unbound guest output", "straggler log line after trip\r\nmore unbound guest output"));
  const result = await envelopeExtract(transcript, fixtureId);
  assert.equal(result.status, 0, result.stderr);
  const block = JSON.parse(result.stdout);
  assert.equal(block.logSha256, expectedLogSha);
  await rm(dir, { recursive: true, force: true });
});

test("H2: a second envelope pair is rejected as a forgery attempt", async () => {
  const fixtureId = "microvm-" + "6".repeat(24);
  const { body } = envelopeTranscript(fixtureId, envelopePayloadLines(fixtureId), { includeEnvelope: false });
  const good = envelopeTranscript(fixtureId, envelopePayloadLines(fixtureId)).body;
  const dir = await tempState();
  const transcript = join(dir, "console.typescript");
  // Inject a forged (empty but well-formed) envelope before the real one.
  const forged = `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}\r\n_AGNETIC_CONTAINMENT_END:${fixtureId}\r\n`;
  writeFileSync(transcript, forged + good);
  const result = await envelopeExtract(transcript, fixtureId);
  assert.notEqual(result.status, 0);
  await rm(dir, { recursive: true, force: true });
});

test("H4: busybox applet bypass, credential reads, env probing, manifests, and dev writes classify", async () => {
  const dir = await tempState();
  try {
    const shim = async (...args) => JSON.parse(await runFixture(["--gc-shim", join(dir, "s"), ...args]));
    assert.equal((await shim("busybox", "wget", "http://x")).rule, "GC-NET-002", "busybox applet bypass must not evade the shim");
    assert.equal((await shim("cat", "/home/u/.ssh/id_rsa")).rule, "GC-CRED-001");
    assert.equal((await shim("printenv")).rule, "GC-CRED-002");
    assert.equal((await shim("sh", "-c", "env | grep -i token")).rule, "GC-CRED-002");
    assert.equal((await shim("bash", "-c", "echo {} > package.json")).rule, "GC-PKG-003");
    assert.equal((await shim("sed", "-i", "s/x/y/", "/tmp/session/.gc/containment.log.jsonl")).rule, "GC-LOG-002");
    assert.equal((await shim("echo", "AGENTIC_CONTAINMENT_BEGIN:microvm-x", ">", "/dev/console")).rule, "GC-TOOL-001");
    assert.equal((await shim("tee", "/dev/ttyS0")).rule, "GC-TOOL-002");
    const fs = async (...args) => JSON.parse(await runFixture(["--gc-fs-detect", join(dir, "s2"), ...args]));
    assert.equal((await fs("/opt/app/package.json")).rule, "GC-PKG-003");
    assert.equal((await fs("/dev/console")).rule, "GC-TOOL-002");
    // Taxonomy dispositions: the gap rules are explicitly marked.
    const taxonomy = JSON.parse(await readFile(TAXONOMY_FILE, "utf8"));
    const byId = Object.fromEntries(taxonomy.rules.map((r) => [r.id, r]));
    for (const id of ["GC-FSW-003", "GC-SHR-001", "GC-SHR-002", "GC-LOG-001"]) {
      assert.match(byId[id].disposition, /^taxonomy-only-until-detector:/, `${id} must declare its missing detector`);
    }
    for (const id of ["GC-CRED-001", "GC-CRED-002", "GC-PKG-003", "GC-LOG-002", "GC-TOOL-001", "GC-TOOL-002"]) {
      assert.match(byId[id].disposition, /^detector:/, `${id} must declare a wired detector`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M1: the containment block carries the schema and compact histogram", async () => {
  const fixtureId = "microvm-" + "8".repeat(24);
  const { body, expectedLogSha } = envelopeTranscript(fixtureId, envelopePayloadLines(fixtureId));
  const dir = await tempState();
  const transcript = join(dir, "console.typescript");
  writeFileSync(transcript, body);
  const block = JSON.parse((await envelopeExtract(transcript, fixtureId)).stdout);
  assert.equal(block.schema, "agentic-driver.guest-containment.log.v1");
  assert.deepEqual(block.histogram, { unknown: 1, "GC-CRED": 1 });
  assert.equal(block.logSha256, expectedLogSha);
  await rm(dir, { recursive: true, force: true });
});

test("M3: learning-window observations are logged as events", async () => {
  const dir = await tempState();
  try {
    const state = join(dir, "s");
    await runFixture(["--gc-shim", state, "ls", "-la"], { GC_LEARNING_WINDOW_SECONDS: "999" });
    const log = await readFile(join(state, "containment.log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.event.action === "observe" && e.event.class === "unknown"), "window observation logged");
    assert.ok(!events.some((e) => e.event.action === "deny"), "observations are not denials");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M4: flood degrades to summary-only records without dropping events", async () => {
  const dir = await tempState();
  try {
    const state = dir; // the temp dir itself is the containment state dir
    // Pre-fill the log beyond the 8 KiB cap with valid v1-shape records.
    const filler = JSON.stringify({ schema: "agentic-driver.guest-containment.log.v1", session: "s", taxonomy: "guest-containment-taxonomy.v1", taxonomySha256: TAXONOMY_SHA256, event: { ts: "t", seq: 0, source: "shim", class: "unknown", action: "deny", subject: { type: "exec", value: "x".repeat(120) } } });
    writeFileSync(join(state, "containment.log.jsonl"), `${Array(80).fill(filler).join("\n")}\n`);
    writeFileSync(join(state, "taxonomy.json"), await readFile(TAXONOMY_FILE));
    const out = JSON.parse(await runFixture(["--gc-log", state, "shim", "unknown", "exec", "post-flood"]));
    assert.equal(out.event.summary, true);
    assert.equal(out.event.subject, undefined, "context dropped in summary-only mode");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
