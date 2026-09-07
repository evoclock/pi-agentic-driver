// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  registerLinuxMicroVMCutoverInterface,
  registerIsolationSwitchCommands,
  runLinuxMicroVMCutover,
  LINUX_MICROVM_CUTOVER_TOOL,
  LINUX_MICROVM_CUTOVER_SCHEMA,
  createIsolationSwitch,
} from "../scripts/enforcement/linux_microvm_cutover_pi.js";
import registerLinuxMicroVMCutover from "../extensions/linux-microvm.ts";

const INITRAMFS = "a".repeat(64);

function stubFacts(fixtureId, host = "test-microvm-host") {
  return {
    host, arch: "x86_64", kernel: "6.8.0-generic",
    libvirt: "qemu:///system", qemu: "QEMU stub 8.0",
    fixtureDomain: `agentic-driver-${fixtureId}`, fixtureDomainState: "absent",
  };
}

function stubReceipt(fixtureId, scriptHash, host = "test-microvm-host") {
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
function stubEnvironment({ confirm = async () => true, factsSequence, isolationSwitch, host = "test-microvm-host" } = {}) {
  let observed = 0;
  let lastFixtureId;
  const target = Object.freeze({
    schema: "agentic-driver.microvm-target.v1",
    host,
    expectedArch: "x86_64",
    libvirtUri: "qemu:///system",
    expectedKernelPrefix: "6.",
  });
  const observe = (_execute, fixtureId) => {
    lastFixtureId = fixtureId;
    const value = Array.isArray(factsSequence) ? factsSequence[Math.min(observed, factsSequence.length - 1)](fixtureId) : stubFacts(fixtureId, host);
    observed += 1;
    return structuredClone(value);
  };
  const execute = (executable, args) => {
    if (executable === "ssh" && args[0] === host && args[1] === "bash"
        && args[2] === "-s" && args[3] === "--") {
      const [, , , , fixtureId, scriptHash] = args;
      return { code: 0, stdout: `AGENTIC_MICROVM_RECEIPT: ${JSON.stringify(stubReceipt(fixtureId, scriptHash, host))}\n`, stderr: "", error: undefined };
    }
    return { code: 0, stdout: "", stderr: "", error: undefined };
  };
  const context = { mode: "tui", hasUI: true, ui: { confirm } };
  return { context, options: { execute, observeFacts: observe, isolationSwitch, target }, lastFixtureId: () => lastFixtureId, target };
}

function harness() {
  const commands = {};
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => { commands[name] = def; },
  };
  const switchState = createIsolationSwitch();
  const stub = stubEnvironment({ isolationSwitch: switchState });
  registerIsolationSwitchCommands(pi, { isolationSwitch: switchState });
  registerLinuxMicroVMCutoverInterface(pi, {
    isolationSwitch: switchState,
    target: stub.target,
    execute: stub.options.execute,
    observeFacts: stub.options.observeFacts,
  });
  const run = async (name, context, args = "") => commands[name].handler(args, context);
  return { commands, run, switchState };
}

const HEADLESS = { mode: "print" };
const tuiContext = () => ({ mode: "tui", hasUI: true, ui: { confirm: async () => true } });

test("switch starts disabled and cutover fails closed before any confirmation", async () => {
  const { run, switchState } = harness();
  assert.equal(switchState.get(), false);
  const { context, options } = stubEnvironment();
  const value = await runLinuxMicroVMCutover(context, options);
  assert.equal(value.ok, false);
  assert.equal(value.status, "blocked");
  assert.equal(value.reason.code, "isolation-not-enabled");
});

test("headless enable is denied and never flips the switch", async () => {
  const { run, switchState } = harness();
  const value = await run("agentic-isolation-enable", HEADLESS);
  assert.equal(value.ok, false);
  assert.equal(value.reason.code, "native-tui-required");
  assert.equal(value.isolationEnabled, false);
  assert.equal(value.persisted, false);
  assert.equal(switchState.get(), false);
});

test("declined native confirmation leaves the switch disabled", async () => {
  const { run, switchState } = harness();
  const value = await run("agentic-isolation-enable", { mode: "tui", hasUI: true, ui: { confirm: async () => false } });
  assert.equal(value.ok, false);
  assert.equal(value.status, "stopped");
  assert.equal(value.reason.code, "not-granted");
  assert.equal(switchState.get(), false);
});

test("enable with native confirmation sets the session-scoped flag only", async () => {
  const { run, switchState } = harness();
  const value = await run("agentic-isolation-enable", tuiContext());
  assert.equal(value.ok, true);
  assert.equal(value.status, "ENABLED");
  assert.equal(value.persisted, false);
  assert.equal(switchState.get(), true);
  const again = await run("agentic-isolation-enable", tuiContext());
  assert.equal(again.status, "ALREADY_ENABLED");
});

test("run requires the enabled switch, native TUI, and confirmation; receipt validates", async () => {
  const { run, switchState } = harness();
  await run("agentic-isolation-enable", tuiContext());
  const headless = await runLinuxMicroVMCutover(HEADLESS, stubEnvironment({ isolationSwitch: switchState }).options);
  assert.equal(headless.ok, false);
  assert.equal(headless.reason.code, "native-tui-required");
  const disabledAgain = await run("agentic-isolation-disable", tuiContext());
  assert.equal(disabledAgain.ok, true);
  await run("agentic-isolation-enable", tuiContext());

  const declined = stubEnvironment({ confirm: async () => false, isolationSwitch: switchState });
  const declinedValue = await runLinuxMicroVMCutover(declined.context, declined.options);
  assert.equal(declinedValue.ok, false);
  assert.equal(declinedValue.status, "stopped");
  assert.equal(declinedValue.reason.code, "not-granted");

  const changed = stubEnvironment({ factsSequence: [stubFacts, (id) => ({ ...stubFacts(id), kernel: "6.9.0-generic" })], isolationSwitch: switchState });
  const changedValue = await runLinuxMicroVMCutover(changed.context, changed.options);
  assert.equal(changedValue.ok, false);
  assert.equal(changedValue.reason.code, "facts-changed");

  const happy = stubEnvironment({ isolationSwitch: switchState });
  const receipt = await runLinuxMicroVMCutover(happy.context, happy.options);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, "VERIFIED");
  assert.equal(receipt.identity.fixtureId, happy.lastFixtureId());
  assert.equal(receipt.persisted, false);
  assert.equal(receipt.authorityCreated, false);
  assert.equal(receipt.runtimeActivated, false);
});

test("disable with native confirmation clears the switch and cutover fails closed again", async () => {
  const { run, switchState } = harness();
  await run("agentic-isolation-enable", tuiContext());
  assert.equal(switchState.get(), true);
  const headless = await run("agentic-isolation-disable", HEADLESS);
  assert.equal(headless.ok, false);
  assert.equal(headless.reason.code, "native-tui-required");
  assert.equal(switchState.get(), true);
  const value = await run("agentic-isolation-disable", tuiContext());
  assert.equal(value.ok, true);
  assert.equal(value.status, "DISABLED");
  assert.equal(value.persisted, false);
  assert.equal(switchState.get(), false);
  const { context, options } = stubEnvironment({ isolationSwitch: switchState });
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

test("isolation switch commands reject non-empty arguments", async () => {
  const { run, switchState } = harness();
  for (const args of ["extra", "  spaced  ", ["a"], { key: "v" }]) {
    const enabled = await run("agentic-isolation-enable", tuiContext(), args);
    assert.equal(enabled.ok, false, `enable args: ${JSON.stringify(args)}`);
    assert.equal(enabled.status, "denied");
    assert.equal(enabled.reason.code, "command-arguments-not-allowed");
    assert.equal(switchState.get(), false);
    const disabled = await run("agentic-isolation-disable", tuiContext(), args);
    assert.equal(disabled.ok, false, `disable args: ${JSON.stringify(args)}`);
    assert.equal(disabled.status, "denied");
    assert.equal(disabled.reason.code, "command-arguments-not-allowed");
  }
  // Empty arguments stay accepted (headless still blocked, but not by arguments).
  const empty = await run("agentic-isolation-enable", HEADLESS, "");
  assert.equal(empty.reason.code, "native-tui-required");
});

test("a second registration in the same process starts with a fresh disabled switch", async () => {
  const first = harness();
  await first.run("agentic-isolation-enable", tuiContext());
  assert.equal(first.switchState.get(), true);

  const second = harness();
  assert.equal(second.switchState.get(), false, "fresh registration must start disabled");
  const blocked = await runLinuxMicroVMCutover(stubEnvironment({ isolationSwitch: second.switchState }).context, stubEnvironment({ isolationSwitch: second.switchState }).options);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason.code, "isolation-not-enabled");

  // Enabling the second instance must not affect the first.
  await second.run("agentic-isolation-enable", tuiContext());
  assert.equal(second.switchState.get(), true);
  assert.equal(first.switchState.get(), true);
  await first.run("agentic-isolation-disable", tuiContext());
  assert.equal(first.switchState.get(), false);
  assert.equal(second.switchState.get(), true, "first-instance disable must not leak into the second");
});

test("cutover tool output opens with a prominent VERIFIED status line and keeps the full JSON receipt", async () => {
  const { run, switchState } = harness();
  await run("agentic-isolation-enable", tuiContext());
  const notifications = [];
  const stub = stubEnvironment({ isolationSwitch: switchState });
  const context = { mode: "tui", hasUI: true, cwd: process.cwd(), ui: { confirm: async () => true, notify: (message, type) => notifications.push({ message, type }) } };
  const value = await runLinuxMicroVMCutover(context, stub.options);
  assert.equal(value.ok, true);
  assert.equal(value.status, "VERIFIED");

  // The command path returns the receipt details unchanged.
  const notificationsCommand = [];
  const commandContext = { ...context, ui: { confirm: context.ui.confirm, notify: (message, type) => notificationsCommand.push({ message, type }) } };
  const commandValue = await run("agentic-linux-microvm-cutover", commandContext);
  assert.equal(commandValue.ok, true);

  // Reconstruct the tool output text exactly as registerTool does.
  const registered = {};
  const pi = { registerTool: (tool) => { registered[tool.name] = tool; }, registerCommand: () => {} };
  registerLinuxMicroVMCutoverInterface(pi, {
    isolationSwitch: switchState,
    target: stub.target,
    execute: stub.options.execute,
    observeFacts: stub.options.observeFacts,
  });
  const result = await registered[LINUX_MICROVM_CUTOVER_TOOL].execute("t", {}, undefined, undefined, context);
  const text = result.content[0].text;
  const firstLine = text.split("\n")[0];
  assert.match(firstLine, /^MICROVM CUTOVER: VERIFIED — fixture /);
  assert.match(firstLine, /domain agentic-driver-microvm-/);
  assert.match(firstLine, /isolation context closed/);
  // The full JSON receipt is intact below the status line.
  const json = JSON.parse(text.slice(text.indexOf("{")));
  assert.deepEqual(json, result.details);
  assert.equal(json.status, "VERIFIED");
  assert.equal(json.ok, true);
  assert.ok(json.identity.fixtureId);
  assert.ok(json.marker.sha256);
  assert.ok(json.teardown.domain.absent);
  // The notify surface receives the same outcome, fire-and-forget.
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /^MICROVM CUTOVER: VERIFIED/);
  assert.equal(notifications[0].type, "info");
  void commandValue; void notificationsCommand;
});

test("denial outcomes produce a prominent status line with the reason code", async () => {
  const { registerLinuxMicroVMCutoverInterface } = await import("../scripts/enforcement/linux_microvm_cutover_pi.js");
  const switchState = createIsolationSwitch();
  const registered = {};
  const pi = { registerTool: (tool) => { registered[tool.name] = tool; }, registerCommand: () => {} };
  const stub = stubEnvironment({ isolationSwitch: switchState });
  registerLinuxMicroVMCutoverInterface(pi, { isolationSwitch: switchState, target: stub.target, execute: stub.options.execute, observeFacts: stub.options.observeFacts });

  // Switch off: blocked with reason code isolation-not-enabled.
  const blocked = await registered[LINUX_MICROVM_CUTOVER_TOOL].execute("t", {}, undefined, undefined, tuiContext());
  const blockedText = blocked.content[0].text;
  assert.match(blockedText.split("\n")[0], /^MICROVM CUTOVER: BLOCKED — reason isolation-not-enabled/);
  assert.deepEqual(JSON.parse(blockedText.slice(blockedText.indexOf("{"))), blocked.details);

  // Native confirmation declined: stopped with reason not-granted.
  await (await import("../scripts/enforcement/linux_microvm_cutover_pi.js")).registerIsolationSwitchCommands;
  const enableCommands = {};
  const pi2 = { registerTool: () => {}, registerCommand: (name, def) => { enableCommands[name] = def; } };
  (await import("../scripts/enforcement/linux_microvm_cutover_pi.js")).registerIsolationSwitchCommands(pi2, { isolationSwitch: switchState });
  await enableCommands["agentic-isolation-enable"].handler("", tuiContext());
  const declined = await registered[LINUX_MICROVM_CUTOVER_TOOL].execute(
    "t", {}, undefined, undefined,
    { mode: "tui", hasUI: true, cwd: process.cwd(), ui: { confirm: async () => false } },
    );
  const declinedText = declined.content[0].text;
  assert.match(declinedText.split("\n")[0], /^MICROVM CUTOVER: STOPPED — reason not-granted/);
  assert.deepEqual(JSON.parse(declinedText.slice(declinedText.indexOf("{"))), declined.details);
});

test("microVM target: absent config denies target-not-configured; configured target drives validation and argv", async () => {
  const { loadMicroVMTarget } = await import("../scripts/enforcement/linux_microvm_cutover_pi.js");
  const target = loadMicroVMTarget({ target: stubEnvironment().target });
  assert.equal(target.host, "test-microvm-host");
  assert.equal(loadMicroVMTarget({ targetPath: "/nonexistent/path.json" }), null,
    "no config file and no override must deny by default");

  // Config absent: the journey is denied with a clear setup message before any
  // probe, even with the switch enabled and a TUI present.
  const enabledSwitch = createIsolationSwitch();
  enabledSwitch.set(true);
  const probed = [];
  const unconfigured = await runLinuxMicroVMCutover(tuiContext(), {
    isolationSwitch: enabledSwitch,
    execute: (...args) => { probed.push(args); return { code: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.status, "blocked");
  assert.equal(unconfigured.reason.code, "target-not-configured");
  assert.match(unconfigured.reason.detail, /microvm-target\.v1\.example/);
  assert.match(unconfigured.reason.detail, /\.pi\/pi\/config/);
  assert.equal(probed.length, 0, "no probe runs without a configured target");
});

test("configured target drives facts validation, argv host, and the model cannot supply a target", async () => {
  const { run, switchState } = harness();
  await run("agentic-isolation-enable", tuiContext());
  const hostsSeen = [];
  const stub = stubEnvironment({
    isolationSwitch: switchState,
    host: "my-configured-host",
  });
  const observingExecute = (executable, args) => {
    if (executable === "ssh") hostsSeen.push(args[0]);
    return stub.options.execute(executable, args);
  };
  const journey = await runLinuxMicroVMCutover(tuiContext(), {
    ...stub.options,
    execute: observingExecute,
    target: { ...stub.target, host: "my-configured-host" },
  });
  assert.equal(journey.ok, true);
  assert.equal(journey.status, "VERIFIED");
  assert.ok(hostsSeen.length >= 1, "execution uses the configured host");
  assert.ok(hostsSeen.every((host) => host === "my-configured-host"),
    "ssh argv always uses the configured host, never a hardcoded or model-supplied one");

  // Facts mismatch (wrong arch): denied facts-unexpected.
  const mismatched = await runLinuxMicroVMCutover(tuiContext(), {
    ...stub.options,
    target: { ...stub.target, expectedArch: "aarch64" },
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason.code, "facts-unexpected");

  // Kernel prefix mismatch: denied facts-unexpected.
  const wrongKernel = await runLinuxMicroVMCutover(tuiContext(), {
    ...stub.options,
    target: { ...stub.target, expectedKernelPrefix: "5." },
  });
  assert.equal(wrongKernel.ok, false);
  assert.equal(wrongKernel.reason.code, "facts-unexpected");

  // Model-supplied target parameters are rejected by the closed schema.
  const { registerLinuxMicroVMCutoverInterface } = await import("../scripts/enforcement/linux_microvm_cutover_pi.js");
  const registered = {};
  const pi = { registerTool: (tool) => { registered[tool.name] = tool; }, registerCommand: () => {} };
  registerLinuxMicroVMCutoverInterface(pi, {
    isolationSwitch: switchState, target: stub.target,
    execute: stub.options.execute, observeFacts: stub.options.observeFacts,
  });
  const withTargetParam = await registered[LINUX_MICROVM_CUTOVER_TOOL].execute(
    "t", { host: "model-chosen-host" }, undefined, undefined, tuiContext());
  assert.equal(withTargetParam.details.ok, false);
  assert.equal(withTargetParam.details.reason.code, "model-parameters-not-allowed");
});
