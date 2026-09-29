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
  const calls = { custom: [], notify: [], select: 0 };
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
        const component = factory(undefined, undefined, undefined, (value) => { done = value; });
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
  const { registered } = harness();
  // Select the terminal record by exact label: same-second timestamps make
  // the store's listing order non-deterministic between the two phases.
  const { ctx, calls } = mockTui({ selectValue: (labels) =>
    labels.find((label) => label.startsWith("terminal · j1 · ")) ?? null });
  const previousRoot = process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
  process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = root;
  try {
    const out = await registered.commands[0].handler("", ctx);
    assert.equal(out, undefined);
    assert.equal(calls.custom.length, 1);
    const component = calls.custom[0](undefined, undefined, undefined, () => {});
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
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
    else process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = previousRoot;
  }
});

test("missing store is reported without creating any storage", async (t) => {
  const { scratch, root } = fixture(t);
  rmSync(root, { recursive: true, force: true });
  const { registered } = harness();
  const { ctx, calls } = mockTui();
  const previousRoot = process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT;
  process.env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT = root;
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
