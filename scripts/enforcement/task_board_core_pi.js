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

import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, chmodSync, statSync as fsStatSync } from "node:fs";
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

// Field-key aliases the parser accepts (F5). Duplicate detection and the
// semantic mapping both go through the canonical key, so semantic aliases
// ([specHash:: x] vs [spec-hash:: x]) collide as duplicates fail-closed.
export const FIELD_KEY_ALIASES = Object.freeze({
  "stopping-point": "stopping",
  "spec-hash": "specHash",
  "dod-hash": "dodHash",
  "spec-text": "specText",
  "dod-text": "dodText",
});

export function canonicalFieldKey(key) {
  return FIELD_KEY_ALIASES[key] ?? key;
}
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

// F2: only the canonical base64url encoding is accepted. The decoded bytes
// are re-encoded and compared to the original string exactly, so a permissive
// decoder cannot smuggle non-canonical input ('***' and friends decode to
// nothing usable and are rejected).
export function decodeFieldText(encoded) {
  if (typeof encoded !== "string" || encoded === "") return null;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) return null;
    return decoded;
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
    const key = canonicalFieldKey(match[1]);
    const value = match[2].trim();
    if (key === "id") {
      if (idField !== null) errors.push("duplicate [id:: ...] field");
      idField = value;
    } else if (key === "flag") {
      if (!FLAGS.includes(value)) {
        errors.push(`unknown flag "${value}" (closed enum: ${FLAGS.join(", ")})`);
      } else if (flags.includes(value)) {
        // F5: a repeated flag is a duplicate error; distinct flags on one
        // card are fine.
        errors.push(`duplicate [flag:: ${value}] field on one card line (injection rejected)`);
      } else {
        flags.push(value);
      }
    } else {
      // Duplicate authority-bearing fields are ambiguous (last-value-wins is
      // an injection vector); reject fail-closed (M2). Keys are compared
      // through the canonical alias map so semantic aliases collide too (F5).
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
  if (LANES.includes(name)) return name;
  // Obsidian display lane names (the derived projection's headings) map onto
  // the canonical closed lanes — one semantic model, two surfaces (§1).
  const display = { backlog: "backlog", "in progress": "in-progress", review: "review", done: "done" };
  return display[name] ?? null;
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
    // Field keys are already canonicalized by the parser (F5).
    stoppingPoint: f.stopping ?? null,
    specHash: f.specHash ?? null,
    dodHash: f.dodHash ?? null,
    specText: decodeFieldText(f.specText),
    dodText: decodeFieldText(f.dodText),
    scope: f.scope ? f.scope.split(/[\s,]+/).filter(Boolean) : [],
    unchangedPaths: f.unchanged ? f.unchanged.split(/[\s,]+/).filter(Boolean) : [],
    repositories: f.repos ? f.repos.split(/[\s,]+/).filter(Boolean) : [],
    tags: f.tags ? f.tags.split(/[\s,]+/).filter(Boolean) : [],
    provenance: f.provenance ?? null,
    importedId: f.importedId ?? null,
    hash: f.hash ?? null,
    authoritySource: f.authority ? safeJsonParse(f.authority) : null,
    authorityWriterHmac: f.authorityHmac ?? null,
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
// "report-proposal", sessionOrReportId, quotedInstruction-or-digest}. The
// shape is closed (F1): exactly these three fields, and exactly one of
// quotedInstruction or digest. A malformed or absent record is never
// dispatchable.
export function isValidAuthoritySource(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  if (typeof record === "object" && "writerHmac" in record) return false;
  const keys = Object.keys(record);
  if (keys.length !== 3) return false;
  for (const key of keys) {
    if (key !== "source" && key !== "sessionOrReportId" && key !== "quotedInstruction" && key !== "digest") return false;
  }
  if (record.source !== "instruction" && record.source !== "report-proposal") return false;
  if (typeof record.sessionOrReportId !== "string" || record.sessionOrReportId.trim() === "") return false;
  const hasInstruction = typeof record.quotedInstruction === "string" && record.quotedInstruction.trim() !== "";
  const hasDigest = typeof record.digest === "string" && /^[0-9a-f]{64}$/.test(record.digest);
  // Exactly one of quotedInstruction or digest — never both, never neither.
  return hasInstruction !== hasDigest;
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
  if (card.authorityWriterHmac) parts.push(fieldText("authorityHmac", card.authorityWriterHmac));
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
  if (card.authorityWriterHmac) parts.push(fieldText("authorityHmac", card.authorityWriterHmac));
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

// ---------------------------------------------------------------------------
// The Obsidian projection (§2 derived projection). After every successful
// write/update/delete to the canonical TASKS.md board, a sibling projection
// file is RECOMPUTED from the canonical Markdown — never incrementally
// patched, never read back as authority. The read tool (agentic_kanban_board)
// reads only the canonical board file; if the canonical board is deleted the
// projection is stale-by-design and is ignored by every reader. The
// projection exists purely so the Obsidian Kanban plugin can render the same
// semantic model (§1: one semantic model, two surfaces).
//
// Projection path: a sibling "board.md" next to the canonical board. When the
// canonical board is itself named board.md (test/dev setups), the projection
// is "board.projection.md" so the canonical file is never overwritten by its
// own view.
// ---------------------------------------------------------------------------

export function projectionPath(boardPath) {
  const file = boardPath.split("/").pop();
  const name = file === "board.md" ? "board.projection.md" : "board.md";
  return join(dirname(boardPath), name);
}

// Recompute the projection from the canonical cards. Best-effort relative to
// the authoritative write: a projection failure is reported but never rolls
// back or invalidates the canonical persist.
export function writeProjection(boardPath, cards) {
  const path = projectionPath(boardPath);
  try {
    const frontmatter = "---\nkanban-plugin: board\n---\n\n";
    const body = serializeBoard(cards, { surface: "obsidian" })
      .replace(/^## backlog$/m, "## Backlog")
      .replace(/^## in-progress$/m, "## In Progress")
      .replace(/^## review$/m, "## Review")
      .replace(/^## done$/m, "## Done");
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, frontmatter + body, "utf8");
    renameSync(tmpPath, path);
    return { written: true, path, error: null };
  } catch (error) {
    return { written: false, path, error: String(error?.message || error).slice(0, 512) };
  }
}

export function allocateCardId(cards, { prefix = "T" } = {}) {
  let max = 0;
  for (const card of cards) {
    const match = typeof card.cardId === "string" ? card.cardId.match(new RegExp(`^${prefix}-(\\d+)$`)) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

// The high-water mark, the per-board HMAC secret, and the issued-cardId
// ledger are tracked durably in a writer state file next to the board
// (§3.5: IDs are minted by the writer and never reused).
//
// TRUST MODEL (F1, stated honestly): the user who owns the machine can edit
// both the board and this state file and can always forge a valid-looking
// authority record. That is accepted — the machine owner is trusted. The
// boundary this scheme enforces is against AGENT and other-figure edits:
// cards not written through the trusted writer cannot dispatch, because
// dispatch requires (a) the cardId to appear in the writer's issued-IDs
// ledger in the state file, and (b) the authority record's HMAC-SHA256,
// keyed by the state-file secret, to verify. A hand-edited card with a new
// cardId is not in the ledger; a hand-edited card reusing an issued cardId
// fails the HMAC or the hash comparison. An agent that edits only the board
// file cannot manufacture dispatch eligibility.
export function writerStatePath(boardPath) {
  return `${boardPath}.writer-state.json`;
}

function readWriterState(statePath) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const value = Number(state?.highWaterMark);
    return {
      highWaterMark: Number.isInteger(value) && value >= 0 ? value : 0,
      secret: typeof state?.secret === "string" && state.secret !== "" ? state.secret : null,
      issuedCardIds: Array.isArray(state?.issuedCardIds) ? state.issuedCardIds.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return { highWaterMark: 0, secret: null, issuedCardIds: [] };
  }
}

// HMAC over the canonical JSON form of {authority record, card hash}, keyed
// by the per-board secret held in the writer state file (F1). Binding the
// card hash into the HMAC means a hand-edited card that reuses an issued
// cardId and copies the record fails: any hash-bearing edit changes the card
// hash and the HMAC no longer verifies. The digest is stored beside the
// record — the record itself keeps exactly its three closed fields.
export function authorityRecordHmac(record, secret, cardHash) {
  return createHmac("sha256", secret)
    .update(canonicalJsonString({ record, cardHash }), "utf8")
    .digest("hex");
}

// Dispatch-time authority verification (F1): the record must be well-formed,
// carry a writerHmac that verifies against the state file's secret AND the
// card's recomputed hash, and the cardId must appear in the writer's
// issued-IDs ledger. A hand-edited card fails at least one of these.
export function verifyAuthorityProvenance({ authoritySource, cardId, cardHash, statePath }) {
  const state = readWriterState(statePath);
  // The writerHmac travels beside the record; validate the bare record.
  const { writerHmac, ...bareRecord } = authoritySource ?? {};
  if (!isValidAuthoritySource(bareRecord)) {
    return { ok: false, reason: "no well-formed authority-source record (fails closed)" };
  }
  if (state.secret === null) {
    return { ok: false, reason: "writer state file has no secret (fails closed)" };
  }
  const expected = authorityRecordHmac(bareRecord, state.secret, cardHash);
  if (writerHmac !== expected) {
    return { ok: false, reason: "authority-source HMAC does not verify against the writer state (fails closed)" };
  }
  if (!state.issuedCardIds.includes(cardId)) {
    return { ok: false, reason: `cardId "${cardId}" was not issued by the trusted writer (fails closed)` };
  }
  return { ok: true, reason: null };
}

function writeWriterState(statePath, state) {
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, statePath);
}

function nextCardNumber(cards, prefix, state) {
  let max = state.highWaterMark;
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
// the board. The lock content is a random owner token (F3): a stale lock is
// reclaimed only by compare-and-delete — the reclaimer reads the observed
// token, and unlinks only if the content still equals that token at unlink
// time. Each writer's finally unlinks only if the content still equals its
// own token, so a second writer can never unlink a live lock out from under
// the first, and the first can never unlink the second's.
const LOCK_TTL_MS = 30_000;

export function writerLockPath(boardPath) {
  return `${boardPath}.lock`;
}

function readLockToken(lockPath) {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

// Compare-and-delete: unlink only if the content still equals the expected
// token. Returns true when this caller removed the lock.
function unlinkIfToken(lockPath, expectedToken) {
  const observed = readLockToken(lockPath);
  if (observed === null || observed !== expectedToken) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function withWriterLock(boardPath, fn) {
  const lockPath = writerLockPath(boardPath);
  mkdirSync(dirname(boardPath), { recursive: true });
  for (;;) {
    const token = randomBytes(16).toString("hex") + "\n";
    let fd = null;
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(lockPath, token, { flag: "r+" });
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      let age = null;
      try {
        age = Date.now() - Number(fsStatSync(lockPath).mtimeMs);
      } catch {
        age = null;
      }
      if (age === null || age > LOCK_TTL_MS) {
        // F3: reclaim a stale lock by compare-and-delete against the token
        // observed now. If another writer replaced it in the meantime, the
        // token no longer matches and we retry without unlinking anything.
        const observedToken = readLockToken(lockPath);
        if (observedToken !== null && unlinkIfToken(lockPath, observedToken)) continue;
        if (observedToken === null) continue; // vanished; retry the create
        throw Object.assign(new Error("board writer lock is held by another writer"), { code: "writer-lock-held" });
      }
      throw Object.assign(new Error("board writer lock is held by another writer"), { code: "writer-lock-held" });
    }
    try {
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {}
      // Only unlink if the lock still holds OUR token (F3).
      unlinkIfToken(lockPath, token);
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
    return { source, sessionOrReportId, quotedInstruction };
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
export function writeCard({ boardPath, input, authority, registries = {}, surface = "tasks", now = null, requireExistingBoard = false }) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  return withWriterLock(boardPath, () => writeCardLocked({ boardPath, input, authority, registries, surface, now, requireExistingBoard }));
}

function writeCardLocked({ boardPath, input, authority, registries, surface, now, requireExistingBoard }) {
  // Authoritative board-presence check, made under the writer lock (TOCTOU
  // fix): when requireExistingBoard is set — the tool path — a board deleted
  // between the caller's outer observation and this locked write must fail
  // closed as board-unavailable. Without this, the absent file would be
  // treated as an empty board and silently recreated. The direct writer API
  // retains fresh-board bootstrap (requireExistingBoard defaults to false);
  // an empty file is a valid fresh board either way — only a missing file
  // fails when the flag is set.
  if (requireExistingBoard && !existsSync(boardPath)) {
    return {
      ok: false,
      code: "board-unavailable",
      reason: "board file is no longer present (board-unavailable)",
      errors: ["board file is no longer present (board-unavailable)"],
      persisted: false,
    };
  }
  const markdown = existsSync(boardPath) ? readFileSync(boardPath, "utf8") : "";
  // Existing boards are validated against the complete persisted
  // representation, not merely parsed (§6 gate 2).
  const validatedBoard = validateBoard(markdown, registries);
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
  let state = readWriterState(statePath);
  // F7(a): if the state file is missing but the board is non-empty, recover
  // the high-water mark from the board and write the state file immediately
  // under the lock. Deleting BOTH the board and the state file is out of
  // scope — that is a fresh board.
  if (state.secret === null && parsed.cards.length > 0) {
    state = { highWaterMark: state.highWaterMark, secret: randomBytes(32).toString("hex"), issuedCardIds: [] };
    writeWriterState(statePath, state);
  } else if (state.secret === null) {
    state = { highWaterMark: 0, secret: randomBytes(32).toString("hex"), issuedCardIds: [] };
  }
  const nextNumber = nextCardNumber(parsed.cards, prefix, state);
  const cardId = formatCardId(prefix, nextNumber);
  if (parsed.cards.some((card) => card.cardId === cardId)) {
    return { ok: false, code: "duplicate-card-id", errors: [`cardId "${cardId}" already exists`], persisted: false };
  }
  const specText = input.spec !== undefined && input.spec !== null ? nfc(String(input.spec)) : null;
  const dodText = input.definitionOfDone !== undefined && input.definitionOfDone !== null ? nfc(String(input.definitionOfDone)) : null;
  // F2: spec/DoD text must be non-empty — an empty specification can never
  // dispatch.
  if (specText !== null && specText.trim() === "") {
    return { ok: false, code: "empty-specification", errors: ["specification text must be non-empty"], persisted: false };
  }
  if (dodText !== null && dodText.trim() === "") {
    return { ok: false, code: "empty-definition-of-done", errors: ["definition-of-done text must be non-empty"], persisted: false };
  }
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
  card.hash = computeCardHash(card);
  // F1: writer-authenticated provenance — HMAC over {record, cardHash} keyed
  // by the state-file secret, stored beside the record.
  card.authorityWriterHmac = authorityRecordHmac(card.authoritySource, state.secret, card.hash);
  const existingCards = parsed.cards.map((existing) => ({ ...existing, hash: existing.hash ?? computeCardHash(existing) }));
  const serialized = serializeBoard([...existingCards, card], { surface });
  // The complete resulting board representation is validated before the
  // atomic rename (§6 gate 2) — not just the in-memory new card.
  const roundTrip = validateBoard(serialized, registries);
  if (!roundTrip.ok) {
    return { ok: false, code: "serialization-invalid", errors: roundTrip.errors, persisted: false, cardId };
  }
  mkdirSync(dirname(boardPath), { recursive: true });
  const tmpPath = `${boardPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, serialized, "utf8");
  renameSync(tmpPath, boardPath);
  // F1: the issued-IDs ledger is updated atomically with the card write,
  // under the same lock. The HMAC over the authority record is computed
  // against the state-file secret and stored beside the record.
  state.highWaterMark = nextNumber;
  if (!state.issuedCardIds.includes(cardId)) state.issuedCardIds.push(cardId);
  writeWriterState(statePath, state);
  // §2 derived projection: recomputed from the just-persisted canonical board
  // on every mutation; a view only, never authority, stale-by-design if the
  // canonical board is removed.
  const projection = writeProjection(boardPath, [...existingCards, card]);
  return { ok: true, cardId, card: Object.freeze({ ...card }), persisted: true, projection, ...(now ? { now } : {}) };
}

// ---------------------------------------------------------------------------
// Card update and delete (§3.5): every board operation a user could express
// goes through the trusted writer with a REQUIRED authority record, recorded
// with the same HMAC + provenance discipline as creation. The card hash is
// recomputed after any change; spec/DoD text updates recompute their hashes;
// completion (done=true) requires human authority — an instruction or an
// approved proposal — never an agent report alone.
// ---------------------------------------------------------------------------

const UPDATABLE_LIST_FIELDS = [
  ["scopePaths", "scope"],
  ["capabilities", "capabilities"],
  ["dependencies", "dependencies"],
  ["tags", "tags"],
];

// Apply a changes subset to a parsed card. Returns a plain updated card (hash
// not yet recomputed) or an error descriptor.
function applyCardChanges(card, changes) {
  const updated = { ...card, flags: [...(card.flags ?? [])] };
  const changed = [];
  const c = changes ?? {};

  if (c.lane !== undefined) {
    if (!LANES.includes(c.lane)) {
      return { error: { code: "invalid-lane", errors: [`lane "${c.lane}" is not one of ${LANES.join(", ")}`] } };
    }
    updated.lane = c.lane;
    changed.push("lane");
  }
  if (c.done !== undefined) {
    updated.done = Boolean(c.done);
    // Moving to done sets the done checkbox AND the lane (§1 lifecycle).
    if (c.done) updated.lane = "done";
    changed.push("done");
  }
  if (c.flags !== undefined) {
    // Accept {add: [], remove: []} or a full replacement array.
    if (Array.isArray(c.flags)) {
      updated.flags = [...c.flags];
    } else if (c.flags && typeof c.flags === "object") {
      const set = new Set(updated.flags);
      for (const flag of c.flags.add ?? []) set.add(flag);
      for (const flag of c.flags.remove ?? []) set.delete(flag);
      updated.flags = [...set];
    } else {
      return { error: { code: "invalid-flags", errors: ["flags must be an array or {add, remove}"] } };
    }
    changed.push("flags");
  }
  if (c.title !== undefined) {
    if (typeof c.title !== "string" || c.title.trim() === "") {
      return { error: { code: "invalid-title", errors: ["title must be a non-empty string"] } };
    }
    updated.title = sanitizeFreeText(c.title);
    changed.push("title");
  }
  if (c.description !== undefined) {
    updated.description = sanitizeFreeText(c.description);
    changed.push("description");
  }
  if (c.priority !== undefined) {
    if (c.priority !== null && !PRIORITIES.includes(c.priority)) {
      return { error: { code: "invalid-priority", errors: [`priority "${c.priority}" is not one of ${PRIORITIES.join(", ")}`] } };
    }
    updated.priority = c.priority;
    changed.push("priority");
  }
  for (const [textField, hashField] of [["specification", "specHash", "specText"], ["definitionOfDone", "dodHash", "dodText"]]) {
    if (c[textField] !== undefined) {
      const text = c[textField] === null ? null : nfc(String(c[textField]));
      if (text !== null && text.trim() === "") {
        return { error: { code: textField === "specification" ? "empty-specification" : "empty-definition-of-done", errors: [`${textField} text must be non-empty`] } };
      }
      updated[textField === "specification" ? "specText" : "dodText"] = text;
      updated[hashField] = text !== null ? computeSpecHash(text) : null;
      changed.push(textField);
    }
  }
  if (c.stoppingPoint !== undefined) {
    updated.stoppingPoint = c.stoppingPoint === null ? null : sanitizeFreeText(c.stoppingPoint);
    changed.push("stoppingPoint");
  }
  for (const [inputKey, cardKey] of UPDATABLE_LIST_FIELDS) {
    if (c[inputKey] !== undefined) {
      if (!Array.isArray(c[inputKey])) {
        return { error: { code: `invalid-${inputKey}`, errors: [`${inputKey} must be an array (full replacement list)`] } };
      }
      updated[cardKey] = [...c[inputKey]];
      changed.push(inputKey);
    }
  }
  if (c.base !== undefined) {
    updated.base = c.base;
    changed.push("base");
  }
  if (c.dueDate !== undefined) {
    updated.due = c.dueDate;
    changed.push("dueDate");
  }
  if (c.role !== undefined) {
    updated.role = c.role;
    changed.push("role");
  }
  return { updated, changed };
}

// Update an existing card through the trusted writer. `changes` is any subset
// of: lane, done, flags, title, description, priority, specification,
// definitionOfDone, stoppingPoint, scopePaths, capabilities, dependencies
// (full replacement list), base, dueDate, role, tags. The authority record is
// REQUIRED and re-recorded (HMAC bound to the recomputed card hash).
export function updateCard({ boardPath, cardId, changes, authority, registries = {}, surface = "tasks", now = null }) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  if (typeof cardId !== "string" || cardId === "") {
    throw Object.assign(new Error("cardId is required"), { code: "card-id-required" });
  }
  return withWriterLock(boardPath, () => updateCardLocked({ boardPath, cardId, changes, authority, registries, surface, now }));
}

function updateCardLocked({ boardPath, cardId, changes, authority, registries, surface, now }) {
  if (!existsSync(boardPath)) {
    return { ok: false, code: "board-unavailable", reason: "board file is no longer present (board-unavailable)", errors: ["board file is no longer present (board-unavailable)"], persisted: false };
  }
  const validatedBoard = validateBoard(readFileSync(boardPath, "utf8"), registries);
  if (!validatedBoard.ok) {
    return { ok: false, code: "board-invalid", errors: validatedBoard.errors, persisted: false };
  }
  const index = validatedBoard.cards.findIndex((card) => card.cardId === cardId);
  if (index === -1) {
    return { ok: false, code: "card-not-found", errors: [`cardId "${cardId}" does not exist on the board`], persisted: false };
  }
  // Completion is human-only (§3.1): marking a card done requires the
  // authority source to be an instruction or an approved report proposal.
  // An agent report alone is never completion.
  if (changes?.done === true) {
    const source = authority?.source;
    if (source !== "instruction" && source !== "report-proposal") {
      return {
        ok: false,
        code: "completion-authority-required",
        errors: ["marking a card done requires human authority: an instruction or an approved report proposal; an agent report alone is never completion"],
        persisted: false,
        cardId,
      };
    }
  }
  // The authority record is REQUIRED for every mutation and is validated
  // exactly as at creation (recordAuthoritySource throws on malformation).
  const record = recordAuthoritySource(authority);
  const { updated, changed, error } = applyCardChanges(validatedBoard.cards[index], changes);
  if (error) return { ok: false, code: error.code, errors: error.errors, persisted: false, cardId };
  if (changed.length === 0) {
    return { ok: false, code: "no-changes", errors: ["changes must contain at least one updatable field"], persisted: false, cardId };
  }
  const validation = validateCard(updated, registries);
  if (!validation.ok) {
    return { ok: false, code: "validation-failed", errors: validation.errors, persisted: false, cardId };
  }
  // The card hash is recomputed after ANY change (§1 hash binding).
  updated.hash = computeCardHash(updated);
  // F1: the re-recorded authority HMAC binds to the NEW card hash.
  updated.authoritySource = record;
  const statePath = writerStatePath(boardPath);
  const state = readWriterState(statePath);
  if (state.secret === null) {
    return { ok: false, code: "writer-state-unavailable", errors: ["writer state file has no secret (fails closed)"], persisted: false, cardId };
  }
  updated.authorityWriterHmac = authorityRecordHmac(record, state.secret, updated.hash);
  const cards = validatedBoard.cards.map((card, i) => (i === index ? updated : card));
  const serialized = serializeBoard(cards, { surface });
  const roundTrip = validateBoard(serialized, registries);
  if (!roundTrip.ok) {
    return { ok: false, code: "serialization-invalid", errors: roundTrip.errors, persisted: false, cardId };
  }
  const tmpPath = `${boardPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, serialized, "utf8");
  renameSync(tmpPath, boardPath);
  // Derived projection recomputed from the canonical board after the mutation.
  const projection = writeProjection(boardPath, cards);
  return { ok: true, cardId, card: Object.freeze({ ...updated }), changedFields: changed, persisted: true, projection, ...(now ? { now } : {}) };
}

// Remove a card from the board through the trusted writer. The issued-ID
// ledger KEEPS the ID forever — a deleted cardId is never reused. Deletion is
// a consequential action and requires the same REQUIRED authority record.
export function deleteCard({ boardPath, cardId, authority, registries = {}, surface = "tasks", now = null }) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  if (typeof cardId !== "string" || cardId === "") {
    throw Object.assign(new Error("cardId is required"), { code: "card-id-required" });
  }
  return withWriterLock(boardPath, () => deleteCardLocked({ boardPath, cardId, authority, registries, surface, now }));
}

function deleteCardLocked({ boardPath, cardId, authority, registries, surface, now }) {
  if (!existsSync(boardPath)) {
    return { ok: false, code: "board-unavailable", reason: "board file is no longer present (board-unavailable)", errors: ["board file is no longer present (board-unavailable)"], persisted: false };
  }
  const validatedBoard = validateBoard(readFileSync(boardPath, "utf8"), registries);
  if (!validatedBoard.ok) {
    return { ok: false, code: "board-invalid", errors: validatedBoard.errors, persisted: false };
  }
  if (!validatedBoard.cards.some((card) => card.cardId === cardId)) {
    return { ok: false, code: "card-not-found", errors: [`cardId "${cardId}" does not exist on the board`], persisted: false };
  }
  // Authority is REQUIRED for deletion too; validate exactly as at creation.
  recordAuthoritySource(authority);
  const cards = validatedBoard.cards.filter((card) => card.cardId !== cardId);
  const serialized = cards.length > 0 ? serializeBoard(cards, { surface }) : "";
  const roundTrip = validateBoard(serialized, registries);
  if (!roundTrip.ok) {
    // A dangling dependency on the deleted card fails closed.
    return { ok: false, code: "dependency-referenced", errors: roundTrip.errors, persisted: false, cardId };
  }
  const tmpPath = `${boardPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, serialized, "utf8");
  renameSync(tmpPath, boardPath);
  // The issued-ID ledger keeps the deleted ID forever — never reused.
  const projection = writeProjection(boardPath, cards);
  return { ok: true, cardId, removed: true, persisted: true, projection, ...(now ? { now } : {}) };
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
  } else if (String(card.specText).trim() === "") {
    // F2: an empty specification never dispatches.
    failed.push("specification text is empty (fails closed)");
  } else if (computeSpecHash(card.specText) !== card.specHash) {
    failed.push("specification hash does not match the persisted specification text (fails closed)");
  }
  if (card.dodText === null || card.dodText === undefined) {
    failed.push("definition-of-done text missing (hash cannot be verified)");
  } else if (String(card.dodText).trim() === "") {
    // F2: an empty definition of done never dispatches.
    failed.push("definition-of-done text is empty (fails closed)");
  } else if (computeSpecHash(card.dodText) !== card.dodHash) {
    failed.push("definition-of-done hash does not match the persisted text (fails closed)");
  }
  // B4: dispatch requires a well-formed authority-source record (§3.5).
  // F1: when the writer state is available, the record must additionally
  // verify against it — the HMAC over {record, cardHash} must match the
  // state-file secret, and the cardId must be in the writer's issued-IDs
  // ledger. Cards not written through the trusted writer cannot dispatch.
  if (card.authoritySource === null || card.authoritySource === undefined) {
    failed.push("no well-formed authority-source record (fails closed)");
  } else if (typeof card.statePath === "string" && card.statePath !== "") {
    const provenance = verifyAuthorityProvenance({
      authoritySource: { ...card.authoritySource, writerHmac: card.authorityWriterHmac },
      cardId: card.cardId,
      cardHash: card.hash ?? null,
      statePath: card.statePath,
    });
    if (!provenance.ok) failed.push(provenance.reason);
  } else {
    // No writer state available: the bare record must still be well-formed
    // and writer-authenticated.
    const bare = { ...card.authoritySource };
    delete bare.writerHmac;
    if (!isValidAuthoritySource(bare)) {
      failed.push("no well-formed authority-source record (fails closed)");
    } else if (card.authorityWriterHmac === undefined || card.authorityWriterHmac === null || "writerHmac" in card.authoritySource) {
      // The HMAC lives beside the record; a record carrying it inline was not
      // written by the trusted writer.
      failed.push("authority-source provenance missing or malformed (fails closed)");
    }
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

export function registerKanbanBoardTools(pi, { boardPath = null, resolveBoardPath = null } = {}) {
  // Board resolution happens per tool call, not at registration: Pi
  // extensions receive only the ExtensionAPI at registration (ctx is
  // per-tool-call), so a static boardPath observed at startup is wrong for
  // multi-workspace sessions and undefined cwd breaks resolution entirely.
  // Registration is unconditional; the surface is gated per call — no board
  // for the calling workspace yields a structured board-unavailable result
  // (reversibility preserved: no board file, nothing happens).
  const boardPathFor = (ctx) => {
    if (typeof resolveBoardPath === "function") return resolveBoardPath(ctx);
    return typeof boardPath === "string" && boardPath !== "" ? boardPath : null;
  };
  const observation = observeBoardProvider({ boardPath: boardPathFor(undefined) ?? undefined });
  const registered = [];
  const unavailableValue = (extra = {}) => ({
    ok: false,
    persisted: false,
    boardUnavailable: true,
    code: "board-unavailable",
    reason: "no board file found for this workspace (board-unavailable)",
    errors: ["no board file found for this workspace (board-unavailable)"],
    ...extra,
  });
  const unavailableResult = (extra = {}) => {
    const value = unavailableValue(extra);
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
  };
  if (typeof pi?.registerTool === "function") {
    pi.registerTool({
      name: "agentic_kanban_board",
      label: "Kanban Board",
      description: "Read-only view of the validated task board: lanes, flags, priorities, dependencies, and dispatchability. The board is additive and grants no authority; agents read it and act within card states.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        // Per-call board resolution + F7(b) re-observation. No board for the
        // calling workspace, or the board removed after registration:
        // observed board-unavailable, never a stale board, never a throw.
        const activeBoardPath = boardPathFor(ctx);
        if (!activeBoardPath || !existsSync(activeBoardPath)) {
          return unavailableResult({ nonAuthorizing: true, cards: [] });
        }
        let value;
        try {
          const markdown = readFileSync(activeBoardPath, "utf8");
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
  // The write tool (§3.5): card creation goes through the trusted writer
  // only. The tool never accepts a model-supplied cardId (the writer mints
  // it) and never accepts hashes (the writer computes them). It DOES accept
  // the authority record — that record is the governance input this tool
  // exists to capture: the user's instruction, or the user's approved
  // report proposal, quoted verbatim. A card without a genuine authority
  // record cannot be created.
  if (typeof pi?.registerTool === "function") {
    pi.registerTool({
      name: "agentic_kanban_board_write",
      label: "Kanban Board Write",
      description:
        "Create a task-board card through the trusted board writer. Governance: all writes go through the trusted, deterministic writer — never through model-authored Markdown. An authority record is REQUIRED and must be genuine: either the user's actual instruction to write this card, or the user's approved report proposal, with the user's words quoted verbatim. A card without a genuine authority record cannot be created; agents must quote the user's actual instruction and must never invent, paraphrase-as-quote, or fabricate one. The writer allocates the cardId and computes the integrity hashes; do not supply either.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Card title (human-visible)." },
          description: { type: "string", description: "Optional longer description." },
          priority: { type: "string", enum: [...PRIORITIES], description: "Optional priority (P0-P3)." },
          lane: { type: "string", enum: [...LANES], description: "Optional lane; defaults to backlog." },
          specification: { type: "string", description: "Specification text (hashed by the writer). Required for a dispatchable card." },
          definitionOfDone: { type: "string", description: "Definition-of-done text (hashed by the writer)." },
          stoppingPoint: { type: "string", description: "Declared stopping point for review." },
          scopePaths: { type: "array", items: { type: "string" }, description: "Repository-relative scope paths." },
          capabilities: { type: "array", items: { type: "string" }, description: "Allowed capability classes (validated against the board registry)." },
          dependencies: { type: "array", items: { type: "string" }, description: "Ordered blocked-by cardIds (existing cards)." },
          base: { type: "string", description: "Optional exact base revision: a full 40-hex Git commit SHA." },
          dueDate: { type: "string", description: "Optional due date, ISO yyyy-mm-dd." },
          flags: { type: "array", items: { type: "string", enum: [...FLAGS] }, description: "Optional flags (proposed/blocked/cancelled)." },
          authority: {
            type: "object",
            description: "REQUIRED authority record (§3.1/§3.5): { source: 'instruction' | 'report-proposal', sessionOrReportId, quotedInstruction }. Quote the user's actual instruction verbatim; never invent one.",
            additionalProperties: false,
            properties: {
              source: { type: "string", enum: ["instruction", "report-proposal"] },
              sessionOrReportId: { type: "string" },
              quotedInstruction: { type: "string", description: "The user's actual words. Required; a digest alone is not accepted through this tool." },
            },
            required: ["source", "sessionOrReportId", "quotedInstruction"],
          },
        },
        required: ["title", "specification", "definitionOfDone", "stoppingPoint", "scopePaths", "authority"],
      },
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        // Per-call board resolution + F7(b) re-observation. No board for the
        // calling workspace, or the board removed after registration:
        // structured board-unavailable instead of writing to a stale path.
        const activeBoardPath = boardPathFor(ctx);
        if (!activeBoardPath || !existsSync(activeBoardPath)) {
          return unavailableResult();
        }
        // The writer allocates the cardId and computes all hashes; the tool
        // forwards only content and the authority record. Input is normalized
        // to the writer's field names; unknown fields are dropped here so the
        // writer's own validation is the single gate.
        const writerInput = {};
        if (input?.title !== undefined) writerInput.title = input.title;
        if (input?.description !== undefined) writerInput.description = input.description;
        if (input?.priority !== undefined) writerInput.priority = input.priority;
        if (input?.lane !== undefined) writerInput.lane = input.lane;
        if (input?.specification !== undefined) writerInput.spec = input.specification;
        if (input?.definitionOfDone !== undefined) writerInput.definitionOfDone = input.definitionOfDone;
        if (input?.stoppingPoint !== undefined) writerInput.stoppingPoint = input.stoppingPoint;
        if (input?.scopePaths !== undefined) writerInput.scope = input.scopePaths;
        if (input?.capabilities !== undefined) writerInput.capabilities = input.capabilities;
        if (input?.dependencies !== undefined) writerInput.dependencies = input.dependencies;
        if (input?.base !== undefined) writerInput.base = input.base;
        if (input?.dueDate !== undefined) writerInput.due = input.dueDate;
        if (input?.flags !== undefined) writerInput.flags = input.flags;
        // Required-field gate: the tool's contract requires these; a missing
        // one is a structured refusal before any write is attempted. The
        // authority record is deliberately NOT pre-gated: a missing or
        // malformed authority must surface as the writer's
        // authority-source-invalid refusal, so the governance reason is
        // always the one reported.
        const requiredFields = ["title", "specification", "definitionOfDone", "stoppingPoint", "scopePaths"];
        const missing = requiredFields.filter((field) => input?.[field] === undefined || input?.[field] === null || input?.[field] === ""
          || (Array.isArray(input?.[field]) && input[field].length === 0));
        if (missing.length > 0) {
          const value = {
            ok: false,
            persisted: false,
            code: "invalid-input",
            reason: `missing required field(s): ${missing.join(", ")}`,
            errors: [`missing required field(s): ${missing.join(", ")}`],
          };
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
        }
        // Writer errors become structured failures (ok:false with a code and
        // reason), never raw throws — the model sees the governance reason.
        let result;
        try {
          result = writeCard({
            boardPath: activeBoardPath,
            input: writerInput,
            authority: input?.authority,
            registries: {},
            surface: "tasks",
            requireExistingBoard: true,
          });
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "writer-error";
          const value = {
            ok: false,
            persisted: false,
            code,
            reason: String(error?.message || error).slice(0, 512),
            errors: [String(error?.message || error).slice(0, 512)],
          };
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
        }
        let value;
        if (result.ok) {
          value = {
            ok: true,
            persisted: true,
            cardId: result.card.cardId,
            lane: result.card.lane,
            flags: [...(result.card.flags ?? [])],
            hashPresent: Boolean(result.card.hash),
            specHashPresent: Boolean(result.card.specHash),
            dodHashPresent: Boolean(result.card.dodHash),
            authorityWriterHmacPresent: Boolean(result.card.authorityWriterHmac),
            authoritySource: { ...result.card.authoritySource },
          };
        } else {
          value = {
            ok: false,
            persisted: false,
            code: result.code,
            reason: (result.errors ?? []).join("; ").slice(0, 512),
            errors: result.errors ?? [],
            ...(result.cardId ? { cardId: result.cardId } : {}),
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
      },
    });
    registered.push("agentic_kanban_board_write");
  }
  // The update/delete tool (§3.5): card updates and removal go through the
  // trusted writer only, with the same REQUIRED genuine authority record as
  // creation. operation "update" applies a changes subset to an existing
  // card (lane move, done, flags, field updates, dependency replacement);
  // operation "delete" removes the card (the issued-ID ledger keeps the ID
  // forever). Completion (done=true) is enforced by the writer: only an
  // instruction or an approved report proposal completes a card — an agent
  // report alone is never completion.
  if (typeof pi?.registerTool === "function") {
    pi.registerTool({
      name: "agentic_kanban_board_update",
      label: "Kanban Board Update",
      description:
        "Update or delete an existing task-board card through the trusted board writer. Governance: all writes go through the trusted, deterministic writer — never through model-authored Markdown. An authority record is REQUIRED and must be genuine: the user's actual instruction (or approved report proposal) quoted verbatim; never invent, paraphrase-as-quote, or fabricate one. Marking a card done requires human authority — an agent report alone is never completion. Do not supply hashes or identifiers other than the existing cardId.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", enum: ["update", "delete"], description: "update (apply changes to a card) or delete (remove the card; its cardId is never reused)." },
          cardId: { type: "string", description: "The existing cardId to update or delete." },
          lane: { type: "string", enum: [...LANES], description: "update: move the card to this lane." },
          done: { type: "boolean", description: "update: mark done (true) or un-done (false). done=true sets the done checkbox and the done lane, and requires human authority." },
          flags: {
            type: "object",
            description: "update: add/remove flags, e.g. {add: ['blocked']} or {remove: ['blocked']}.",
            additionalProperties: false,
            properties: {
              add: { type: "array", items: { type: "string", enum: [...FLAGS] } },
              remove: { type: "array", items: { type: "string", enum: [...FLAGS] } },
            },
          },
          title: { type: "string", description: "update: new title." },
          description: { type: "string", description: "update: new description." },
          priority: { type: "string", enum: [...PRIORITIES], description: "update: new priority (P0-P3)." },
          specification: { type: "string", description: "update: new specification text (hash recomputed by the writer)." },
          definitionOfDone: { type: "string", description: "update: new definition-of-done text (hash recomputed by the writer)." },
          stoppingPoint: { type: "string", description: "update: new stopping point." },
          scopePaths: { type: "array", items: { type: "string" }, description: "update: full replacement scope-path list." },
          capabilities: { type: "array", items: { type: "string" }, description: "update: full replacement capability list." },
          dependencies: { type: "array", items: { type: "string" }, description: "update: full replacement ordered blocked-by cardId list (add/remove by supplying the new complete list)." },
          tags: { type: "array", items: { type: "string" }, description: "update: full replacement tag list." },
          base: { type: "string", description: "update: exact base revision (full 40-hex Git commit SHA)." },
          dueDate: { type: "string", description: "update: due date, ISO yyyy-mm-dd." },
          role: { type: "string", description: "update: assigned role label." },
          authority: {
            type: "object",
            description: "REQUIRED authority record (§3.1/§3.5): { source: 'instruction' | 'report-proposal', sessionOrReportId, quotedInstruction }. Quote the user's actual instruction verbatim; never invent one.",
            additionalProperties: false,
            properties: {
              source: { type: "string", enum: ["instruction", "report-proposal"] },
              sessionOrReportId: { type: "string" },
              quotedInstruction: { type: "string", description: "The user's actual words. Required; a digest alone is not accepted through this tool." },
            },
            required: ["source", "sessionOrReportId", "quotedInstruction"],
          },
        },
        required: ["operation", "cardId", "authority"],
      },
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const activeBoardPath = boardPathFor(ctx);
        if (!activeBoardPath || !existsSync(activeBoardPath)) {
          return unavailableResult();
        }
        const operation = input?.operation;
        if (operation !== "update" && operation !== "delete") {
          const value = { ok: false, persisted: false, code: "invalid-input", reason: "operation must be \"update\" or \"delete\"", errors: ["operation must be \"update\" or \"delete\""] };
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
        }
        if (typeof input?.cardId !== "string" || input.cardId === "") {
          const value = { ok: false, persisted: false, code: "invalid-input", reason: "cardId is required", errors: ["cardId is required"] };
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
        }
        // Map the flat tool input onto the writer's changes subset. Absent
        // fields are left untouched; list fields are full replacement lists.
        const changes = {};
        for (const key of ["lane", "done", "flags", "title", "description", "priority", "specification", "definitionOfDone", "stoppingPoint", "scopePaths", "capabilities", "dependencies", "tags", "base", "dueDate", "role"]) {
          if (input?.[key] !== undefined) changes[key] = input[key];
        }
        let result;
        try {
          result = operation === "update"
            ? updateCard({ boardPath: activeBoardPath, cardId: input.cardId, changes, authority: input?.authority, registries: {}, surface: "tasks" })
            : deleteCard({ boardPath: activeBoardPath, cardId: input.cardId, authority: input?.authority, registries: {}, surface: "tasks" });
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "writer-error";
          const value = { ok: false, persisted: false, code, reason: String(error?.message || error).slice(0, 512), errors: [String(error?.message || error).slice(0, 512)] };
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
        }
        let value;
        if (result.ok) {
          value = operation === "update"
            ? {
                ok: true,
                persisted: true,
                operation,
                cardId: result.card.cardId,
                lane: result.card.lane,
                done: Boolean(result.card.done),
                flags: [...(result.card.flags ?? [])],
                changedFields: result.changedFields,
                hashPresent: Boolean(result.card.hash),
                authorityWriterHmacPresent: Boolean(result.card.authorityWriterHmac),
                authoritySource: { ...result.card.authoritySource },
                projection: result.projection,
              }
            : {
                ok: true,
                persisted: true,
                operation,
                cardId: result.cardId,
                removed: true,
                projection: result.projection,
              };
        } else {
          value = {
            ok: false,
            persisted: false,
            code: result.code,
            reason: (result.reason ?? (result.errors ?? []).join("; ")).slice(0, 512),
            errors: result.errors ?? [],
            ...(result.cardId ? { cardId: result.cardId } : {}),
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
      },
    });
    registered.push("agentic_kanban_board_update");
  }
  return { registered, observation: { ...observation, boardPath: observation.boardPath } };
}
