// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Owner-only review access to recorded recovery evidence (first host
// binding/review-access slice). The trusted Pi host derives the explicit
// owner-private storage root itself — never from model or worker input — and
// the single owner-initiated command is native-TUI-only: RPC, JSON, and print
// modes are refused fail-closed because only the interactive TUI's custom
// overlay can guarantee the full evidence never reaches the model transcript,
// tool content, or any public output. Read-only review never creates storage,
// and no model-callable raw-evidence tool exists here or anywhere else.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RECOVERY_EVIDENCE_SCHEMA,
  openRecoveryEvidenceStore,
  closeRecoveryEvidenceStore,
  readRecoveryEvidence,
  listRecoveryEvidenceReferences,
} from "./recovery_evidence_store_pi.js";
import { isNativeTuiContext } from "./native_tui_context.js";

export const RECOVERY_EVIDENCE_REVIEW_SCHEMA = "agentic-driver.recovery-evidence-review.v1";
export const RECOVERY_EVIDENCE_REVIEW_COMMAND = "agentic-recovery-evidence";
// Matches the store's default per-record bound; a reference claiming more
// bytes than this is refused before any store is opened.
export const MAX_REVIEW_BYTES = 128 * 1024;
export const REVIEW_LIST_LIMIT = 50;
const MAX_ID_LENGTH = 256;
const SHA256 = /^[a-f0-9]{64}$/;
const CLOSED_REFERENCE_FIELDS = Object.freeze(["bytes", "entryId", "journeyId", "phase", "schema", "sha256"]);
const REGISTRATIONS = new WeakSet();

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function result(code, reason) {
  return { ok: false, schema: RECOVERY_EVIDENCE_REVIEW_SCHEMA, code, reason };
}

function commandArgumentsPresent(args) {
  if (args === undefined || args === null) return false;
  if (typeof args === "string") return args.trim().length > 0;
  if (Array.isArray(args)) return args.some((value) => String(value).trim().length > 0);
  return Object.keys(args).length > 0;
}

/**
 * Host-derived owner-private root. The explicit root comes from trusted host
 * environment configuration; the fallback is the Pi coding-agent config
 * directory. Command arguments and model/worker input can never supply it.
 */
export function resolveReviewEvidenceRoot(env = process.env) {
  const explicit = typeof env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT === "string"
    ? env.AGENTIC_DRIVER_RECOVERY_EVIDENCE_ROOT.trim()
    : "";
  if (explicit) return explicit;
  const agentDir = typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR.trim()
    ? env.PI_CODING_AGENT_DIR.trim()
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "recovery-evidence");
}

/** Closed reference fields only; an oversized reference is refused unread. */
export function parseReviewReference(input, { maxBytes = MAX_REVIEW_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw refuse("invalid-bound", "maxBytes must be a positive safe integer");
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw refuse("invalid-reference", "a recovery evidence reference object is required");
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== CLOSED_REFERENCE_FIELDS.length || keys.some((key, index) => key !== CLOSED_REFERENCE_FIELDS[index])) {
    throw refuse("invalid-reference", `reference must contain exactly the closed fields: ${CLOSED_REFERENCE_FIELDS.join(", ")}`);
  }
  if (input.schema !== RECOVERY_EVIDENCE_SCHEMA) throw refuse("invalid-reference", "reference schema does not match the recovery evidence schema");
  if (typeof input.journeyId !== "string" || !input.journeyId || input.journeyId.length > MAX_ID_LENGTH
    || typeof input.entryId !== "string" || !input.entryId || input.entryId.length > MAX_ID_LENGTH) {
    throw refuse("invalid-reference", "reference journeyId and entryId must be bounded non-empty strings");
  }
  if (!["requested", "terminal"].includes(input.phase)) throw refuse("invalid-reference", "reference phase must be 'requested' or 'terminal'");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) throw refuse("invalid-reference", "reference sha256 must be lowercase 64-hex");
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) throw refuse("invalid-reference", "reference bytes must be a positive safe integer");
  if (input.bytes > maxBytes) throw refuse("reference-too-large", `reference bytes exceed the ${maxBytes}-byte review bound`);
  return Object.freeze({ ...input });
}

function openReadOnly(root) {
  try {
    return { store: openRecoveryEvidenceStore({ root, readOnly: true }) };
  } catch (error) {
    if (error?.code === "ENOENT") return { failure: result("evidence-store-missing", "no recovery evidence store exists at the host-derived owner-private root; nothing was created") };
    if (typeof error?.code === "string" && error.code !== "") return { failure: result(error.code, `the recovery evidence store refused read-only review (${error.code})`) };
    return { failure: result("evidence-store-unavailable", "the recovery evidence store could not be opened read-only") };
  }
}

/** Bounded, read-only listing of closed retrieval references; never bodies. */
export function listReviewableReferences({ root, limit = REVIEW_LIST_LIMIT } = {}) {
  const opened = openReadOnly(root);
  if (opened.failure) return opened.failure;
  try {
    return { ok: true, schema: RECOVERY_EVIDENCE_REVIEW_SCHEMA, references: listRecoveryEvidenceReferences(opened.store, { limit }) };
  } catch (error) {
    return result("invalid-bound", String(error?.message || error));
  } finally {
    closeRecoveryEvidenceStore(opened.store);
  }
}

/** Retrieve and verify one reference read-only; returns the full entry for owner display only. */
export function reviewRecoveryEvidence({ root, reference, maxBytes = MAX_REVIEW_BYTES } = {}) {
  let ref;
  try {
    ref = parseReviewReference(reference, { maxBytes });
  } catch (error) {
    return result(error?.code ?? "invalid-reference", String(error?.message || error));
  }
  const opened = openReadOnly(root);
  if (opened.failure) return opened.failure;
  try {
    const verified = readRecoveryEvidence(opened.store, ref);
    return { ok: true, schema: RECOVERY_EVIDENCE_REVIEW_SCHEMA, reference: verified.reference, entry: verified.entry };
  } catch (error) {
    return result(error?.code ?? "evidence-corrupt", String(error?.message || error));
  } finally {
    closeRecoveryEvidenceStore(opened.store);
  }
}

/** Full evidence lines for the owner-only overlay; never sent through notify or any model surface. */
export function evidenceDisplayLines(reviewed) {
  const { reference, entry } = reviewed;
  return [
    `schema:   ${reference.schema}`,
    `journey:  ${reference.journeyId}`,
    `entry:    ${reference.entryId}`,
    `phase:    ${reference.phase}`,
    `sha256:   ${reference.sha256}`,
    `bytes:    ${reference.bytes} (verified against the store)`,
    "",
    "--- recorded entry (exact owner-private content) ---",
    ...JSON.stringify(entry, null, 2).split("\n"),
  ];
}

const VIEW_LINES = 24;

function fitLine(line, width) {
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`;
}

/** Minimal terminal-only overlay component for the interactive TUI. */
export function createEvidenceOverlay({ done, lines }) {
  let offset = 0;
  const maxOffset = () => Math.max(0, lines.length - VIEW_LINES);
  return {
    render(width) {
      const w = Math.max(20, Number(width) || 80);
      const body = lines.slice(offset, offset + VIEW_LINES).map((line) => fitLine(line, w));
      while (body.length < VIEW_LINES) body.push("");
      return [
        fitLine(`Recovery evidence (owner-only) — ${lines.length} lines; up/down or space scrolls; Enter/Esc closes`, w),
        "",
        ...body,
      ];
    },
    handleInput(data) {
      if (data === "\x1b[A") { offset = Math.max(0, offset - 1); return; }
      if (data === "\x1b[B") { offset = Math.min(maxOffset(), offset + 1); return; }
      if (data === " ") { offset = Math.min(maxOffset(), offset + VIEW_LINES); return; }
      if (data === "\x1b" || data === "q" || data === "\r" || data === "\n") done(undefined);
    },
  };
}

/**
 * Registers ONLY the owner-initiated slash command. No model-callable tool is
 * registered here, and no raw-evidence tool may be added later: the full
 * evidence travels exclusively through the native TUI overlay.
 */
export function registerRecoveryEvidenceReview(pi, _options = {}) {
  if (typeof pi?.registerCommand !== "function" || REGISTRATIONS.has(pi)) return;
  REGISTRATIONS.add(pi);
  const notify = (context, message, type) => {
    if (typeof context?.ui?.notify === "function") context.ui.notify(message, type);
  };
  pi.registerCommand(RECOVERY_EVIDENCE_REVIEW_COMMAND, {
    description: "Review recorded recovery evidence (owner-only, interactive TUI; evidence is never shown to the model)",
    argumentHint: "",
    handler: async (args, context) => {
      // The handler always returns undefined: nothing it does may become
      // model-visible content or transcript output.
      if (commandArgumentsPresent(args)) {
        notify(context, "Recovery evidence review accepts no command arguments; the trusted host derives the owner-private root.", "warning");
        return undefined;
      }
      // Fail closed outside the interactive native TUI: RPC forwards dialogs
      // but custom() is undefined there, and JSON/print have no UI at all.
      if (!isNativeTuiContext(context) || typeof context?.ui?.custom !== "function" || typeof context?.ui?.select !== "function") {
        notify(context, "Recovery evidence review requires the interactive native Pi TUI; RPC, JSON, and print modes are refused so evidence can never enter a transcript.", "warning");
        return undefined;
      }
      const root = resolveReviewEvidenceRoot();
      const listing = listReviewableReferences({ root, limit: REVIEW_LIST_LIMIT });
      if (!listing.ok) {
        notify(context, `Recovery evidence review: ${listing.code} — ${listing.reason}`, listing.code === "evidence-store-missing" ? "info" : "error");
        return undefined;
      }
      if (listing.references.length === 0) {
        notify(context, "No recovery evidence is recorded yet.", "info");
        return undefined;
      }
      const labels = listing.references.map((ref) =>
        `${ref.phase} · ${ref.journeyId} · ${ref.entryId} · ${ref.sha256.slice(0, 12)} · ${ref.bytes} B`);
      const selected = await context.ui.select("Recovery evidence (owner-only review)", labels);
      const selectedIndex = typeof selected === "string" ? labels.indexOf(selected) : -1;
      if (selectedIndex < 0) return undefined;
      const reviewed = reviewRecoveryEvidence({ root, reference: listing.references[selectedIndex] });
      if (!reviewed.ok) {
        notify(context, `Recovery evidence review: ${reviewed.code} — ${reviewed.reason}`, "error");
        return undefined;
      }
      // The only full-evidence surface: a transient terminal overlay that
      // never reaches the session transcript, tool results, or the model.
      await context.ui.custom((_tui, _theme, _keybindings, done) => createEvidenceOverlay({ done, lines: evidenceDisplayLines(reviewed) }));
      return undefined;
    },
  });
}
