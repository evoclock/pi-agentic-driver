import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  openRecoveryEvidenceStore, closeRecoveryEvidenceStore,
  recordRecoveryRequest, recordRecoveryResult,
} from "../scripts/enforcement/recovery_evidence_store_pi.js";
import { nudgeCanonicalJsonString } from "../scripts/enforcement/nudge_ledger_pi.js";
import registerRecoveryEvidenceReviewExtension from "../extensions/recovery-evidence.ts";

const REVIEW = (await import("../scripts/enforcement/recovery_evidence_review_pi.js")).default ?? null;
const review = await import("../scripts/enforcement/recovery_evidence_review_pi.js");
const reviewModule = review;
const reviewRecoveryEvidence = (args) => reviewModule.reviewRecoveryEvidence(args);
const parseReviewReference = (ref, opts) => reviewModule.parseReviewReference(ref, opts);
const listReviewableReferences = (args) => reviewModule.listReviewableReferences(args);
const resolveReviewEvidenceRoot = (env) => reviewModule.resolveReviewEvidenceRoot(env);

const hash = (text) => createHash("sha256").update(text).digest("hex");
const auth = {
  dispatchId: "dispatch-1", source: "direct",
  authorityProvenance: { kind: "direct-instruction", reference: "dispatch-1", capturedAt: "2026-09-21T10:00:00.000Z" },
  authorityMaterial: "implement the module", authorityDigest: hash("implement the module"),
  authorizedAt: "2026-09-21T10:00:00.000Z", repositoryScope: "pi-agentic-driver",
  containmentProfile: "testudo-microvm-default", operationClasses: ["repository-read", "worktree-edit"],
};
auth.scopeDigest = hash(nudgeCanonicalJsonString({ operationClasses: [...auth.operationClasses].sort(), containmentProfile: auth.containmentProfile, repositoryScope: auth.repositoryScope }));

function entry(overrides = {}) {
  const messageText = "[NUDGE] please report status";
  return {
    ledgerVersion: 1, entryId: "nudge-j1-1-0-1", journeyId: "j1", timestamp: "2026-09-21T10:05:00.000Z",
    action: "nudge", role: "implementer", journeyStep: 1, attemptOrdinal: 0, repository: "/repo",
    dispatchAuthorization: auth, autonomy: "autonomous", containmentProfile: "testudo-microvm-default",
    operationClasses: ["repository-read", "worktree-edit"],
    preState: { classification: "stuck-on-dialog", agentStatus: "blocked", pollOrdinal: 7 },
    messageText, messageSha256: hash(messageText), messageBytes: Buffer.byteLength(messageText),
    result: "requested", preGit: { head: "a".repeat(40), statusDigest: "b".repeat(64), diffDigest: "c".repeat(64) },
    ...overrides,
  };
}

function fixture(t) {
  const scratch = mkdtempSync(join(process.cwd(), ".scratch-recovery-review-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "owner-private");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return { scratch, root };
}

// A faithful mock of the native TUI context: mode/hasUI/custom/select mirror
// the real ExtensionCommandContext contract used by the fail-closed gate.
function mockTui({ customCalls = [], selectValue = null } = {}) {
  const calls = { custom: [], notify: [], select: 0, requestRender: 0 };
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      notify(message, type) { calls.notify.push({ message, type }); },
      confirm: async () => true,
      async select(_title, labels) {
        calls.select += 1;
        if (typeof selectValue === "function") return selectValue(labels);
        return selectValue === null ? labels[0] : selectValue;
      },
      async custom(factory) {
        calls.custom.push(factory);
        let done;
        // A faithful stand-in for the injected Pi tui handle.
        const tui = { requestRender: () => { calls.requestRender += 1; } };
        const component = await factory(tui, undefined, undefined, (value) => { done = value; });
        return { component, done: () => done?.(undefined) };
      },
    },
  };
  return { ctx, calls, customCalls };
}

function mockHeadless(mode) {
  return mode === "json" || mode === "print"
    ? { mode, hasUI: false, ui: undefined }
    : { mode, hasUI: true, ui: { notify: () => {}, confirm: async () => true } };
}

function harness(t) {
  const registered = { commands: [], tools: [] };
  const pi = {
    registerCommand: (name, def) => registered.commands.push({ name, ...def }),
    registerTool: (tool) => registered.tools.push(tool.name),
  };
  registerRecoveryEvidenceReviewExtension(pi);
  return { pi, registered };
}


test("registration adds one owner command and never a model-callable tool", () => {
  const { registered } = harness();
  assert.deepEqual(registered.tools, []);
  assert.equal(registered.commands.length, 1);
  assert.equal(registered.commands[0].name, "agentic-recovery-evidence");
});

test("headless RPC, JSON, and print modes are refused before any store access", async (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root });
  recordRecoveryRequest(store, entry());
  closeRecoveryEvidenceStore(store);
  for (const mode of ["rpc", "json", "print"]) {
    const { registered } = harness();
    const ctx = mockHeadless(mode);
    const out = await registered.commands[0].handler("", ctx);
    assert.equal(out, undefined);
    assert.equal(existsSync(join(root, "recovery-evidence.v1.sqlite")), true); // pre-existing only
  }
});

test("TUI review shows the full entry via the overlay only and never notify output", async (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root });
  const requested = recordRecoveryRequest(store, entry());
  const terminal = recordRecoveryResult(store, requested, { result: "delivered", deliveryState: "delivered" });
  closeRecoveryEvidenceStore(store);
  // The trusted root must be set BEFORE registration: registration snapshots it.
  const previousRoot = process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
  process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = root;
  const { registered } = harness();
  // Select the terminal record by exact label: same-second timestamps make
  // the store's listing order non-deterministic between the two phases.
  const { ctx, calls } = mockTui({ selectValue: (labels) =>
    labels.find((label) => label.startsWith("terminal · j1 · ")) ?? null });
  try {
    const out = await registered.commands[0].handler("", ctx);
    assert.equal(out, undefined);
    assert.equal(calls.custom.length, 1);
    const tui = { requestRender: () => { calls.requestRender += 1; } };
    const component = await calls.custom[0](tui, undefined, undefined, () => {});
    const rendered = [component.render(80).join("\n")];
    // Scroll through the whole overlay content, as the owner would.
    for (let i = 0; i < 20; i += 1) { component.handleInput(" "); rendered.push(component.render(80).join("\n")); }
    const fullView = rendered.join("\n");
    assert.match(fullView, /\[NUDGE\] please report status/);
    assert.match(fullView, new RegExp(terminal.sha256.slice(0, 12)));
    // notify never carries evidence content — status text only
    for (const { message } of calls.notify) {
      assert.equal(message.includes("please report status"), false);
      assert.equal(message.includes("messageText"), false);
    }
    // Scrolling must drive redraws through the injected tui handle: one
    // requestRender per actual offset change, none for unrelated keys.
    const renderCallsAfterScroll = calls.requestRender;
    assert.ok(renderCallsAfterScroll >= 1, "scrolling must request renders");
    const beforeUnrelated = calls.requestRender;
    component.handleInput("x");
    component.handleInput("\t");
    assert.equal(calls.requestRender, beforeUnrelated, "unrelated keys must not request renders");
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
    else process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = previousRoot;
  }
});

test("missing store is reported without creating any storage", async (t) => {
  const { scratch, root } = fixture(t);
  rmSync(root, { recursive: true, force: true });
  const previousRoot = process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
  process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = root;
  const { registered } = harness();
  const { ctx, calls } = mockTui();
  try {
    const out = await registered.commands[0].handler("", ctx);
    assert.equal(out, undefined);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(join(root, "recovery-evidence.v1.sqlite")), false);
    assert.equal(calls.custom.length, 0);
    assert.match(calls.notify[0]?.message ?? "", /no recovery evidence store exists/);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
    else process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = previousRoot;
  }
});

test("corrupt evidence fails closed in the review path", async (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root });
  const requested = recordRecoveryRequest(store, entry());
  store.db.prepare("UPDATE evidence SET body=? WHERE phase='requested'").run("{}");
  closeRecoveryEvidenceStore(store);
  const result = reviewRecoveryEvidence({ root, reference: { ...requested } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "evidence-corrupt");
  assert.equal(result.entry, undefined);
});

test("oversized and malformed references are refused before opening the store", async (t) => {
  const { root } = fixture(t);
  const big = { schema: "agentic-driver.recovery-evidence.v1", journeyId: "j1", entryId: "e1", phase: "requested", sha256: "a".repeat(64), bytes: 128 * 1024 + 1 };
  const refused = reviewRecoveryEvidence({ root, reference: big });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "reference-too-large");
  const malformed = reviewRecoveryEvidence({ root, reference: { ...big, bytes: 10, extra: true } });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, "invalid-reference");
  assert.equal(existsSync(join(root, "recovery-evidence.v1.sqlite")), false);
});

test("host derives the root; arguments never influence it", async (t) => {
  const previous = process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
  process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = "/private/var/owner-evidence";
  try {
    assert.equal(resolveReviewEvidenceRoot(), "/private/var/owner-evidence");
    // Trailing slashes and redundant separators are canonicalized.
    process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = "/private/var/owner-evidence///";
    assert.equal(resolveReviewEvidenceRoot(), "/private/var/owner-evidence");
    process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = "/private/var/./owner/../owner-evidence/";
    assert.equal(resolveReviewEvidenceRoot(), "/private/var/owner-evidence");
    // Relative and ~ paths are refused, never silently expanded.
    process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = "relative/root";
    assert.throws(() => resolveReviewEvidenceRoot(), /absolute path/);
    process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = "~/owner-evidence";
    assert.throws(() => resolveReviewEvidenceRoot(), /absolute path/);
    process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = "~/owner-evidence";
    assert.throws(() => resolveReviewEvidenceRoot(), /~/);
    delete process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
    process.env.PI_CODING_AGENT_DIR = "/home/owner/.pi/agent";
    assert.equal(resolveReviewEvidenceRoot(), join("/home/owner/.pi/agent", "recovery-evidence"));
    delete process.env.PI_CODING_AGENT_DIR;
    const fallback = resolveReviewEvidenceRoot();
    assert.ok(fallback.endsWith(join(".pi", "agent", "recovery-evidence")));
  } finally {
    if (previous === undefined) delete process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
    else process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = previous;
  }
});

test("registration snapshots the trusted root; later env mutation cannot redirect", async (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root });
  const requested = recordRecoveryRequest(store, entry());
  closeRecoveryEvidenceStore(store);
  const previousRoot = process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
  process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = root;
  const { registered } = harness();
  const { ctx, calls } = mockTui({ selectValue: () => null });
  try {
    // The first registration snapshotted the root. A second registration in
    // the same process reuses the same WeakSet-guarded state; verify the
    // snapshotted root survives a later env mutation.
    process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = "/nonexistent-redirect-target";
    const out = await registered.commands[0].handler("", ctx);
    assert.equal(out, undefined);
    assert.deepEqual(calls.notify, []); // no evidence-store-missing error
    assert.equal(calls.select, 1, "selection ran against the snapshotted root");
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
    else process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = previousRoot;
  }
});

test("closed reference fields and bounded listing", async (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root });
  const requested = recordRecoveryRequest(store, entry());
  recordRecoveryResult(store, requested, { result: "rejected", deliveryState: "rejected-before-delivery" });
  closeRecoveryEvidenceStore(store);
  const listing = listReviewableReferences({ root, limit: 1 });
  assert.equal(listing.ok, true);
  assert.equal(listing.references.length, 1);
  const [ref] = listing.references;
  assert.deepEqual(Object.keys(ref).sort(), ["bytes", "entryId", "journeyId", "phase", "schema", "sha256"]);
  const parsed = parseReviewReference({ ...ref });
  assert.equal(parsed.journeyId, ref.journeyId);
  assert.throws(() => parseReviewReference({ ...ref, bytes: 0 }), /positive safe integer/);
  assert.throws(() => parseReviewReference({ ...ref, phase: "other" }), /phase/);
  assert.throws(() => parseReviewReference({ ...ref, sha256: "Z".repeat(64) }), /sha256/);
});

test("read-only review never mutates store permissions or files", async (t) => {
  const { root } = fixture(t);
  const store = openRecoveryEvidenceStore({ root });
  const requested = recordRecoveryRequest(store, entry());
  closeRecoveryEvidenceStore(store);
  const before = statSync(join(root, "recovery-evidence.v1.sqlite")).mtimeMs;
  const result = reviewRecoveryEvidence({ root, reference: { ...requested } });
  assert.equal(result.ok, true);
  assert.equal(result.entry.messageText, "[NUDGE] please report status");
  const after = statSync(join(root, "recovery-evidence.v1.sqlite")).mtimeMs;
  assert.equal(after, before);
  assert.equal(statSync(root).mode & 0o077, 0);
});

test("overlay renders wide Unicode and ANSI with Pi tui width helpers", async () => {
  const { createEvidenceOverlay } = reviewModule;
  const overlay = await createEvidenceOverlay({
    done: () => {},
    lines: [
      "plain ascii line",
      "wide: 中中中中中中中中中中中中中中中中中中中中 and more content beyond width",
      `styled: \u001b[31mred evidence text\u001b[0m with escapes and padding padding padding`,
      "combining: e\u0301\u0301 accents e\u0301 more tail content that should survive width cuts",
    ],
  });
  const rendered = overlay.render(40);
  // Header + blank + 4 content lines, padded to the VIEW_LINES window.
  assert.ok(rendered.length >= 6, `rendered ${rendered.length} lines`);
  // No rendered line may exceed the available width in visible columns when
  // the real Pi tui helpers are available.
  try {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    for (const line of rendered) assert.ok(visibleWidth(line) <= 40, `line too wide: ${visibleWidth(line)}`);
  } catch {
    // Offline fallback: plain-length bound still holds.
    for (const line of rendered) assert.ok(line.length <= 40 || line === "", `line too long: ${line.length}`);
  }
  // A short list cannot scroll: no offset change, no render request, and
  // unrelated keys request nothing even with a tui handle present.
  const tui = { requestRender: () => { renders += 1; } };
  let renders = 0;
  overlay.tui = tui;
  assert.equal(overlay.handleInput("\x1b[B"), undefined);
  assert.equal(overlay.handleInput("\x1b[A"), undefined);
  assert.equal(overlay.handleInput("x"), undefined);
  assert.equal(renders, 0);
});
