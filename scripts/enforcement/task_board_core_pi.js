// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 semantic model, closed validator, hash canonicalization, both
// surface parsers/serializers, the trusted board writer, and the pure
// dispatchability predicate. Implements evidence/BOARD1_DESIGN_v6.md §1-§3.
//
// Governance boundary: this module is deterministic and side-effect-free
// except for the trusted writer's atomic persist, which is only ever invoked
// with a recorded human authority source. Models never supply identifiers or
// hashes; presentation is excluded from the hash; every disagreement between
// surfaces fails closed.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, statSync as fsStatSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Closed vocabularies (§1)
// ---------------------------------------------------------------------------

export const LANES = Object.freeze(["backlog", "in-progress", "review", "done"]);
export const FLAGS = Object.freeze(["proposed", "blocked", "cancelled"]);
export const PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
export const CARD_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
export const CARD_ID_RE = new RegExp(CARD_ID_PATTERN);
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
export const CAPABILITY_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
export const SAFE_PATH_RE = /^[A-Za-z0-9._/@-]+$/;

// Obsidian Tasks five-level priority → canonical P0-P3. The mapping is
// documented as lossy and one-directional (design §1): canonical → Obsidian
// picks one emoji and the reverse trip is never treated as faithful.
export const OBSIDIAN_PRIORITY_MAP = Object.freeze({
  highest: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
  lowest: "P3",
});

const FIELD_RE = /\[([A-Za-z][A-Za-z0-9_-]*)::[ \t]([^\][]*)\]/g;
const HTML_ID_MARKER_RE = /<!--\s*id:\s*([^>]*?)\s*-->/g;
// Tasks-plugin presentation emoji (optional; never required, never hashed).
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2194}-\u{21AA}]/gu;
const EMOJI_DATE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/u;

function nfc(value) {
  return typeof value === "string" ? value.normalize("NFC") : value;
}

// ---------------------------------------------------------------------------
// Hash canonicalization (§1): SHA-256 over canonical JSON of the
// authority-bearing fields only. Keys recursively sorted; absent optional
// fields omitted (never null); strings NFC-normalized; presentation excluded.
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return nfc(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = canonicalJson(value[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return undefined;
}

export function canonicalJsonString(value) {
  return JSON.stringify(canonicalJson(value));
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Free-text (titles, quoted instructions) is sanitized before it is ever
// serialized into a card line: [key:: value] field syntax, stray "]", and
// HTML-comment syntax are stripped so a hostile string cannot alter parsing
// (§6 gate 3). Sanitization is lossy by design — it fails closed.
export function sanitizeFreeText(text) {
  return String(text ?? "").normalize("NFC")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/\[[A-Za-z][A-Za-z0-9_-]*::[^\]]*\]?/g, " ")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ").trim();
}

// Spec/DoD text travels base64url-encoded inside a [key:: value] field: the
// encoding round-trips byte-for-byte (so the dispatch gate can recompute the
// hash) and cannot inject field or HTML-comment syntax.
export function encodeFieldText(text) {
  return Buffer.from(String(text ?? ""), "utf8").toString("base64url");
}

export function decodeFieldText(encoded) {
  if (typeof encoded !== "string" || encoded === "") return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

// The authority-bearing field set. The authority-source reference is NOT
// hash-bearing: it is recorded alongside the card, outside this payload.
// §1 scope = paths + capability classes + explicitly unchanged paths +
// repository identity (for user-level cards) — all hash-bearing.
const AUTHORITY_FIELDS = Object.freeze([
  "cardId", "lane", "flags", "priority", "dependencies", "base",
  "specHash", "dodHash", "stoppingPoint", "scope", "unchangedPaths",
  "capabilities", "repositories",
]);

export function hashPayload(card) {
  const payload = {};
  for (const field of AUTHORITY_FIELDS) {
    const value = card[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    payload[field] = value;
  }
  return payload;
}

export function computeCardHash(card) {
  return sha256Hex(canonicalJsonString(hashPayload(card)));
}

export function computeSpecHash(specText) {
  return sha256Hex(nfc(String(specText)));
}

// ---------------------------------------------------------------------------
// Title stripping / normalization (§2): fields, emoji, and the ID marker are
// stripped from the displayed title consistently in both parsers.
// ---------------------------------------------------------------------------

export function stripTitle(rawTitle) {
  let title = String(rawTitle ?? "");
  title = title.replace(HTML_ID_MARKER_RE, " ");
  title = title.replace(FIELD_RE, " ");
  title = title.replace(EMOJI_DATE_RE, " ");
  title = title.replace(EMOJI_RE, " ");
  return title.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Parsers (§2). One tokenizer handles both surface shapes: Obsidian Kanban
// Markdown ([id:: ...] Dataview marker) and vogelkop TASKS.md
// (<!-- id: ... --> HTML-comment marker). Unknown ## headings are rejected;
// [-] cancelled checkboxes map to #cancelled; indented continuation lines are
// description text.
// ---------------------------------------------------------------------------

function parseCardLine(line, surface, checkboxState = null) {
  const errors = [];
  const fields = {};
  const duplicateKeys = new Set();
  const flags = [];
  let idMarker = null;
  let idField = null;

  const idMarkerMatches = [...line.matchAll(HTML_ID_MARKER_RE)];
  if (idMarkerMatches.length > 1) {
    errors.push("multiple HTML id markers on one card line (injection rejected)");
  } else if (idMarkerMatches.length === 1) {
    idMarker = idMarkerMatches[0][1].trim();
  }

  for (const match of line.matchAll(FIELD_RE)) {
    const key = match[1];
    const value = match[2].trim();
    if (key === "id") {
      if (idField !== null) errors.push("duplicate [id:: ...] field");
      idField = value;
    } else if (key === "flag") {
      if (!FLAGS.includes(value)) {
        errors.push(`unknown flag "${value}" (closed enum: ${FLAGS.join(", ")})`);
      } else {
        flags.push(value);
      }
    } else {
      // Duplicate authority-bearing fields are ambiguous (last-value-wins is
      // an injection vector); reject fail-closed (M2).
      if (Object.hasOwn(fields, key)) duplicateKeys.add(key);
      fields[key] = value;
    }
  }
  for (const key of duplicateKeys) {
    errors.push(`duplicate [${key}:: ...] field on one card line (injection rejected)`);
  }

  // Mirror consistency (§1): if both surface markers are present they must
  // encode the same canonical identity; disagreement fails closed.
  if (idMarker !== null && idField !== null && idMarker !== idField) {
    errors.push(`mirror-consistency failure: id marker "${idMarker}" != [id:: ${idField}]`);
  }
  const cardId = idMarker ?? idField;

  if (checkboxState === "-") flags.push("cancelled");
  const state = checkboxState;

  const title = stripTitle(line.replace(/^[-*]\s+\[( |x|X|-)\]\s*/, ""));
  if (/<!--|-->/.test(title)) {
    errors.push("HTML-comment injection in card title rejected");
  }

  const emojiDate = line.match(EMOJI_DATE_RE);
  if (emojiDate) fields.due = emojiDate[1];

  return { cardId, title, fields, flags: [...new Set(flags)], state, surface, errors };
}

function laneFromHeading(heading) {
  const name = heading.replace(/^##\s*/, "").trim().toLowerCase();
  return LANES.includes(name) ? name : null;
}

export function parseBoard(markdown, { surface = "auto" } = {}) {
  const errors = [];
  const cards = [];
  const lines = String(markdown ?? "").split(/\r?\n/);
  let lane = null;
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      const parsed = laneFromHeading(heading[1]);
      if (parsed === null) {
        errors.push(`unknown ## heading "${heading[1].trim()}" (lanes are closed)`);
        lane = null;
      } else {
        lane = parsed;
      }
      current = null;
      continue;
    }
    if (lane === null) continue;

    const cardMatch = line.match(/^[-*]\s+\[( |x|X|-)\]\s*(.*)$/);
    if (cardMatch) {
      const parsed = parseCardLine(cardMatch[2], surface, cardMatch[1]);
      for (const error of parsed.errors) errors.push(`${parsed.cardId ?? "(unidentified)"}: ${error}`);
      current = {
        cardId: parsed.cardId,
        lane,
        title: parsed.title,
        fields: parsed.fields,
        flags: parsed.flags,
        state: parsed.state,
        description: [],
        done: parsed.state === "x" || parsed.state === "X",
      };
      cards.push(current);
      continue;
    }
    // Indented continuation lines are description text (§2).
    if (current && /^\s+\S/.test(line)) {
      current.description.push(line.trim());
    }
  }

  const resolved = cards.map((card) => semanticCard(card, errors));
  return { ok: errors.length === 0, cards: resolved, errors };
}

function semanticCard(raw, errors) {
  const f = raw.fields;
  const card = {
    cardId: raw.cardId ?? null,
    lane: raw.lane,
    title: raw.title,
    flags: raw.flags,
    priority: f.priority ?? null,
    dependencies: f.blockedBy ? f.blockedBy.split(/[\s,]+/).filter(Boolean) : [],
    base: f.base ?? null,
    due: f.due ?? null,
    role: f.role ?? null,
    capabilities: f.capabilities ? f.capabilities.split(/[\s,]+/).filter(Boolean) : [],
    stoppingPoint: f.stopping ?? f["stopping-point"] ?? null,
    specHash: f.specHash ?? f["spec-hash"] ?? null,
    dodHash: f.dodHash ?? f["dod-hash"] ?? null,
    specText: decodeFieldText(f.specText ?? f["spec-text"]),
    dodText: decodeFieldText(f.dodText ?? f["dod-text"]),
    scope: f.scope ? f.scope.split(/[\s,]+/).filter(Boolean) : [],
    unchangedPaths: f.unchanged ? f.unchanged.split(/[\s,]+/).filter(Boolean) : [],
    repositories: f.repos ? f.repos.split(/[\s,]+/).filter(Boolean) : [],
    tags: f.tags ? f.tags.split(/[\s,]+/).filter(Boolean) : [],
    provenance: f.provenance ?? null,
    importedId: f.importedId ?? null,
    hash: f.hash ?? null,
    authoritySource: f.authority ? safeJsonParse(f.authority) : null,
    fields: { ...f },
    description: raw.description.join("\n"),
    done: raw.done ?? false,
  };
  if (card.cardId === null) errors.push(`card without an id marker in lane ${raw.lane}`);
  if (card.authoritySource !== null && !isValidAuthoritySource(card.authoritySource)) {
    errors.push(`${card.cardId ?? "(unidentified)"}: malformed authority-source record (fails closed)`);
    card.authoritySource = null;
  }
  return card;
}

// §3.5: an authority-source record is a reference — {source: "instruction" |
// "report-proposal", sessionOrReportId, quotedInstruction-or-digest}. A
// malformed or absent record is never dispatchable.
export function isValidAuthoritySource(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.source !== "instruction" && record.source !== "report-proposal") return false;
  if (typeof record.sessionOrReportId !== "string" || record.sessionOrReportId.trim() === "") return false;
  const hasInstruction = typeof record.quotedInstruction === "string" && record.quotedInstruction.trim() !== "";
  const hasDigest = typeof record.digest === "string" && /^[0-9a-f]{64}$/.test(record.digest);
  return hasInstruction || hasDigest;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { malformed: String(text) };
  }
}

// ---------------------------------------------------------------------------
// Closed validator (§1, §6 gate 2). Validate before persist; decline on
// violation; duplicate cardId is a validation error; decorative use of the
// canonical flag names in free-form tags is a validation error.
// ---------------------------------------------------------------------------

export function validateCard(card, context = {}) {
  const errors = [];
  const { knownCardIds = [], roles = [], capabilities = [], userLevel = false } = context;

  if (typeof card.cardId !== "string" || !CARD_ID_RE.test(card.cardId)) {
    errors.push(`cardId "${card.cardId}" does not match ${CARD_ID_PATTERN}`);
  }
  if (!LANES.includes(card.lane)) {
    errors.push(`lane "${card.lane}" is not one of ${LANES.join(", ")}`);
  }
  for (const flag of card.flags ?? []) {
    if (!FLAGS.includes(flag)) errors.push(`flag "${flag}" is not one of ${FLAGS.join(", ")}`);
  }
  // Decorative flag-name tags are a validation error (§1).
  for (const tag of card.tags ?? []) {
    if (FLAGS.includes(tag)) errors.push(`decorative use of canonical flag name "${tag}" as a tag is a validation error`);
  }
  if (card.priority !== null && card.priority !== undefined && !PRIORITIES.includes(card.priority)) {
    errors.push(`priority "${card.priority}" is not one of ${PRIORITIES.join(", ")}`);
  }
  for (const dep of card.dependencies ?? []) {
    if (!CARD_ID_RE.test(dep)) errors.push(`dependency "${dep}" is not a valid cardId`);
  }
  if (card.base !== null && card.base !== undefined && !COMMIT_SHA_RE.test(card.base)) {
    errors.push(`base "${card.base}" is not a full 40-hex commit SHA`);
  }
  for (const field of ["due"]) {
    const value = card[field];
    if (value !== null && value !== undefined && !ISO_DATE_RE.test(value)) {
      errors.push(`${field} "${value}" is not an ISO yyyy-mm-dd date`);
    }
  }
  if (card.role !== null && card.role !== undefined && card.role !== "" && !roles.includes(card.role)) {
    errors.push(`role "${card.role}" is not declared in the role registry`);
  }
  for (const capability of card.capabilities ?? []) {
    if (!CAPABILITY_NAME_RE.test(capability)) {
      errors.push(`capability "${capability}" is not a well-formed capability class name`);
    } else if (!capabilities.includes(capability)) {
      errors.push(`capability "${capability}" is not declared in the capability registry`);
    }
  }
  for (const path of card.scope ?? []) {
    if (!SAFE_PATH_RE.test(path) || path.includes("..")) {
      errors.push(`scope path "${path}" is not a safe repository-relative path`);
    }
  }
  for (const path of card.unchangedPaths ?? []) {
    if (!SAFE_PATH_RE.test(path) || path.includes("..")) {
      errors.push(`unchanged path "${path}" is not a safe repository-relative path`);
    }
  }
  if (userLevel && (card.scope ?? []).length > 0 && (card.repositories ?? []).length === 0) {
    errors.push("a user-level card with scope paths must name the repository (or repositories) they refer to");
  }
  if (card.importedId !== null && card.importedId !== undefined) {
    if (String(card.importedId).includes("/")) {
      if (card.cardId !== substituteImportedId(card.importedId)) {
        errors.push(`an imported id containing "/" must map to the substituted cardId "${substituteImportedId(card.importedId)}"`);
      }
      if (!card.provenance) {
        errors.push("an imported id containing \"/\" must retain the original in provenance");
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// Imported IDs containing `/` use a schema-safe `--` substitution, with the
// original retained in provenance (§1).
export function substituteImportedId(importedId) {
  return String(importedId).replace(/\//g, "--");
}

export function validateBoard(markdown, context = {}) {
  const parsed = parseBoard(markdown, { surface: context.surface ?? "auto" });
  const errors = [...parsed.errors];
  const seen = new Map();
  for (const card of parsed.cards) {
    if (card.cardId !== null) {
      if (seen.has(card.cardId)) errors.push(`duplicate cardId "${card.cardId}" is a validation error`);
      seen.set(card.cardId, card);
    }
    const result = validateCard(card, context);
    for (const error of result.errors) errors.push(`${card.cardId ?? "(unidentified)"}: ${error}`);
    for (const dep of card.dependencies ?? []) {
      if (!seen.has(dep) && !parsed.cards.some((other) => other.cardId === dep)) {
        errors.push(`${card.cardId}: dependency "${dep}" does not exist on the board`);
      }
    }
  }
  return { ok: errors.length === 0, cards: parsed.cards, errors };
}

// ---------------------------------------------------------------------------
// Serializers (§2). One canonical machine encoding: [key:: value] fields on
// the card line. Emoji are optional presentation; no reader requires them.
// ---------------------------------------------------------------------------

function fieldText(key, value) {
  return `[${key}:: ${value}]`;
}

export function serializeObsidianCard(card) {
  const checkbox = card.flags?.includes("cancelled") ? "[-]" : card.done ? "[x]" : "[ ]";
  const parts = [checkbox, card.title];
  parts.push(fieldText("id", card.cardId));
  if (card.hash) parts.push(fieldText("hash", card.hash));
  if (card.priority) parts.push(fieldText("priority", card.priority));
  for (const flag of card.flags ?? []) parts.push(fieldText("flag", flag));
  if ((card.dependencies ?? []).length > 0) parts.push(fieldText("blockedBy", card.dependencies.join(", ")));
  if (card.base) parts.push(fieldText("base", card.base));
  if (card.due) parts.push(`📅 ${card.due}`);
  if (card.role) parts.push(fieldText("role", card.role));
  if ((card.capabilities ?? []).length > 0) parts.push(fieldText("capabilities", card.capabilities.join(", ")));
  if (card.stoppingPoint) parts.push(fieldText("stopping", card.stoppingPoint));
  if (card.specHash) parts.push(fieldText("specHash", card.specHash));
  if (card.dodHash) parts.push(fieldText("dodHash", card.dodHash));
  if (card.specText !== null && card.specText !== undefined) parts.push(fieldText("specText", encodeFieldText(card.specText)));
  if (card.dodText !== null && card.dodText !== undefined) parts.push(fieldText("dodText", encodeFieldText(card.dodText)));
  if ((card.scope ?? []).length > 0) parts.push(fieldText("scope", card.scope.join(", ")));
  if ((card.unchangedPaths ?? []).length > 0) parts.push(fieldText("unchanged", card.unchangedPaths.join(", ")));
  if ((card.repositories ?? []).length > 0) parts.push(fieldText("repos", card.repositories.join(", ")));
  if ((card.tags ?? []).length > 0) parts.push(fieldText("tags", card.tags.join(", ")));
  if (card.provenance) parts.push(fieldText("provenance", card.provenance));
  if (card.importedId) parts.push(fieldText("importedId", card.importedId));
  if (card.authoritySource) parts.push(fieldText("authority", JSON.stringify(card.authoritySource)));
  let out = `- ${parts.join(" ")}`;
  if (card.description) out += `\n  ${card.description.replace(/\n/g, "\n  ")}`;
  return out;
}

export function serializeTasksCard(card) {
  const checkbox = card.flags?.includes("cancelled") ? "[-]" : card.done ? "[x]" : "[ ]";
  const parts = [checkbox, card.title, `<!-- id: ${card.cardId} -->`];
  if (card.hash) parts.push(fieldText("hash", card.hash));
  if (card.priority) parts.push(fieldText("priority", card.priority));
  for (const flag of card.flags ?? []) parts.push(fieldText("flag", flag));
  if ((card.dependencies ?? []).length > 0) parts.push(fieldText("blockedBy", card.dependencies.join(", ")));
  if (card.base) parts.push(fieldText("base", card.base));
  if (card.due) parts.push(fieldText("due", card.due));
  if (card.role) parts.push(fieldText("role", card.role));
  if ((card.capabilities ?? []).length > 0) parts.push(fieldText("capabilities", card.capabilities.join(", ")));
  if (card.stoppingPoint) parts.push(fieldText("stopping", card.stoppingPoint));
  if (card.specHash) parts.push(fieldText("specHash", card.specHash));
  if (card.dodHash) parts.push(fieldText("dodHash", card.dodHash));
  if (card.specText !== null && card.specText !== undefined) parts.push(fieldText("specText", encodeFieldText(card.specText)));
  if (card.dodText !== null && card.dodText !== undefined) parts.push(fieldText("dodText", encodeFieldText(card.dodText)));
  if ((card.scope ?? []).length > 0) parts.push(fieldText("scope", card.scope.join(", ")));
  if ((card.unchangedPaths ?? []).length > 0) parts.push(fieldText("unchanged", card.unchangedPaths.join(", ")));
  if ((card.repositories ?? []).length > 0) parts.push(fieldText("repos", card.repositories.join(", ")));
  if ((card.tags ?? []).length > 0) parts.push(fieldText("tags", card.tags.join(", ")));
  if (card.provenance) parts.push(fieldText("provenance", card.provenance));
  if (card.importedId) parts.push(fieldText("importedId", card.importedId));
  if (card.authoritySource) parts.push(fieldText("authority", JSON.stringify(card.authoritySource)));
  let out = `- ${parts.join(" ")}`;
  if (card.description) out += `\n  ${card.description.replace(/\n/g, "\n  ")}`;
  return out;
}

export function serializeBoard(cards, { surface }) {
  const sections = [];
  for (const lane of LANES) {
    const laneCards = cards.filter((card) => card.lane === lane);
    const body = laneCards.map((card) => surface === "obsidian" ? serializeObsidianCard(card) : serializeTasksCard(card));
    sections.push(`## ${lane}${body.length > 0 ? `\n\n${body.join("\n")}` : ""}`);
  }
  return sections.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Trusted board writer (§3.5). Allocates the cardId, canonicalises and hashes,
// validates, persists atomically, records the authority source. Models never
// supply identifiers or hashes.
// ---------------------------------------------------------------------------

export function allocateCardId(cards, { prefix = "T" } = {}) {
  let max = 0;
  for (const card of cards) {
    const match = typeof card.cardId === "string" ? card.cardId.match(new RegExp(`^${prefix}-(\\d+)$`)) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

// The high-water mark is tracked durably in a writer state file next to the
// board so deleting the highest card can never cause ID reuse (§3.5: IDs are
// minted by the writer and never reused).
export function writerStatePath(boardPath) {
  return `${boardPath}.writer-state.json`;
}

function readHighWaterMark(statePath) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const value = Number(state?.highWaterMark);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function nextCardNumber(cards, prefix, statePath) {
  let max = readHighWaterMark(statePath);
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const card of cards) {
    const match = typeof card.cardId === "string" ? card.cardId.match(re) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function formatCardId(prefix, number) {
  return `${prefix}-${String(number).padStart(4, "0")}`;
}

// Writer serialization (§6 gate 2): a lock file created exclusively next to
// the board. A stale lock (older than the TTL) is removed only under the
// same exclusive-create discipline; anything else fails closed.
const LOCK_TTL_MS = 30_000;

export function writerLockPath(boardPath) {
  return `${boardPath}.lock`;
}

export function withWriterLock(boardPath, fn) {
  const lockPath = writerLockPath(boardPath);
  mkdirSync(dirname(boardPath), { recursive: true });
  for (;;) {
    let fd = null;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let age = null;
      try {
        age = Date.now() - Number(fsStatSync(lockPath).mtimeMs);
      } catch {
        age = null;
      }
      if (age === null || age > LOCK_TTL_MS) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another writer reclaimed or removed it; retry the exclusive create.
        }
        continue;
      }
      throw Object.assign(new Error("board writer lock is held by another writer"), { code: "writer-lock-held" });
    }
    try {
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}

export function recordAuthoritySource({ source, sessionOrReportId, quotedInstruction, digest } = {}) {
  if (source !== "instruction" && source !== "report-proposal") {
    throw Object.assign(new Error(`authority source must be "instruction" or "report-proposal", got "${source}"`), {
      code: "authority-source-invalid",
    });
  }
  if (typeof sessionOrReportId !== "string" || sessionOrReportId.trim() === "") {
    throw Object.assign(new Error("sessionOrReportId is required"), { code: "authority-source-invalid" });
  }
  if (typeof quotedInstruction === "string" && quotedInstruction.trim() !== "") {
    const record = { source, sessionOrReportId, quotedInstruction };
    return record;
  } else if (typeof quotedInstruction === "string" && quotedInstruction.trim() === "") {
    throw Object.assign(new Error("an authority source requires a quoted instruction or a digest of it"), {
      code: "authority-source-invalid",
    });
  } else if (typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) {
    return { source, sessionOrReportId, digest };
  } else {
    throw Object.assign(new Error("an authority source requires a quoted instruction or a caller-supplied digest"), {
      code: "authority-source-invalid",
    });
  }
  return record;
}

// The board's declared ID prefix: the first cardId on the board, else "T".
// A model-supplied idPrefix is only honored when it matches the declared
// prefix, so a model cannot mint a foreign ID space (§3.5).
export function declaredBoardPrefix(cards) {
  for (const card of cards) {
    const match = typeof card.cardId === "string" ? card.cardId.match(/^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})-(\d+)$/) : null;
    if (match) return match[1];
  }
  return "T";
}

// Writes a card into a board file. Every step is deterministic; the write is
// atomic (temp file + rename) so it lands complete or not at all. Declines
// before persist on any validation violation. Writer operations are
// serialized with a lock file; IDs come from a durable high-water mark.
export function writeCard({ boardPath, input, authority, registries = {}, surface = "tasks", now = null }) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  return withWriterLock(boardPath, () => writeCardLocked({ boardPath, input, authority, registries, surface, now }));
}

function writeCardLocked({ boardPath, input, authority, registries, surface, now }) {
  const markdown = existsSync(boardPath) ? readFileSync(boardPath, "utf8") : "";
  // Existing boards are validated against the complete persisted
  // representation, not merely parsed (§6 gate 2).
  const validatedBoard = validateBoard(markdown);
  if (!validatedBoard.ok) {
    return { ok: false, code: "board-invalid", errors: validatedBoard.errors, persisted: false };
  }
  const parsed = { cards: validatedBoard.cards };
  const declaredPrefix = declaredBoardPrefix(parsed.cards);
  const prefix = input.idPrefix ?? declaredPrefix;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(prefix) || prefix !== declaredPrefix) {
    return {
      ok: false,
      code: "id-prefix-rejected",
      errors: [`idPrefix "${prefix}" does not match the board's declared prefix "${declaredPrefix}"`],
      persisted: false,
    };
  }
  const statePath = writerStatePath(boardPath);
  const nextNumber = nextCardNumber(parsed.cards, prefix, statePath);
  const cardId = formatCardId(prefix, nextNumber);
  if (parsed.cards.some((card) => card.cardId === cardId)) {
    return { ok: false, code: "duplicate-card-id", errors: [`cardId "${cardId}" already exists`], persisted: false };
  }
  const specText = input.spec !== undefined ? nfc(String(input.spec)) : null;
  const dodText = input.definitionOfDone !== undefined ? nfc(String(input.definitionOfDone)) : null;
  const card = {
    cardId,
    lane: input.lane ?? "backlog",
    title: sanitizeFreeText(input.title),
    flags: [...(input.flags ?? [])],
    priority: input.priority ?? null,
    dependencies: [...(input.dependencies ?? [])],
    base: input.base ?? null,
    due: input.due ?? null,
    role: input.role ?? null,
    capabilities: [...(input.capabilities ?? [])],
    stoppingPoint: input.stoppingPoint !== null && input.stoppingPoint !== undefined
      ? sanitizeFreeText(input.stoppingPoint)
      : null,
    specHash: specText !== null ? computeSpecHash(specText) : null,
    dodHash: dodText !== null ? computeSpecHash(dodText) : null,
    specText,
    dodText,
    scope: [...(input.scope ?? [])],
    unchangedPaths: [...(input.unchangedPaths ?? [])],
    repositories: [...(input.repositories ?? [])],
    tags: [...(input.tags ?? [])],
    provenance: input.provenance !== undefined && input.provenance !== null ? sanitizeFreeText(input.provenance) : null,
    importedId: input.importedId ?? null,
    authoritySource: recordAuthoritySource(authority),
    description: sanitizeFreeText(input.description),
    done: false,
  };
  const validation = validateCard(card, { ...registries, userLevel: input.userLevel ?? false });
  if (!validation.ok) {
    return { ok: false, code: "validation-failed", errors: validation.errors, persisted: false, cardId };
  }
  card.hash = computeCardHash(card);
  const existingCards = parsed.cards.map((existing) => ({ ...existing, hash: existing.hash ?? computeCardHash(existing) }));
  const serialized = serializeBoard([...existingCards, card], { surface });
  // The complete resulting board representation is validated before the
  // atomic rename (§6 gate 2) — not just the in-memory new card.
  const roundTrip = validateBoard(serialized);
  if (!roundTrip.ok) {
    return { ok: false, code: "serialization-invalid", errors: roundTrip.errors, persisted: false, cardId };
  }
  mkdirSync(dirname(boardPath), { recursive: true });
  const tmpPath = `${boardPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, serialized, "utf8");
  renameSync(tmpPath, boardPath);
  writeFileSync(statePath, JSON.stringify({ highWaterMark: nextNumber }, null, 2) + "\n", "utf8");
  return { ok: true, cardId, card: Object.freeze({ ...card }), persisted: true, ...(now ? { now } : {}) };
}

// ---------------------------------------------------------------------------
// Dispatchability (§3.3) — a pure function. The validator states which
// condition failed.
// ---------------------------------------------------------------------------

export function isDispatchable(card, boardIndex) {
  const failed = [];
  if (card.lane !== "backlog") failed.push(`lane is "${card.lane}", not "backlog"`);
  if ((card.flags ?? []).includes("proposed")) failed.push("card carries the #proposed flag");
  if ((card.flags ?? []).includes("blocked")) failed.push("card carries the #blocked flag");
  if ((card.flags ?? []).includes("cancelled")) failed.push("card carries the #cancelled flag");
  if (!card.specHash) failed.push("specification hash missing");
  if (!card.dodHash) failed.push("definition-of-done hash missing");
  // B1: a present, valid, matching card hash is REQUIRED — a missing hash
  // never dispatches (fails closed).
  if (!card.hash) {
    failed.push("card hash missing (fails closed)");
  } else if (card.hash !== computeCardHash(card)) {
    failed.push("card hash is stale or tampered (fails closed)");
  }
  // B2: spec and DoD hashes are recomputed from the persisted text and
  // compared; a mismatch or absent text fails closed.
  if (card.specText === null || card.specText === undefined) {
    failed.push("specification text missing (hash cannot be verified)");
  } else if (computeSpecHash(card.specText) !== card.specHash) {
    failed.push("specification hash does not match the persisted specification text (fails closed)");
  }
  if (card.dodText === null || card.dodText === undefined) {
    failed.push("definition-of-done text missing (hash cannot be verified)");
  } else if (computeSpecHash(card.dodText) !== card.dodHash) {
    failed.push("definition-of-done hash does not match the persisted text (fails closed)");
  }
  // B4: dispatch requires a well-formed authority-source record (§3.5).
  if (!isValidAuthoritySource(card.authoritySource)) {
    failed.push("no well-formed authority-source record (fails closed)");
  }
  if (!card.stoppingPoint) failed.push("stopping point not declared");
  if (!(card.scope ?? []).length) failed.push("scope paths not declared");
  for (const dep of card.dependencies ?? []) {
    const depCard = boardIndex?.get?.(dep);
    if (!depCard) {
      failed.push(`dependency "${dep}" does not exist`);
    } else if (depCard.lane !== "done") {
      failed.push(`dependency "${dep}" is in lane "${depCard.lane}", not "done"`);
    } else if ((depCard.flags ?? []).includes("cancelled")) {
      failed.push(`dependency "${dep}" is cancelled`);
    }
  }
  return { dispatchable: failed.length === 0, failedConditions: failed };
}

// ---------------------------------------------------------------------------
// Provider observation (§5 reversibility): everything registers behind the
// observation that a board file exists. No board file, no behavior change and
// no new tool.
// ---------------------------------------------------------------------------

export function observeBoardProvider({ boardPath }) {
  const present = typeof boardPath === "string" && boardPath !== "" && existsSync(boardPath);
  return { present, boardPath: present ? boardPath : null };
}

export function registerKanbanBoardTools(pi, { boardPath } = {}) {
  const observation = observeBoardProvider({ boardPath });
  if (!observation.present) return { registered: [], observation };
  // Additive, read-only, fail-closed: registered only behind the observation,
  // so removing the board file removes the surface (§5).
  const registered = [];
  if (typeof pi?.registerTool === "function") {
    pi.registerTool({
      name: "agentic_kanban_board",
      label: "Kanban Board",
      description: "Read-only view of the validated task board: lanes, flags, priorities, dependencies, and dispatchability. The board is additive and grants no authority; agents read it and act within card states.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        let value;
        try {
          const markdown = readFileSync(observation.boardPath, "utf8");
          const validated = validateBoard(markdown);
          value = validated.ok
            ? { ok: true, nonAuthorizing: true, persisted: false, cards: validated.cards, errors: [] }
            : { ok: false, nonAuthorizing: true, persisted: false, cards: [], errors: validated.errors };
        } catch (error) {
          value = { ok: false, nonAuthorizing: true, persisted: false, cards: [], errors: [String(error?.message || error).slice(0, 512)] };
        }
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
      },
    });
    registered.push("agentic_kanban_board");
  }
  return { registered, observation };
}
