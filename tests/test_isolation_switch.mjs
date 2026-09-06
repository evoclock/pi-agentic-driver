// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  registerLinuxMicroVMCutoverInterface,
  registerIsolationSwitchCommands,
  runLinuxMicroVMCutover,
  LINUX_MICROVM_CUTOVER_SCHEMA,
  isolationSwitch,
} from "../scripts/enforcement/linux_microvm_cutover_pi.js";
import registerLinuxMicroVMCutover from "../extensions/linux-microvm.ts";

const INITRAMFS = "a".repeat(64);

function stubFacts(fixtureId) {
  return {
    host: "ubuntu-backend", arch: "x86_64", kernel: "6.8.0-generic",
    libvirt: "qemu:///system", qemu: "QEMU stub 8.0",
    fixtureDomain: `agentic-driver-${fixtureId}`, fixtureDomainState: "absent",
  };
}

function stubReceipt(fixtureId, scriptHash) {
  const domain = `agentic-driver-${fixtureId}`;
  const marker = `AGENTIC_MICROVM_PROBE:${fixtureId}`;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return {
    schema: LINUX_MICROVM_CUTOVER_SCHEMA, ok: true, status: "VERIFIED",
    authorityCreated: false, runtimeActivated: false, persisted: false,
    identity: { remoteHost: "ubuntu-backend", fixtureId, domain },
    marker: { value: marker, sha256: digest(marker) },
    scriptHash, initramfsSha256: INITRAMFS,
    teardown: {
      domain: { name: domain, transient: true, destroyOnExit: true, destroyRequested: true, absent: true, checked: true, check: "virsh dominfo/list" },
      acl: { beforeSha256: "b".repeat(64), afterSha256: "b".repeat(64), equal: true, checked: true, initramfsEntryRemoved: true },
    },
    context: {
      filesystem: { summary: "disk=absent host-share=absent credentials=absent gpu=absent",
        disk: false, hostShare: false, credentials: false, gpu: false,
        sha256: digest(JSON.stringify({ disk: false, hostShare: false, credentials: false, gpu: false, initramfsSha256: INITRAMFS })) },
      network: { summary: "network=absent", guest: false, sha256: digest(JSON.stringify({ network: false })) },
      guestMounts: ["proc", "sysfs", "devtmpfs"],
    },
  };
}

// Runs the cutover with injected facts observation and a structured receipt
// stub derived from the real invocation arguments; no ssh, no network, no
// real remote execution.
function stubEnvironment({ confirm = async () => true, factsSequence } = {}) {
  let observed = 0;
  let lastFixtureId;
  const observe = (_execute, fixtureId) => {
    lastFixtureId = fixtureId;
    const value = Array.isArray(factsSequence) ? factsSequence[Math.min(observed, factsSequence.length - 1)](fixtureId) : stubFacts(fixtureId);
    observed += 1;
    return structuredClone(value);
  };
  const execute = (executable, args) => {
    if (executable === "ssh" && args[0] === "linux-backend" && args[1] === "bash"
        && args[2] === "-s" && args[3] === "--") {
      const [, , , , fixtureId, scriptHash] = args;
      return { code: 0, stdout: `AGENTIC_MICROVM_RECEIPT: ${JSON.stringify(stubReceipt(fixtureId, scriptHash))}\n`, stderr: "", error: undefined };
    }
    return { code: 0, stdout: "", stderr: "", error: undefined };
  };
  const context = { mode: "tui", hasUI: true, ui: { confirm } };
  return { context, options: { execute, observeFacts: observe }, lastFixtureId: () => lastFixtureId };
}

function harness() {
  const commands = {};
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => { commands[name] = def; },
  };
  registerLinuxMicroVMCutoverInterface(pi);
  registerIsolationSwitchCommands(pi);
  const run = async (name, context) => commands[name].handler("", context);
  return { commands, run };
}

const HEADLESS = { mode: "print" };
const tuiContext = () => ({ mode: "tui", hasUI: true, ui: { confirm: async () => true } });

test("switch starts disabled and cutover fails closed before any confirmation", async () => {
  assert.equal(isolationSwitch.enabled, false);
  const { context, options } = stubEnvironment();
  const value = await runLinuxMicroVMCutover(context, options);
  assert.equal(value.ok, false);
  assert.equal(value.status, "blocked");
  assert.equal(value.reason.code, "isolation-not-enabled");
});

test("headless enable is denied and never flips the switch", async () => {
  const { run } = harness();
  const value = await run("agentic-isolation-enable", HEADLESS);
  assert.equal(value.ok, false);
  assert.equal(value.reason.code, "native-tui-required");
  assert.equal(value.isolationEnabled, false);
  assert.equal(value.persisted, false);
  assert.equal(isolationSwitch.enabled, false);
});

test("declined native confirmation leaves the switch disabled", async () => {
  const { run } = harness();
  const value = await run("agentic-isolation-enable", { mode: "tui", hasUI: true, ui: { confirm: async () => false } });
  assert.equal(value.ok, false);
  assert.equal(value.status, "stopped");
  assert.equal(value.reason.code, "not-granted");
  assert.equal(isolationSwitch.enabled, false);
});

test("enable with native confirmation sets the session-scoped flag only", async () => {
  const { run } = harness();
  const value = await run("agentic-isolation-enable", tuiContext());
  assert.equal(value.ok, true);
  assert.equal(value.status, "ENABLED");
  assert.equal(value.persisted, false);
  assert.equal(isolationSwitch.enabled, true);
  const again = await run("agentic-isolation-enable", tuiContext());
  assert.equal(again.status, "ALREADY_ENABLED");
});

test("run requires the enabled switch, native TUI, and confirmation; receipt validates", async () => {
  const { run } = harness();
  await run("agentic-isolation-enable", tuiContext());
  const headless = await runLinuxMicroVMCutover(HEADLESS, stubEnvironment().options);
  assert.equal(headless.ok, false);
  assert.equal(headless.reason.code, "native-tui-required");

  const declined = stubEnvironment({ confirm: async () => false });
  const declinedValue = await runLinuxMicroVMCutover(declined.context, declined.options);
  assert.equal(declinedValue.ok, false);
  assert.equal(declinedValue.status, "stopped");
  assert.equal(declinedValue.reason.code, "not-granted");

  const changed = stubEnvironment({ factsSequence: [stubFacts, (id) => ({ ...stubFacts(id), kernel: "6.9.0-generic" })] });
  const changedValue = await runLinuxMicroVMCutover(changed.context, changed.options);
  assert.equal(changedValue.ok, false);
  assert.equal(changedValue.reason.code, "facts-changed");

  const happy = stubEnvironment();
  const receipt = await runLinuxMicroVMCutover(happy.context, happy.options);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, "VERIFIED");
  assert.equal(receipt.identity.fixtureId, happy.lastFixtureId());
  assert.equal(receipt.persisted, false);
  assert.equal(receipt.authorityCreated, false);
  assert.equal(receipt.runtimeActivated, false);
});

test("disable with native confirmation clears the switch and cutover fails closed again", async () => {
  const { run } = harness();
  await run("agentic-isolation-enable", tuiContext());
  assert.equal(isolationSwitch.enabled, true);
  const headless = await run("agentic-isolation-disable", HEADLESS);
  assert.equal(headless.ok, false);
  assert.equal(headless.reason.code, "native-tui-required");
  assert.equal(isolationSwitch.enabled, true);
  const value = await run("agentic-isolation-disable", tuiContext());
  assert.equal(value.ok, true);
  assert.equal(value.status, "DISABLED");
  assert.equal(value.persisted, false);
  assert.equal(isolationSwitch.enabled, false);
  const { context, options } = stubEnvironment();
  const blocked = await runLinuxMicroVMCutover(context, options);
  assert.equal(blocked.reason.code, "isolation-not-enabled");
});

test("public registration ships the switch commands and never agentic_work_mode", () => {
  const commands = {};
  const pi = {
    registerTool: () => {},
    registerCommand: (name) => { commands[name] = true; },
  };
  registerLinuxMicroVMCutover(pi);
  assert.equal(commands["agentic-isolation-enable"], true);
  assert.equal(commands["agentic-isolation-disable"], true);
  assert.equal(Object.keys(commands).includes("agentic-work-mode"), false);
});
