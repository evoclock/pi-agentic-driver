// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isNativeTuiContext } from "./native_tui_context.js";

export const LINUX_MICROVM_CUTOVER_TOOL = "agentic_linux_microvm_cutover";
export const LINUX_MICROVM_CUTOVER_SCHEMA = "agentic-driver.linux-microvm-cutover.v1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REMOTE_FIXTURE = join(SCRIPT_DIR, "linux_microvm_remote_fixture.sh");
const TARGET_EXAMPLE = join(SCRIPT_DIR, "..", "..", "config", "microvm-target.v1.example.json");
const TARGET_PACKAGE_CONFIG = join(SCRIPT_DIR, "..", "..", "config", "microvm-target.v1.json");
// The saved target config lives in the Pi coding-agent config directory
// (PI_CODING_AGENT_DIR when set, otherwise ~/.pi/agent), matching how Pi
// resolves its own config.
function resolveTargetUserConfigPath(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? join(env.PI_CODING_AGENT_DIR.trim(), "config")
    : join(homedir(), ".pi", "agent", "config");
  return join(agentDir, "microvm-target.v1.json");
}
const TARGET_USER_CONFIG = resolveTargetUserConfigPath();
const TARGET_SCHEMA = "agentic-driver.microvm-target.v1";
const REGISTRATIONS = new WeakSet();
const SWITCH_REGISTRATIONS = new WeakSet();
const HASH = /^[0-9a-f]{64}$/;
const MAX_DETAIL = 512;
// Isolation switch state is per-registration: each registerIsolationSwitchCommands
// call creates a fresh flag in the registration closure, so a new extension
// registration (session) starts disabled. It is held in memory only, never
// read from or written to settings, and never settable by the model (no tool
// exposes it; only the native TUI enable/disable commands mutate it).
export function createIsolationSwitch() {
  let enabled = false;
  return {
    get() { return enabled === true; },
    set(value) { enabled = value === true; },
  };
}
let inFlight = false;

function boundedText(value, fallback = "unknown failure") {
  const text = String(value ?? fallback)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return (text || fallback).slice(0, MAX_DETAIL);
}

function reason(phase, code, detail) {
  return { phase, code, detail: boundedText(detail) };
}
function denied(status, failure) {
  const value = typeof failure === "object" && failure !== null
    ? reason(failure.phase || "policy", failure.code || "denied", failure.detail)
    : reason("policy", "denied", failure);
  return { schema: LINUX_MICROVM_CUTOVER_SCHEMA, ok: false, status, reason: value,
    authorityCreated: false, runtimeActivated: false, persisted: false };
}
function phaseError(phase, code, detail) {
  const error = new Error(boundedText(detail));
  error.phase = phase;
  error.reasonCode = code;
  return error;
}
function reasonFromError(error, fallbackPhase, fallbackCode) {
  return reason(error?.phase || fallbackPhase, error?.reasonCode || fallbackCode,
    error?.message || error);
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", input: options.input,
    timeout: options.timeout ?? 30000 });
  return { code: result.status, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "", error: result.error?.message };
}
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function fixtureDomainForId(fixtureId) {
  if (!/^microvm-[0-9a-f]{24}$/.test(fixtureId)) {
    throw phaseError("preflight", "fixture-identity-invalid", "internal fixture identity is invalid");
  }
  return `agentic-driver-${fixtureId}`;
}
// --- User-configured trusted target (deny-by-default) -----------------------
// The user makes one decision: where the microVM runs. Either
// { "sshTarget": "user@host-or-ip" } for a remote machine, or { "local": true }
// when this session runs directly on a Linux machine. Nothing else is
// user-supplied: arch, libvirt URI, and kernel are auto-discovered from the
// target at probe time (informational, not configured). The model cannot
// choose or change the target. Read order: the user's own config
// (~/.pi/pi/config/microvm-target.v1.json) first, then the package-local
// config/microvm-target.v1.json (shipped as a REPLACE-WITH template).
const TARGET_FIELDS = new Set(["schema", "sshTarget", "local", "_comment"]);
export function loadMicroVMTarget(options = {}) {
  if (options.target && typeof options.target === "object") {
    return normalizeTarget(options.target);
  }
  const paths = [
    ...(typeof options.targetPath === "string" ? [options.targetPath] : []),
    ...(typeof options.targetUserConfigPath === "string" ? [options.targetUserConfigPath] : []),
    // A test/override seam can replace the default user-config location so
    // tests stay hermetic regardless of the developer's own machine.
    ...(typeof options.userConfigPath === "string" ? [options.userConfigPath] : [TARGET_USER_CONFIG]),
    TARGET_PACKAGE_CONFIG,
  ];
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (Object.keys(parsed).some((key) => !TARGET_FIELDS.has(key))) continue;
      if (parsed.schema !== TARGET_SCHEMA) continue;
      const normalized = normalizeTarget(parsed);
      if (!normalized) continue;
      return Object.freeze({ ...normalized, __path: path });
    } catch {
      // Missing or unreadable candidate: fall through to the next path.
    }
  }
  return null;
}

// Exactly one user decision: sshTarget XOR local:true. Returns the frozen
// normalized target or null when the decision is absent, ambiguous, or a
// REPLACE-WITH template placeholder.
function normalizeTarget(parsed) {
  const hasSshTarget = typeof parsed.sshTarget === "string" && parsed.sshTarget.trim()
    && !parsed.sshTarget.includes("REPLACE-WITH-");
  const hasLocal = parsed.local === true;
  if (hasSshTarget === hasLocal) return null;
  return Object.freeze(hasSshTarget
    ? { mode: "ssh", sshTarget: parsed.sshTarget.trim() }
    : { mode: "local" });
}

// Shape validation for the user-relayed target parameter (untrusted input).
// Accepts user@host, an ip (optionally :port), a plain hostname, or "local".
export function targetArgumentError(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return { code: "target-argument-required", detail: "Provide the target: user@host, an ip, or local." };
  }
  if (text.includes("REPLACE-WITH-")) {
    return { code: "target-argument-placeholder", detail: "Placeholder values are not valid targets." };
  }
  if (text === "local") return null;
  // Accepts a bare hostname/ssh-config alias, user@host, user@ip, ip[:port].
  // ssh config resolves aliases; the string is passed verbatim in fixed argv.
  const pattern = /^(?:[a-zA-Z0-9._-]+@)?(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::\d{1,5})?$/;
  const bareToken = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (/\s/.test(text) || (!pattern.test(text) && !bareToken.test(text))) {
    return { code: "target-argument-invalid", detail: `${JSON.stringify(text)} is not a plausible ssh target (alias, user@host, or ip) or the literal 'local'.` };
  }
  return null;
}

function targetNotConfigured() {
  return denied("blocked", reason("policy", "target-not-configured",
    "No trusted microVM target is configured. Copy config/microvm-target.v1.example.json to ~/.pi/pi/config/microvm-target.v1.json and set either sshTarget (user@host or ip of the machine that runs the microVM) or local:true (this session runs on a Linux machine). The model cannot choose the target."));
}

function parseFacts(stdout, fixtureId, target) {
  const values = {};
  for (const line of String(stdout || "").split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw phaseError("preflight", "facts-invalid", "capability probe returned a malformed fact");
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const facts = {
    host: values.host,
    arch: values.arch,
    kernel: values.kernel,
    libvirt: values.libvirt,
    qemu: values.qemu,
    qemuBinaryPath: values.qemu_binary_path,
    fixtureDomain: values.fixture_domain_name,
    fixtureDomainState: values.fixture_domain_state,
    kvmAccessible: values.kvm_accessible === "yes",
  };
  const domain = fixtureDomainForId(fixtureId);
  if (facts.fixtureDomain !== domain || facts.fixtureDomainState !== "absent") {
    throw phaseError("preflight", "facts-unexpected", "the exact fixture-domain absence check failed");
  }
  return validateFacts(facts, fixtureId);
}
// Honest safety checks over auto-discovered facts: the target must expose
// KVM, a system-level libvirt connection, and a qemu-system binary matching
// the discovered architecture. No user-predicted values are involved.
function validateFacts(facts, _fixtureId) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw phaseError("preflight", "facts-invalid", "trusted host facts are not an object");
  }
  if (typeof facts.host !== "string" || !facts.host || typeof facts.arch !== "string" || !facts.arch
      || typeof facts.kernel !== "string" || !facts.kernel || typeof facts.qemu !== "string" || !facts.qemu
      || typeof facts.libvirt !== "string" || !facts.libvirt) {
    throw phaseError("preflight", "facts-unexpected", "the target did not report a complete set of discoverable facts");
  }
  if (facts.kvmAccessible !== true) {
    throw phaseError("preflight", "kvm-unavailable", "the target does not expose an accessible /dev/kvm; hardware virtualization is required");
  }
  if (!facts.libvirt.startsWith("qemu:///system")) {
    throw phaseError("preflight", "libvirt-user-level",
      `the target libvirt connection is '${facts.libvirt}', not the system driver (qemu:///system); the microVM proof requires the system-level libvirt driver`);
  }
  // The decisive evidence is WHICH binary resolved, not an arch token inside
  // the version string (Debian builds omit it there).
  if (typeof facts.qemuBinaryPath !== "string" || !facts.qemuBinaryPath.endsWith(`qemu-system-${facts.arch}`)
      || !/^QEMU/.test(facts.qemu)) {
    throw phaseError("preflight", "qemu-binary-missing",
      `the target did not prove a working qemu-system-${facts.arch}: resolved binary '${facts.qemuBinaryPath || "(none)"}', version output '${facts.qemu.slice(0, 80)}'`);
  }
  return facts;
}
function sshProbe(execute = run, fixtureId, target) {
  const domain = fixtureDomainForId(fixtureId);
  const quotedDomain = shellQuote(domain);
  // All technical expectations are auto-discovered from the target itself;
  // validation checks honest safety properties (KVM, system libvirt driver,
  // qemu binary for the discovered arch) with no user-predicted values.
  const command = [
    "set -eu",
    "test -r /dev/kvm -a -w /dev/kvm",
    "test -x /usr/bin/qemu-system-$(uname -m)",
    "test -x /usr/bin/busybox", "test -x /usr/bin/cpio", "test -x /usr/bin/gzip",
    "test -x /usr/bin/setfacl", "test -x /usr/bin/getfacl", "test -n \"$(virsh uri)\"",
    "printf 'host=%s\\n' \"$(hostname)\"", "printf 'arch=%s\\n' \"$(uname -m)\"",
    "printf 'kernel=%s\\n' \"$(uname -r)\"", "printf 'libvirt=%s\\n' \"$(virsh uri)\"",
    `printf 'qemu_binary_path=%s\\n' "$(command -v qemu-system-$(uname -m))"`,
    `printf 'qemu=%s\\n' "$(qemu-system-$(uname -m) --version | head -1)"`,
    "printf 'kvm_accessible=%s\\n' \"$( test -r /dev/kvm -a -w /dev/kvm && echo yes || echo no )\"",
    `printf 'fixture_domain_name=%s\\n' ${quotedDomain}`,
    `if virsh dominfo ${quotedDomain} >/dev/null 2>&1; then printf 'fixture_domain_state=present\\n'; else names=$(virsh list --all --name); if printf '%s\\n' \"$names\" | grep -F -x -- ${quotedDomain} >/dev/null; then printf 'fixture_domain_state=present\\n'; else match_status=$?; if [ \"$match_status\" -eq 1 ]; then printf 'fixture_domain_state=absent\\n'; else exit 1; fi; fi; fi`,
  ].join("; ");
  const result = target.mode === "local"
    ? execute("bash", ["-c", command], { timeout: 30000 })
    : execute("ssh", [target.sshTarget, command], { timeout: 30000 });
  if (result.code !== 0) {
    const text = result.stderr || result.error || "";
    if (/\/dev\/kvm/i.test(text)) {
      throw phaseError("preflight", "kvm-unavailable", "the target does not expose an accessible /dev/kvm; hardware virtualization is required");
    }
    throw phaseError("preflight", "probe-failed", text || "configured microVM target capability probe failed");
  }
  return parseFacts(result.stdout, fixtureId, target);
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw phaseError("evidence", "receipt-invalid", `${label} fields are not closed`);
  }
}
function requireHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw phaseError("evidence", "receipt-invalid", `${label} is not a SHA-256 digest`);
  }
}
function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw phaseError("evidence", "receipt-invalid", `${label} is not boolean evidence`);
}
function parseReceipt(stdout) {
  const candidates = [];
  const unexpected = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith("AGENTIC_MICROVM_RECEIPT:")
      ? trimmed.slice("AGENTIC_MICROVM_RECEIPT:".length).trim() : trimmed;
    if (!payload.startsWith("{")) {
      unexpected.push(trimmed);
      continue;
    }
    try {
      const value = JSON.parse(payload);
      if (value?.schema === LINUX_MICROVM_CUTOVER_SCHEMA) candidates.push(value);
      else unexpected.push(trimmed);
    } catch {
      unexpected.push(trimmed);
    }
  }
  if (candidates.length === 0) {
    const detail = unexpected.length ? `structured microVM receipt was absent; output: ${unexpected.join(" ")}`
      : "structured microVM receipt was absent";
    throw phaseError("evidence", "receipt-missing", detail);
  }
  if (candidates.length !== 1) throw phaseError("evidence", "receipt-ambiguous", "multiple structured microVM receipts were returned");
  if (unexpected.length) throw phaseError("evidence", "receipt-extra-output", `unbound fixture output: ${unexpected.join(" ")}`);
  return candidates[0];
}
export function validateLinuxMicroVMReceipt(receipt, facts, fixtureId, scriptHash) {
  exactKeys(receipt, ["schema", "ok", "status", "authorityCreated", "runtimeActivated", "persisted",
    "identity", "marker", "scriptHash", "initramfsSha256", "teardown", "context"], "receipt");
  if (receipt.schema !== LINUX_MICROVM_CUTOVER_SCHEMA || receipt.ok !== true || receipt.status !== "VERIFIED"
      || receipt.authorityCreated !== false || receipt.runtimeActivated !== false || receipt.persisted !== false) {
    throw phaseError("evidence", "receipt-invalid", "receipt status or non-authorizing flags are unexpected");
  }
  const domain = fixtureDomainForId(fixtureId);
  exactKeys(receipt.identity, ["remoteHost", "fixtureId", "domain"], "receipt identity");
  if (receipt.identity.remoteHost !== facts.host || receipt.identity.fixtureId !== fixtureId || receipt.identity.domain !== domain) {
    throw phaseError("evidence", "identity-mismatch", "receipt identity does not match the reviewed fixture");
  }
  exactKeys(receipt.marker, ["value", "sha256"], "receipt marker");
  const marker = `AGENTIC_MICROVM_PROBE:${fixtureId}`;
  if (receipt.marker.value !== marker) throw phaseError("evidence", "marker-mismatch", "receipt marker does not match the fixture identity");
  requireHash(receipt.marker.sha256, "marker hash");
  if (receipt.marker.sha256 !== hash(marker)) throw phaseError("evidence", "marker-mismatch", "receipt marker hash does not match the marker");
  requireHash(receipt.scriptHash, "script hash");
  if (receipt.scriptHash !== scriptHash) throw phaseError("evidence", "payload-mismatch", "receipt script hash does not match the reviewed payload");
  requireHash(receipt.initramfsSha256, "initramfs hash");

  exactKeys(receipt.teardown, ["domain", "acl"], "receipt teardown");
  exactKeys(receipt.teardown.domain, ["name", "transient", "destroyOnExit", "destroyRequested", "absent", "checked", "check"], "domain teardown proof");
  if (receipt.teardown.domain.name !== domain || receipt.teardown.domain.transient !== true
      || receipt.teardown.domain.destroyOnExit !== true || receipt.teardown.domain.absent !== true
      || receipt.teardown.domain.checked !== true || receipt.teardown.domain.check !== "virsh dominfo/list") {
    throw phaseError("teardown", "domain-proof-invalid", "exact fixture-domain absence was not checked");
  }
  requireBoolean(receipt.teardown.domain.destroyRequested, "domain destroy request");
  exactKeys(receipt.teardown.acl, ["beforeSha256", "afterSha256", "equal", "checked", "initramfsEntryRemoved"], "ACL teardown proof");
  requireHash(receipt.teardown.acl.beforeSha256, "ACL before digest");
  requireHash(receipt.teardown.acl.afterSha256, "ACL after digest");
  if (receipt.teardown.acl.equal !== true || receipt.teardown.acl.checked !== true
      || receipt.teardown.acl.initramfsEntryRemoved !== true
      || receipt.teardown.acl.beforeSha256 !== receipt.teardown.acl.afterSha256) {
    throw phaseError("teardown", "acl-proof-invalid", "temporary ACL restoration was not checked as equal");
  }

  exactKeys(receipt.context, ["filesystem", "network", "guestMounts"], "receipt context");
  exactKeys(receipt.context.filesystem, ["summary", "disk", "hostShare", "credentials", "gpu", "sha256"], "filesystem context");
  exactKeys(receipt.context.network, ["summary", "guest", "sha256"], "network context");
  if (receipt.context.filesystem.summary !== "disk=absent host-share=absent credentials=absent gpu=absent"
      || receipt.context.filesystem.disk !== false || receipt.context.filesystem.hostShare !== false
      || receipt.context.filesystem.credentials !== false || receipt.context.filesystem.gpu !== false
      || receipt.context.network.summary !== "network=absent" || receipt.context.network.guest !== false
      || JSON.stringify(receipt.context.guestMounts) !== JSON.stringify(["proc", "sysfs", "devtmpfs"])) {
    throw phaseError("evidence", "isolation-context-invalid", "guest isolation context is unexpected");
  }
  requireHash(receipt.context.filesystem.sha256, "filesystem context hash");
  requireHash(receipt.context.network.sha256, "network context hash");
  const expectedFilesystem = hash(JSON.stringify({ disk: false, hostShare: false, credentials: false, gpu: false,
    initramfsSha256: receipt.initramfsSha256 }));
  if (receipt.context.filesystem.sha256 !== expectedFilesystem
      || receipt.context.network.sha256 !== hash(JSON.stringify({ network: false }))) {
    throw phaseError("evidence", "context-mismatch", "context digests do not match the closed isolation summary");
  }
  return receipt;
}
function normalizedForwardedStderr(result, fallbackPhase, fallbackCode, fallbackDetail) {
  const text = String(result?.stderr || "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const primary = lines.map((line) => line.match(/^microvm failure phase=([a-z0-9-]+) code=([a-z0-9-]+) detail=(.*)$/i))
    .find(Boolean);
  const cleanup = lines.map((line) => line.match(/^microvm cleanup failure code=([a-z0-9-]+) detail=(.*)$/i))
    .filter(Boolean);
  const details = [];
  if (primary) details.push(primary[3]);
  for (const match of cleanup) details.push(`cleanup: ${match[2]}`);
  if (!details.length) details.push(text || result?.error || fallbackDetail);
  return reason(primary?.[1] || (cleanup.length ? "teardown" : fallbackPhase),
    primary?.[2] || (cleanup.length ? "cleanup-failed" : fallbackCode), details.join("; "));
}

export async function runLinuxMicroVMCutover(context, options = {}) {
  // Session-scoped user switch: only the explicit enable command can set this
  // flag in memory; it never persists to settings and the model cannot set it.
  if (options.isolationSwitch?.get() !== true) {
    return denied("blocked", reason("policy", "isolation-not-enabled",
      "Isolation activation is not enabled in this session. Run the agentic-isolation-enable command in the Pi TUI."));
  }
  // Target selection: the only way user intent reaches setup is the optional
  // `target` parameter, relayed by the agent from the user's words. It is
  // untrusted: nothing is written or run without the user's native
  // confirmation dialog naming the target explicitly.
  const targetParam = typeof options.target === "string" ? options.target.trim() : "";
  if (targetParam) {
    const shapeError = targetArgumentError(targetParam);
    if (shapeError) return denied("denied", reason("input", shapeError.code, shapeError.detail));
    // Headless setups are refused: only pre-configured targets run.
    if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
      return denied("blocked", reason("policy", "native-tui-required",
        "Configuring a new microVM target requires the interactive Pi TUI; headless sessions may only use a pre-configured target."));
    }
    const writePath = options.targetUserConfigPath?.trim() || TARGET_USER_CONFIG;
    let confirmed;
    try {
      confirmed = await context.ui.confirm("Use this microVM host?", [
        `Use ${targetParam === "local" ? "THIS machine (local)" : targetParam} as the microVM host? This saves it to your Pi config.`,
        `Config file: ${writePath}`,
        "The model relayed your words; this confirmation is what authorizes the choice.",
      ].join("\n"));
    } catch (error) {
      return denied("blocked", reason("confirmation", "confirmation-failed", `Native confirmation failed: ${error.message}`));
    }
    if (confirmed !== true) {
      return denied("stopped", reason("confirmation", "not-granted", "No target was saved; native confirmation was not granted."));
    }
    const saved = targetParam === "local"
      ? { schema: TARGET_SCHEMA, local: true }
      : { schema: TARGET_SCHEMA, sshTarget: targetParam };
    try {
      mkdirSync(dirname(writePath), { recursive: true });
      writeFileSync(writePath, `${JSON.stringify(saved, null, 2)}\n`);
    } catch (error) {
      return denied("blocked", reason("policy", "target-write-failed", `Could not write ${writePath}: ${error.message}`));
    }
  }
  // Saved config (possibly just written above) drives the run; deny-by-default
  // when neither a target param nor saved config exists.
  const target = loadMicroVMTarget({
    ...options,
    ...(options.userConfigPath ? {} : { userConfigPath: options.userConfigPath }),
  });
  if (!target) {
    return denied("blocked", reason("policy", "target-not-configured",
      "No microVM target is configured. Ask the user which machine the microVM should run on and pass it as the `target` parameter (user@host, ip, or local)."));
  }
  if (!isNativeTuiContext(context)) {
    return denied("blocked", reason("policy", "native-tui-required",
      "Open the Linux microVM cutover in the interactive Pi TUI; headless runs are denied."));
  }
  if (inFlight) return denied("denied", reason("execution", "already-active", "another Linux microVM cutover is active in this host session"));

  const fixtureId = `microvm-${randomBytes(12).toString("hex")}`;
  const fixtureDomain = fixtureDomainForId(fixtureId);
  let script;
  let scriptHash;
  try {
    script = readFileSync(REMOTE_FIXTURE, "utf8");
    scriptHash = hash(script);
  } catch (error) {
    return denied("denied", reasonFromError(error, "payload", "payload-read-failed"));
  }
  const execute = options.execute || run;
  const observe = options.observeFacts || ((executeArg, id) => sshProbe(executeArg, id, target));
  let facts;
  try { facts = validateFacts(observe(execute, fixtureId), fixtureId); }
  catch (error) { return denied("denied", reasonFromError(error, "preflight", "facts-observation-failed")); }
  const body = [
    "Run one live transient QEMU/KVM microVM proof on the configured trusted target?",
    `Target: ${target.mode === "local" ? "this machine (local)" : target.sshTarget} — discovered host: ${facts.host} (${facts.arch}, kernel ${facts.kernel})`,
    `Backend: ${facts.libvirt}; ${facts.qemu}`,
    `Fixture: ${fixtureId}; domain: ${fixtureDomain} (preflight absent)`,
    `Versioned fixture SHA-256: ${scriptHash}`,
    "Writes: one generated fixture below ~/agentic-driver-state/cutover-fixtures/microvm/.",
    "Guest: 1 vCPU, 128 MiB, BusyBox initramfs, no disk, network, host share, credentials, GPU, or serving access.",
    "A temporary traverse-only ACL for libvirt-qemu is added to the remote home directory and the exact prior ACL is restored after exit or failure.",
    "The transient domain prints one marker, powers off, and must disappear from libvirt.",
    "No install, download, repository mutation, runtime authority, staging, commit, or push.",
  ].join("\n");
  let confirmed;
  try { confirmed = await context.ui.confirm("Verify Linux microVM isolation", body); }
  catch (error) { return denied("blocked", reason("confirmation", "confirmation-failed", `Native confirmation failed: ${error.message}`)); }
  if (confirmed !== true) return denied("stopped", reason("confirmation", "not-granted", "Native confirmation was not granted."));

  let current;
  try { current = validateFacts(observe(execute, fixtureId), fixtureId); }
  catch (error) { return denied("denied", reason("reobserve", "facts-observation-failed", `MicroVM facts changed: ${error.message}`)); }
  if (JSON.stringify(current) !== JSON.stringify(facts)) {
    return denied("denied", reason("reobserve", "facts-changed", "MicroVM facts changed after confirmation"));
  }
  inFlight = true;
  try {
    const result = target.mode === "local"
      ? execute("bash", ["-c", "bash -s -- " + shellQuote(fixtureId) + " " + shellQuote(scriptHash)], { input: script, timeout: 180000 })
      : execute("ssh", [target.sshTarget, "bash", "-s", "--", fixtureId, scriptHash], { input: script, timeout: 180000 });
    if (!result || result.code !== 0) {
      return denied("blocked", normalizedForwardedStderr(result, "fixture", "execution-failed", "fixed microVM fixture failed"));
    }
    const receipt = parseReceipt(result.stdout);
    return validateLinuxMicroVMReceipt(receipt, facts, fixtureId, scriptHash);
  } catch (error) {
    return denied("blocked", reasonFromError(error, "execution", "fixture-failed"));
  } finally { inFlight = false; }
}
function commandArgumentsPresent(args) {
  if (args === undefined || args === null) return false;
  if (typeof args === "string") return args.trim().length > 0;
  if (Array.isArray(args)) return args.some((value) => String(value).trim().length > 0);
  return Object.keys(args).length > 0;
}
export function registerLinuxMicroVMCutoverInterface(pi, options = {}) {
  if (typeof pi?.registerTool !== "function" || REGISTRATIONS.has(pi)) return;
  REGISTRATIONS.add(pi);
  // Prominent outcome presentation. The first line of the tool output is a
  // concise final status (VERIFIED / DENIED / STOPPED / BLOCKED) with fixture
  // id and one-line evidence or reason summary; the full JSON receipt follows
  // unchanged. When the interactive TUI exposes the notify surface, the same
  // status is raised as a fire-and-forget notification.
  const outcomeLine = (value) => {
    if (value?.ok === true && value?.status === "VERIFIED") {
      return `MICROVM CUTOVER: VERIFIED — fixture ${value.identity?.fixtureId ?? "unknown"} on ${value.identity?.remoteHost ?? "unknown host"}; domain ${value.identity?.domain ?? "?"} transient+gone, teardown proofed, isolation context closed.`;
    }
    const status = String(value?.status ?? "DENIED").toUpperCase();
    const code = value?.reason?.code ?? value?.code ?? "unknown";
    const detail = value?.reason?.detail ?? value?.error ?? "";
    return `MICROVM CUTOVER: ${status} — reason ${code}${detail ? `: ${detail}` : ""}`;
  };
  const notifyOutcome = (context, value) => {
    const notify = context?.ui?.notify;
    if (typeof notify !== "function") return;
    const line = outcomeLine(value);
    notify(line, value?.ok === true ? "info" : value?.status === "stopped" ? "warning" : "error");
  };
  const execute = async (_id, params, _signal, _update, context) => {
    const closedParams = params && typeof params === "object" && !Array.isArray(params)
      ? Object.keys(params).filter((key) => key !== "target")
      : [];
    const value = closedParams.length
      ? denied("denied", reason("input", "model-parameters-not-allowed", "Linux microVM cutover accepts only the optional target parameter"))
      : await runLinuxMicroVMCutover(context, {
          ...options,
          ...(typeof params?.target === "string" ? { target: params.target } : {}),
        });
    notifyOutcome(context, value);
    return { content: [{ type: "text", text: `${outcomeLine(value)}\n${JSON.stringify(value, null, 2)}` }], details: value };
  };
  pi.registerTool({ name: LINUX_MICROVM_CUTOVER_TOOL, label: "Verify Linux microVM",
    description: "Run one native-confirmed transient QEMU/KVM microVM proof on the trusted target. The optional target parameter (user@host, ip, or local) relays the user's machine choice; saving a new target requires the user's native confirmation. Requires the session isolation switch.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", maxLength: 255, description: "Where the microVM runs: user@host, an ip, or the literal local. Relays the user's explicit choice; a new target is saved only after the user's native confirmation." },
      },
    }, execute });
  pi.registerCommand?.("agentic-linux-microvm-cutover", { description: "Run the native-confirmed Linux microVM proof",
    handler: async (args, context) => commandArgumentsPresent(args)
      ? denied("denied", reason("input", "command-arguments-not-allowed", "Linux microVM cutover accepts no command arguments"))
      : (await execute("command", {}, undefined, undefined, context)).details });
}

// Session-scoped isolation switch commands. The flag lives only in this
// module's memory: the model has no tool to set or read it, it is never
// written to settings, and each command itself requires a native TUI
// confirmation. Disabling always succeeds once confirmed; enabling requires
// the interactive Pi TUI.
const ISOLATION_ENABLE_COMMAND = "agentic-isolation-enable";
const ISOLATION_DISABLE_COMMAND = "agentic-isolation-disable";
export const ISOLATION_COMMANDS = { enable: ISOLATION_ENABLE_COMMAND, disable: ISOLATION_DISABLE_COMMAND };

export function registerIsolationSwitchCommands(pi, options = {}) {
  if (typeof pi?.registerCommand !== "function" || SWITCH_REGISTRATIONS.has(pi)) return;
  SWITCH_REGISTRATIONS.add(pi);
  // Fresh, registration-scoped switch state: a new registration starts disabled.
  const isolationSwitch = options.isolationSwitch ?? createIsolationSwitch();
  const switchNotice = () => isolationSwitch.get()
    ? "Isolation activation is ENABLED for this session only. It does not persist to settings and resets when the session ends."
    : "Isolation activation is DISABLED. No microVM proof can run in this session until it is enabled.";
  const switchResult = (ok, status, code, detail) => ({
    schema: LINUX_MICROVM_CUTOVER_SCHEMA, ok, status,
    reason: ok ? undefined : reason("policy", code, detail),
    isolationEnabled: isolationSwitch.get(),
    persisted: false,
  });
  const rejectArguments = () => switchResult(false, "denied", "command-arguments-not-allowed",
    "The isolation switch commands accept no command arguments.");
  pi.registerCommand(ISOLATION_ENABLE_COMMAND, {
    description: "Enable the Linux microVM isolation switch for this session (native confirmation required)",
    handler: async (args, context) => {
      if (commandArgumentsPresent(args)) return rejectArguments();
      if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
        return switchResult(false, "blocked", "native-tui-required",
          "Open the interactive Pi TUI to enable isolation; headless sessions cannot enable it.");
      }
      if (isolationSwitch.get()) {
        return switchResult(true, "ALREADY_ENABLED", "", "");
      }
      let confirmed;
      try {
        confirmed = await context.ui.confirm("Enable Linux microVM isolation", [
          "Enable the isolation-activation switch for this session?",
          switchNotice(),
          "Effect: the agentic_linux_microvm_cutover tool may run one native-confirmed transient QEMU/KVM microVM proof on the configured trusted target per invocation.",
          "The switch is session-scoped: it never persists to settings and the model cannot change it.",
        ].join("\n"));
      } catch (error) {
        return switchResult(false, "blocked", "confirmation-failed", `Native confirmation failed: ${error.message}`);
      }
      if (confirmed !== true) {
        return switchResult(false, "stopped", "not-granted", "Isolation activation was not enabled; native confirmation was not granted.");
      }
      isolationSwitch.set(true);
      return switchResult(true, "ENABLED", "", "");
    },
  });
  pi.registerCommand(ISOLATION_DISABLE_COMMAND, {
    description: "Disable the Linux microVM isolation switch for this session (native confirmation required)",
    handler: async (args, context) => {
      if (commandArgumentsPresent(args)) return rejectArguments();
      if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
        return switchResult(false, "blocked", "native-tui-required",
          "Open the interactive Pi TUI to disable isolation; headless sessions cannot change the switch.");
      }
      let confirmed;
      try {
        confirmed = await context.ui.confirm("Disable Linux microVM isolation", [
          "Disable the isolation-activation switch for this session?",
          switchNotice(),
        ].join("\n"));
      } catch (error) {
        return switchResult(false, "blocked", "confirmation-failed", `Native confirmation failed: ${error.message}`);
      }
      if (confirmed !== true) {
        return switchResult(false, "stopped", "not-granted", "Isolation activation remains enabled; native confirmation was not granted.");
      }
      isolationSwitch.set(false);
      return switchResult(true, "DISABLED", "", "");
    },
  });
  return isolationSwitch;
}
export default registerLinuxMicroVMCutoverInterface;
