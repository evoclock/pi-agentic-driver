// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isNativeTuiContext } from "./native_tui_context.js";

export const LINUX_MICROVM_CUTOVER_TOOL = "agentic_linux_microvm_cutover";
export const LINUX_MICROVM_CUTOVER_SCHEMA = "agentic-driver.linux-microvm-cutover.v1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REMOTE_FIXTURE = join(SCRIPT_DIR, "linux_microvm_remote_fixture.sh");
const REGISTRATIONS = new WeakSet();
const PLANNED_ISOLATION_MODES = new Set(["planned", "planned-interactive", "planned-autonomous"]);
const HASH = /^[0-9a-f]{64}$/;
const MAX_DETAIL = 512;
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
function parseFacts(stdout, fixtureId) {
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
    fixtureDomain: values.fixture_domain_name,
    fixtureDomainState: values.fixture_domain_state,
  };
  const domain = fixtureDomainForId(fixtureId);
  if (facts.host !== "ubuntu-backend" || facts.arch !== "x86_64" || facts.libvirt !== "qemu:///system"
      || facts.fixtureDomain !== domain || facts.fixtureDomainState !== "absent"
      || typeof facts.kernel !== "string" || !facts.kernel
      || typeof facts.qemu !== "string" || !facts.qemu) {
    throw phaseError("preflight", "facts-unexpected", "fixed host facts or the exact fixture-domain absence check failed");
  }
  return facts;
}
function sshProbe(execute = run, fixtureId) {
  const domain = fixtureDomainForId(fixtureId);
  const quotedDomain = shellQuote(domain);
  const command = [
    "set -eu", "test \"$(uname -m)\" = x86_64", "test -r /dev/kvm -a -w /dev/kvm",
    "test -x /usr/bin/qemu-system-x86_64", "test -x /usr/bin/busybox",
    "test -x /usr/bin/cpio", "test -x /usr/bin/gzip", "test -x /usr/bin/setfacl",
    "test -x /usr/bin/getfacl", "test -n \"$(virsh uri)\"",
    "printf 'host=%s\\n' \"$(hostname)\"", "printf 'arch=%s\\n' \"$(uname -m)\"",
    "printf 'kernel=%s\\n' \"$(uname -r)\"", "printf 'libvirt=%s\\n' \"$(virsh uri)\"",
    "printf 'qemu=%s\\n' \"$(qemu-system-x86_64 --version | head -1)\"",
    `printf 'fixture_domain_name=%s\\n' ${quotedDomain}`,
    `if virsh dominfo ${quotedDomain} >/dev/null 2>&1; then printf 'fixture_domain_state=present\\n'; else names=$(virsh list --all --name); if printf '%s\\n' \"$names\" | grep -F -x -- ${quotedDomain} >/dev/null; then printf 'fixture_domain_state=present\\n'; else match_status=$?; if [ \"$match_status\" -eq 1 ]; then printf 'fixture_domain_state=absent\\n'; else exit 1; fi; fi; fi`,
  ].join("; ");
  const result = execute("ssh", ["linux-backend", command], { timeout: 30000 });
  if (result.code !== 0) {
    throw phaseError("preflight", "probe-failed", result.stderr || result.error || "fixed linux-backend capability probe failed");
  }
  return parseFacts(result.stdout, fixtureId);
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
function validateFacts(facts, fixtureId) {
  const domain = fixtureDomainForId(fixtureId);
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw phaseError("preflight", "facts-invalid", "trusted host facts are not an object");
  }
  if (facts.host !== "ubuntu-backend" || facts.arch !== "x86_64" || facts.libvirt !== "qemu:///system"
      || facts.fixtureDomain !== domain || facts.fixtureDomainState !== "absent"
      || typeof facts.kernel !== "string" || !facts.kernel || typeof facts.qemu !== "string" || !facts.qemu) {
    throw phaseError("preflight", "facts-unexpected", "fixed host facts or the exact fixture-domain absence check failed");
  }
  return facts;
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
  if (!PLANNED_ISOLATION_MODES.has(options.workMode)) {
    return denied("blocked", reason("policy", "planned-isolation-required", "Linux microVM execution is reserved for planned or automated work."));
  }
  const isolationEnabled = options.isolationEnabled ?? options.runtime?.isolationEnabled;
  if (isolationEnabled !== true) {
    return denied("blocked", reason("policy", "planned-isolation-not-enabled", "The planned isolation execution path is not enabled yet."));
  }
  if (!isNativeTuiContext(context) || typeof context?.ui?.confirm !== "function") {
    return denied("blocked", reason("policy", "native-tui-required", "Open the Linux microVM cutover in the interactive Pi TUI."));
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
  const observe = options.observeFacts || ((executeArg, id) => sshProbe(executeArg, id));
  let facts;
  try { facts = validateFacts(observe(execute, fixtureId), fixtureId); }
  catch (error) { return denied("denied", reasonFromError(error, "preflight", "facts-observation-failed")); }
  const body = [
    "Run one live transient QEMU/KVM microVM proof on linux-backend?",
    `Remote host: ${facts.host} (${facts.arch}, kernel ${facts.kernel})`,
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
    const result = execute("ssh", ["linux-backend", "bash", "-s", "--", fixtureId, scriptHash], { input: script, timeout: 180000 });
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
  const execute = async (_id, params, _signal, _update, context) => {
    const value = params && Object.keys(params).length
      ? denied("denied", reason("input", "model-parameters-not-allowed", "Linux microVM cutover accepts no model parameters"))
      : await runLinuxMicroVMCutover(context, {
          ...options,
          workMode: options.runtime?.workMode,
          isolationEnabled: options.runtime?.isolationEnabled,
        });
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
  };
  pi.registerTool({ name: LINUX_MICROVM_CUTOVER_TOOL, label: "Verify Linux microVM",
    description: "Run one native-confirmed transient QEMU/KVM microVM proof on linux-backend.",
    parameters: { type: "object", additionalProperties: false, properties: {} }, execute });
  pi.registerCommand?.("agentic-linux-microvm-cutover", { description: "Run the native-confirmed Linux microVM proof",
    handler: async (args, context) => commandArgumentsPresent(args)
      ? denied("denied", reason("input", "command-arguments-not-allowed", "Linux microVM cutover accepts no command arguments"))
      : (await execute("command", {}, undefined, undefined, context)).details });
}
export default registerLinuxMicroVMCutoverInterface;
