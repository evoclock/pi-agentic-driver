// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

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
import { execFileSync } from "node:child_process";
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
  // §3.6: a live claim is published through the derived projection as the
  // card being active. Presentation only — the claim record in dispatcher
  // state is canonical for run authority, never this field.
  if (card.activeClaim) parts.push(fieldText("active", card.activeClaim));
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
export function writeProjection(boardPath, cards, claims = []) {
  const path = projectionPath(boardPath);
  try {
    const claimedIds = new Set((Array.isArray(claims) ? claims : [])
      .map((claim) => claim?.cardId)
      .filter((id) => typeof id === "string"));
    const annotated = cards.map((card) => {
      if (!claimedIds.has(card.cardId)) return card;
      const claim = (Array.isArray(claims) ? claims : []).find((entry) => entry?.cardId === card.cardId);
      return { ...card, activeClaim: typeof claim?.role === "string" ? claim.role : "claimed" };
    });
    const frontmatter = "---\nkanban-plugin: board\n---\n\n";
    const body = serializeBoard(annotated, { surface: "obsidian" })
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
    const generation = Number(state?.claimsGeneration);
    return {
      highWaterMark: Number.isInteger(value) && value >= 0 ? value : 0,
      secret: typeof state?.secret === "string" && state.secret !== "" ? state.secret : null,
      issuedCardIds: Array.isArray(state?.issuedCardIds) ? state.issuedCardIds.filter((id) => typeof id === "string") : [],
      // Monotonic claims-generation anchor (deletion/rollback guard): the
      // generation and digest of the LAST claims state this writer issued.
      // A missing claims file is "fresh" only while no generation was ever
      // issued; a lower generation or digest mismatch is replay/deletion.
      claimsGeneration: Number.isInteger(generation) && generation >= 0 ? generation : 0,
      claimsDigest: typeof state?.claimsDigest === "string" && state.claimsDigest !== "" ? state.claimsDigest : null,
      // A complete next claims state is staged here before either authority
      // file changes. Recovery always rolls it forward; it never guesses
      // whether an older claims file is legitimate.
      pendingClaimsState: state?.pendingClaimsState && typeof state.pendingClaimsState === "object"
        ? state.pendingClaimsState
        : null,
    };
  } catch {
    return { highWaterMark: 0, secret: null, issuedCardIds: [], claimsGeneration: 0, claimsDigest: null, pendingClaimsState: null };
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
// Dispatcher state (§3.6, §4): claims and assignment envelopes live OUTSIDE
// the Markdown, beside the board, under the same writer lock as card writes.
// Claim creation, envelope creation, and active-state publication happen in
// one atomic operation. The claims file is canonical for run authority; the
// Markdown stays canonical for task semantics.
// ---------------------------------------------------------------------------

export const CLAIMS_SCHEMA = "agentic-driver.board-claims.v2";
export const ENVELOPE_SCHEMA = "agentic-driver.assignment-envelope.v1";
export const AUTOMATION_POLICY_SCHEMA = "agentic-driver.automation-policy.v1";
export const PLACEMENTS = Object.freeze(["container", "host"]);
export const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);
export const DEFAULT_ENVELOPE_EXPIRY_HOURS = 12;

// F1: the claims file is AUTHENTICATED exactly like the writer state — an
// HMAC-SHA256 over its content, keyed by the writer-state secret, verified on
// every read. Malformed, tampered, or HMAC-failing claims files fail closed:
// dispatch is REFUSED, never treated as an empty claims list.

export function claimsPath(boardPath) {
  return `${boardPath}.claims.json`;
}

export function automationPolicyPath(boardPath) {
  return `${boardPath}.automation-policy.json`;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

// HMAC over the canonical JSON form of the claims content, keyed by the
// writer-state secret (F1). Covers claims, consumed-claim records, and the
// transaction record — every authority-bearing field of the file.
function claimsFileHmac(value, secret) {
  return createHmac("sha256", secret)
    .update(canonicalJsonString({
      schema: value.schema,
      generation: value.generation,
      transaction: value.transaction ?? null,
      claims: value.claims ?? [],
      consumedClaims: value.consumedClaims ?? [],
    }), "utf8")
    .digest("hex");
}

// Item 6: CLOSED, strictly validated shapes. Every record trusted by the
// dispatcher has an exact key set and typed/pattern-checked values — unknown
// or missing keys fail closed before anything is trusted.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function exactKeys(value, keys) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

const ENVELOPE_FIELDS = Object.freeze([
  "schema", "envelopeId", "cardId", "cardHash", "repository", "startingRevision",
  "baseRevision", "branch", "allowedPaths", "unchangedPaths", "capabilities",
  "stoppingPoint", "acceptance", "placement", "interactionProfile", "risk",
  "riskCeiling", "mode", "createdAt", "expiry",
]);

export function wellFormedEnvelope(env) {
  if (env === null || typeof env !== "object" || Array.isArray(env) || !exactKeys(env, ENVELOPE_FIELDS)) return false;
  if (env.schema !== ENVELOPE_SCHEMA) return false;
  if (typeof env.envelopeId !== "string" || !/^[0-9a-f]{32}$/.test(env.envelopeId)) return false;
  if (typeof env.cardId !== "string" || !CARD_ID_RE.test(env.cardId)) return false;
  if (env.cardHash !== null && !/^[0-9a-f]{64}$/.test(env.cardHash)) return false;
  if (typeof env.repository !== "string" || env.repository === "") return false;
  if (env.startingRevision !== null && !COMMIT_SHA_RE.test(env.startingRevision)) return false;
  if (env.baseRevision !== null && !COMMIT_SHA_RE.test(env.baseRevision)) return false;
  if (typeof env.branch !== "string" || !/^board\//.test(env.branch)) return false;
  if (!Array.isArray(env.allowedPaths) || !env.allowedPaths.every((p) => SAFE_PATH_RE.test(p))) return false;
  if (!Array.isArray(env.unchangedPaths) || !env.unchangedPaths.every((p) => SAFE_PATH_RE.test(p))) return false;
  if (!Array.isArray(env.capabilities) || !env.capabilities.every((c) => CAPABILITY_NAME_RE.test(c))) return false;
  if (env.stoppingPoint !== null && typeof env.stoppingPoint !== "string") return false;
  if (env.acceptance === null || typeof env.acceptance !== "object" || !exactKeys(env.acceptance, ["specHash", "dodHash"])) return false;
  if (env.acceptance.specHash !== null && !/^[0-9a-f]{64}$/.test(env.acceptance.specHash)) return false;
  if (env.acceptance.dodHash !== null && !/^[0-9a-f]{64}$/.test(env.acceptance.dodHash)) return false;
  if (!PLACEMENTS.includes(env.placement)) return false;
  if (!PLACEMENTS.includes(env.interactionProfile)) return false;
  if (!RISK_LEVELS.includes(env.risk)) return false;
  if (env.riskCeiling !== null && !RISK_LEVELS.includes(env.riskCeiling)) return false;
  if (env.mode !== "automated") return false;
  if (!ISO_TS_RE.test(env.createdAt) || !ISO_TS_RE.test(env.expiry)) return false;
  return true;
}

const CLAIM_FIELDS = Object.freeze(["cardId", "claimedAt", "role", "envelopeId", "envelope"]);
const CONSUMED_FIELDS = Object.freeze(["cardId", "envelopeId", "consumedAt", "reason"]);
const CONSUMED_REASONS = Object.freeze([
  "expired", "reclaimed", "completed", "exhausted", "cancelled", "failed",
  "waiting-approval", "role-blocked", "worker-unresponsive",
]);
const TRANSACTION_FIELDS = Object.freeze(["op", "cardId", "envelopeId", "at", "phase"]);
const REPLACE_TRANSACTION_FIELDS = Object.freeze(["op", "cardId", "envelopeId", "at", "phase", "oldEnvelopeId", "oldReason"]);
const CLAIMS_STATE_FIELDS = Object.freeze(["schema", "generation", "transaction", "claims", "consumedClaims", "hmac"]);

function wellFormedClaim(claim) {
  return claim !== null && typeof claim === "object" && !Array.isArray(claim) && exactKeys(claim, CLAIM_FIELDS)
    && CARD_ID_RE.test(claim.cardId)
    && ISO_TS_RE.test(claim.claimedAt)
    && ROLE_NAME_RE.test(claim.role)
    && /^[0-9a-f]{32}$/.test(claim.envelopeId)
    && wellFormedEnvelope(claim.envelope)
    && claim.envelope.envelopeId === claim.envelopeId
    && claim.envelope.cardId === claim.cardId;
}

function wellFormedConsumedClaim(claim) {
  return claim !== null && typeof claim === "object" && !Array.isArray(claim) && exactKeys(claim, CONSUMED_FIELDS)
    && CARD_ID_RE.test(claim.cardId)
    && /^[0-9a-f]{32}$/.test(claim.envelopeId)
    && ISO_TS_RE.test(claim.consumedAt)
    && CONSUMED_REASONS.includes(claim.reason);
}

function wellFormedTransaction(tx) {
  if (tx === null) return true;
  if (typeof tx !== "object" || Array.isArray(tx)) return false;
  if (tx.op === "claim") {
    return exactKeys(tx, TRANSACTION_FIELDS)
      && CARD_ID_RE.test(tx.cardId)
      && /^[0-9a-f]{32}$/.test(tx.envelopeId) && ISO_TS_RE.test(tx.at)
      && tx.phase === "claims-written";
  }
  // §10.4 replace-attempt transaction: the pre-recorded replacement identity
  // plus the old envelope ID and terminal reason it replaces.
  if (tx.op === "replace-attempt") {
    return exactKeys(tx, REPLACE_TRANSACTION_FIELDS)
      && CARD_ID_RE.test(tx.cardId)
      && /^[0-9a-f]{32}$/.test(tx.envelopeId) && /^[0-9a-f]{32}$/.test(tx.oldEnvelopeId)
      && ISO_TS_RE.test(tx.at)
      && tx.phase === "claims-written"
      && CONSUMED_REASONS.includes(tx.oldReason);
  }
  return false;
}

// Read and VERIFY the claims file. Missing file → fresh ONLY while the
// authenticated writer state proves no claims generation was ever issued;
// once a generation is anchored, deletion fails closed. A generation older
// than the anchored one, or a digest that does not match the anchored latest
// digest, is replay of older correctly signed state — rejected. Malformed
// JSON, wrong shape, or an HMAC that does not verify → {ok: false, reason};
// the caller MUST fail closed (refuse dispatch).
export function readClaimsState(boardPath) {
  const path = claimsPath(boardPath);
  const writerState = readWriterState(writerStatePath(boardPath));
  if (writerState.pendingClaimsState !== null) {
    return { ok: false, recoverable: true, reason: "a staged claims-anchor transaction requires recovery under the writer lock (fails closed)" };
  }
  if (!existsSync(path)) {
    if (writerState.claimsDigest !== null || writerState.claimsGeneration > 0) {
      return { ok: false, reason: "the claims file is missing but the writer state anchors issued claims state — deletion is rejected (fails closed)" };
    }
    return { ok: true, missing: true, state: { generation: 0, transaction: null, claims: [], consumedClaims: [] } };
  }
  const value = readJsonFile(path);
  if (value === null || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, CLAIMS_STATE_FIELDS)) {
    return { ok: false, reason: "the claims file is malformed or has an unknown shape (fails closed)" };
  }
  if (!Array.isArray(value.claims) || !Array.isArray(value.consumedClaims)
    || !Number.isInteger(value.generation) || value.generation < 0
    || !wellFormedTransaction(value.transaction)
    || !value.claims.every(wellFormedClaim)
    || !value.consumedClaims.every(wellFormedConsumedClaim)) {
    return { ok: false, reason: "the claims file contains a malformed record (fails closed)" };
  }
  // F2 integrity: an ACTIVE claim may never reference a consumed envelope —
  // a consumed envelope cannot be reused; only a new envelopeId is valid.
  const consumedIds = new Set(value.consumedClaims.map((entry) => entry.envelopeId));
  if (value.claims.some((claim) => consumedIds.has(claim.envelopeId))) {
    return { ok: false, reason: "an active claim references a consumed envelope — the claims file is inconsistent (fails closed)" };
  }
  if (writerState.secret === null) {
    return { ok: false, reason: "writer state file has no secret to verify the claims file (fails closed)" };
  }
  if (typeof value.hmac !== "string" || value.hmac !== claimsFileHmac(value, writerState.secret)) {
    return { ok: false, reason: "the claims file HMAC does not verify — tampered or forged (fails closed)" };
  }
  // Deletion/rollback guard: the generation must be exactly the anchored
  // latest (older = replay even if correctly signed; newer = not ours).
  if (value.generation !== writerState.claimsGeneration) {
    return { ok: false, reason: `claims generation ${value.generation} does not match the anchored generation ${writerState.claimsGeneration} — deletion or replay is rejected (fails closed)` };
  }
  if (writerState.claimsDigest !== claimsAnchorDigest(value, writerState.secret)) {
    return { ok: false, reason: "the claims content does not match the writer-state anchor — rollback is rejected (fails closed)" };
  }
  return {
    ok: true,
    state: {
      generation: value.generation,
      transaction: value.transaction,
      claims: value.claims,
      consumedClaims: value.consumedClaims,
    },
  };
}

// Convenience reader. Throws a coded error on corruption so a caller cannot
// silently treat tampered state as an empty claims list (Sol minor 3).
export function readClaims(boardPath) {
  const result = readClaimsState(boardPath);
  if (!result.ok) {
    throw Object.assign(new Error(result.reason), { code: "claims-corrupt" });
  }
  return result.state.claims;
}

function claimsAnchorDigest(value, secret) {
  return createHmac("sha256", secret)
    .update(canonicalJsonString({ generation: value.generation, hmac: value.hmac }), "utf8")
    .digest("hex");
}

// Recover the two-file claims/anchor commit. The complete authenticated next
// claims state is staged in writer state first, so either crash window rolls
// forward deterministically rather than accepting an older file.
function recoverClaimsAnchorLocked(boardPath) {
  const statePath = writerStatePath(boardPath);
  const writerState = readWriterState(statePath);
  const pending = writerState.pendingClaimsState;
  if (pending === null) return { ok: true, recovered: false };
  if (writerState.secret === null || !pending || typeof pending !== "object"
    || !exactKeys(pending, CLAIMS_STATE_FIELDS)
    || pending.hmac !== claimsFileHmac(pending, writerState.secret)) {
    return { ok: false, reason: "the staged claims-anchor transaction is malformed or unauthenticated (fails closed)" };
  }
  writeJsonFileAtomic(claimsPath(boardPath), pending);
  writeWriterState(statePath, {
    ...writerState,
    claimsGeneration: pending.generation,
    claimsDigest: claimsAnchorDigest(pending, writerState.secret),
    pendingClaimsState: null,
  });
  return { ok: true, recovered: true };
}

function writeClaims(boardPath, claims, { consumedClaims = null, transaction = null } = {}) {
  const statePath = writerStatePath(boardPath);
  let writerState = readWriterState(statePath);
  if (writerState.secret === null) {
    throw Object.assign(new Error("writer state file has no secret (fails closed)"), { code: "writer-state-unavailable" });
  }
  const recovery = recoverClaimsAnchorLocked(boardPath);
  if (!recovery.ok) throw Object.assign(new Error(recovery.reason), { code: "claims-anchor-recovery-failed" });
  writerState = readWriterState(statePath);
  const previous = readClaimsState(boardPath);
  if (!previous.ok) throw Object.assign(new Error(previous.reason), { code: "claims-corrupt" });
  const value = {
    schema: CLAIMS_SCHEMA,
    generation: previous.state.generation + 1,
    transaction,
    claims,
    consumedClaims: consumedClaims ?? previous.state.consumedClaims,
  };
  value.hmac = claimsFileHmac(value, writerState.secret);
  // Prepare → claims → commit. Because prepare contains the complete signed
  // next value, recovery can safely roll forward after either later write.
  writeWriterState(statePath, { ...writerState, pendingClaimsState: value });
  writeJsonFileAtomic(claimsPath(boardPath), value);
  writeWriterState(statePath, {
    ...writerState,
    claimsGeneration: value.generation,
    claimsDigest: claimsAnchorDigest(value, writerState.secret),
    pendingClaimsState: null,
  });
}

// The automation policy (§3.2, §4): an explicit, revocable record the USER
// sets. No policy file = no overnight dispatch, ever (fails closed). Shape:
// { roles: [...], placement: "container" | "host", maxConcurrent: N,
//   expiry: ISO yyyy-mm-dd (or full ISO timestamp), envelopeExpiryHours? }.
export function readAutomationPolicy(boardPath, { configPath = null } = {}) {
  const path = configPath ?? automationPolicyPath(boardPath);
  const value = readJsonFile(path);
  if (value === null || typeof value !== "object") return null;
  return value;
}

// Validate the policy shape and currency. The shape is CLOSED (F5): unknown
// fields fail closed with a clear reason. Roles must match ROLE_NAME_RE.
// The policy is bound to the board file it applies to (F4) and carries a risk
// ceiling (F4). Returns {ok, policy, reason}.
const POLICY_FIELDS = Object.freeze([
  "roles", "placement", "maxConcurrent", "expiry", "envelopeExpiryHours",
  "board", "riskCeiling", "allowPerCardRiskOverride", "acceptedRepositories",
  "pulse",
]);

// Pulse policy v1 (PULSE_DESIGN_v3 §3): one optional closed `pulse` object
// inside the existing board-bound automation policy. No second policy store:
// the pulse record is validated here, beside the shipped policy fields, and
// a policy without `pulse` behaves exactly as before (Pulse disabled).
const PULSE_FIELDS = Object.freeze([
  "enabled", "mode", "intervalSeconds", "fillOnStart", "routing",
  "stallTimeoutSeconds", "unattendedHostRiskAccepted",
]);
const PULSE_ROUTE_FIELDS = Object.freeze(["model", "maxConcurrent"]);
const PULSE_MODES = Object.freeze(["interactive", "automated"]);
const PULSE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function pulseCapacityOk(value) {
  return Number.isInteger(value) && value >= 1 && value <= 32;
}

function checkPulseRouteEntry(entry, { seen }) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)
    || !exactKeys(entry, PULSE_ROUTE_FIELDS)) {
    return "each routing entry must have exactly {model, maxConcurrent}";
  }
  if (typeof entry.model !== "string" || !PULSE_MODEL_RE.test(entry.model)) {
    return `route model "${entry.model}" is not an exact provider/model identifier`;
  }
  if (seen.has(entry.model)) {
    return `model "${entry.model}" appears more than once for this role`;
  }
  seen.add(entry.model);
  if (!pulseCapacityOk(entry.maxConcurrent)) {
    return `route maxConcurrent for "${entry.model}" must be an integer from 1 through 32`;
  }
  return null;
}

// Validate the optional `pulse` object. Returns {ok, pulse, reason}. Fails
// closed on unknown fields, duplicate models, routing roles absent from the
// policy's declared roles, and invalid capacities.
export function checkPulsePolicy(pulse, { roles = null } = {}) {
  if (pulse === null || pulse === undefined) return { ok: true, pulse: null, reason: null };
  if (typeof pulse !== "object" || Array.isArray(pulse) || !exactKeys(pulse, PULSE_FIELDS)) {
    return { ok: false, pulse: null, reason: "the automation policy pulse object has unknown or missing fields — the pulse shape is closed (fails closed)" };
  }
  if (typeof pulse.enabled !== "boolean") {
    return { ok: false, pulse: null, reason: "pulse.enabled is required and must be a boolean (fails closed)" };
  }
  if (!PULSE_MODES.includes(pulse.mode)) {
    return { ok: false, pulse: null, reason: `pulse.mode must be one of ${PULSE_MODES.join(", ")} (fails closed)` };
  }
  if (!Number.isInteger(pulse.intervalSeconds) || pulse.intervalSeconds < 10 || pulse.intervalSeconds > 86400) {
    return { ok: false, pulse: null, reason: "pulse.intervalSeconds must be an integer from 10 through 86400 (fails closed)" };
  }
  if (typeof pulse.fillOnStart !== "boolean") {
    return { ok: false, pulse: null, reason: "pulse.fillOnStart must be a boolean (fails closed)" };
  }
  if (pulse.routing === null || typeof pulse.routing !== "object" || Array.isArray(pulse.routing)) {
    return { ok: false, pulse: null, reason: "pulse.routing must be an object keyed by declared policy role (fails closed)" };
  }
  const declared = Array.isArray(roles) ? roles : [];
  for (const role of Object.keys(pulse.routing)) {
    if (!declared.includes(role)) {
      return { ok: false, pulse: null, reason: `pulse.routing declares role "${role}", which is absent from the policy roles (fails closed)` };
    }
    const entry = pulse.routing[role];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || !exactKeys(entry, ["preferred", "fallback", "maxConcurrent"])) {
      return { ok: false, pulse: null, reason: `pulse.routing["${role}"] must have exactly {preferred, fallback, maxConcurrent} (fails closed)` };
    }
    if (!Array.isArray(entry.preferred) || entry.preferred.length === 0) {
      return { ok: false, pulse: null, reason: `pulse.routing["${role}"].preferred must list at least one route (fails closed)` };
    }
    if (!Array.isArray(entry.fallback)) {
      return { ok: false, pulse: null, reason: `pulse.routing["${role}"].fallback must be a list (fails closed)` };
    }
    const seen = new Set();
    for (const route of entry.preferred) {
      const reason = checkPulseRouteEntry(route, { seen });
      if (reason) return { ok: false, pulse: null, reason: `pulse.routing["${role}"].preferred: ${reason} (fails closed)` };
    }
    for (const route of entry.fallback) {
      const reason = checkPulseRouteEntry(route, { seen });
      if (reason) return { ok: false, pulse: null, reason: `pulse.routing["${role}"].fallback: ${reason} (fails closed)` };
    }
    if (!pulseCapacityOk(entry.maxConcurrent)) {
      return { ok: false, pulse: null, reason: `pulse.routing["${role}"].maxConcurrent must be an integer from 1 through 32 (fails closed)` };
    }
  }
  if (!Number.isInteger(pulse.stallTimeoutSeconds) || pulse.stallTimeoutSeconds < 30 || pulse.stallTimeoutSeconds > 86400) {
    return { ok: false, pulse: null, reason: "pulse.stallTimeoutSeconds must be an integer from 30 through 86400 (fails closed)" };
  }
  if (typeof pulse.unattendedHostRiskAccepted !== "boolean") {
    return { ok: false, pulse: null, reason: "pulse.unattendedHostRiskAccepted must be a boolean (fails closed)" };
  }
  return { ok: true, pulse, reason: null };
}

export function checkAutomationPolicy(policy, { now = null, boardPath = null } = {}) {
  const at = now ?? new Date().toISOString();
  if (policy === null || policy === undefined) {
    return { ok: false, reason: "no automation policy is set — automated dispatch is refused (fails closed)" };
  }
  if (typeof policy !== "object" || Array.isArray(policy)) {
    return { ok: false, reason: "the automation policy is malformed (fails closed)" };
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_FIELDS.includes(key)) {
      return { ok: false, reason: `the automation policy has an unknown field "${key}" — the policy shape is closed (fails closed)` };
    }
  }
  if (!Array.isArray(policy.roles) || policy.roles.length === 0
    || !policy.roles.every((role) => typeof role === "string" && ROLE_NAME_RE.test(role))) {
    return { ok: false, reason: `the automation policy declares no valid roles (every role must match ${ROLE_NAME_RE.source}) (fails closed)` };
  }
  if (!PLACEMENTS.includes(policy.placement)) {
    return { ok: false, reason: `the automation policy placement must be one of ${PLACEMENTS.join(", ")} (fails closed)` };
  }
  const maxConcurrent = Number(policy.maxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    return { ok: false, reason: "the automation policy maxConcurrent must be a positive integer (fails closed)" };
  }
  const expiry = typeof policy.expiry === "string" ? policy.expiry : null;
  if (expiry === null || Number.isNaN(Date.parse(expiry))) {
    return { ok: false, reason: "the automation policy has no valid expiry (fails closed)" };
  }
  if (Date.parse(expiry) <= Date.parse(at)) {
    return { ok: false, reason: "the automation policy has expired — new dispatches are refused until it is renewed" };
  }
  if (policy.envelopeExpiryHours !== undefined
    && (!Number.isFinite(Number(policy.envelopeExpiryHours)) || Number(policy.envelopeExpiryHours) <= 0)) {
    return { ok: false, reason: "the automation policy envelopeExpiryHours must be a positive number (fails closed)" };
  }
  if (typeof policy.board !== "string" || policy.board === "") {
    return { ok: false, reason: "the automation policy does not name the board file it applies to (fails closed)" };
  }
  if (boardPath !== null && policy.board !== boardPath) {
    return { ok: false, reason: `the automation policy is bound to board "${policy.board}", not this board (fails closed)` };
  }
  if (typeof policy.riskCeiling !== "string" || !RISK_LEVELS.includes(policy.riskCeiling)) {
    return { ok: false, reason: `the automation policy riskCeiling must be one of ${RISK_LEVELS.join(", ")} (fails closed)` };
  }
  if (policy.allowPerCardRiskOverride !== undefined && typeof policy.allowPerCardRiskOverride !== "boolean") {
    return { ok: false, reason: "the automation policy allowPerCardRiskOverride must be a boolean (fails closed)" };
  }
  // Repository/base policy (item 4): a CLOSED list of accepted repositories.
  // Dispatch may only run in a repository on this list; arbitrary repository
  // overrides outside it are rejected.
  if (!Array.isArray(policy.acceptedRepositories) || policy.acceptedRepositories.length === 0
    || !policy.acceptedRepositories.every((repo) => typeof repo === "string" && repo !== "" && !repo.includes(".."))) {
    return { ok: false, reason: "the automation policy acceptedRepositories must be a non-empty closed list of repository paths (fails closed)" };
  }

  // Pulse (§3): the optional closed pulse object is validated in place. A
  // policy without `pulse` is unchanged and means Pulse is disabled.
  if (policy.pulse !== undefined) {
    const pulse = checkPulsePolicy(policy.pulse, { roles: policy.roles });
    if (!pulse.ok) return { ok: false, reason: pulse.reason };
  }

  return { ok: true, policy, reason: null };
}

// Item 4: a repository override is honored only when it is on the policy's
// closed acceptedRepositories list (exact match).
export function repositoryAccepted(policy, repository) {
  return Array.isArray(policy?.acceptedRepositories) && policy.acceptedRepositories.includes(repository);
}

// §3.2 assignment envelope: created ONCE per assignment, immutable (deep-
// frozen, F2), and single-attempt. Retry, drift, or expiry require a NEW
// envelope — never a mutation of this one. F4: the starting revision comes
// from the CARD'S repository (resolved from the workspace the board lives
// in), the card's base revision is bound in when present (branch chaining),
// and the risk classification comes from the policy (per-card override only
// when the policy allows).
export function createEnvelope({ card, policy, now = null, repository = null, startingRevision = null }) {
  const at = now ?? new Date().toISOString();
  const envelopeId = randomBytes(16).toString("hex");
  const expiryHours = Number.isFinite(policy?.envelopeExpiryHours) && policy.envelopeExpiryHours > 0
    ? policy.envelopeExpiryHours
    : DEFAULT_ENVELOPE_EXPIRY_HOURS;
  let expiry = new Date(Date.parse(at) + expiryHours * 3_600_000).toISOString();
  // The envelope can never outlive the policy that authorized it.
  if (policy?.expiry && Date.parse(policy.expiry) < Date.parse(expiry)) expiry = policy.expiry;
  const repo = repository ?? (policy?.board ? dirname(policy.board) : process.cwd());
  const overrideAllowed = policy?.allowPerCardRiskOverride === true;
  const cardRisk = typeof card?.risk === "string" && RISK_LEVELS.includes(card.risk) ? card.risk : null;
  const risk = overrideAllowed && cardRisk !== null ? cardRisk : policy?.riskCeiling ?? "low";
  // Item 4: work STARTS from the declared base revision where present — the
  // envelope's starting revision IS the base (branch chaining), not merely a
  // copied field; execution validation enforces HEAD === startingRevision.
  const startRev = startingRevision ?? card.base ?? gitHead(repo);
  return deepFreeze({
    schema: ENVELOPE_SCHEMA,
    envelopeId,
    cardId: card.cardId,
    cardHash: card.hash ?? null,
    repository: repo,
    startingRevision: startRev,
    baseRevision: card.base ?? null,
    branch: `board/${card.cardId}-${envelopeId.slice(0, 8)}`,
    allowedPaths: Object.freeze([...(card.scope ?? [])]),
    unchangedPaths: Object.freeze([...(card.unchangedPaths ?? [])]),
    capabilities: Object.freeze([...(card.capabilities ?? [])]),
    stoppingPoint: card.stoppingPoint ?? null,
    acceptance: Object.freeze({ specHash: card.specHash ?? null, dodHash: card.dodHash ?? null }),
    placement: policy?.placement ?? null,
    interactionProfile: policy?.placement ?? null,
    risk,
    riskCeiling: policy?.riskCeiling ?? null,
    mode: "automated",
    createdAt: at,
    expiry,
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// Read-only git observation for the envelope's starting revision. Git
// OPERATIONS belong to the git extension (§0.9); reading HEAD is not one.
export function gitHead(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function gitBranch(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// §3.3 + §4 dispatch eligibility, evaluated under the writer lock: the card
// must be dispatchable per the pure predicate (which already enforces the
// blocked-by gate, hash validity, and — with statePath set — writer
// provenance), not already claimed, and its cardId must be in the writer's
// issued-IDs ledger.
export function dispatchEligibility({ card, boardIndex, boardPath, activeClaims }) {
  const claimed = new Set((activeClaims ?? []).map((claim) => claim.cardId));
  if (claimed.has(card.cardId)) {
    return { eligible: false, reason: `card ${card.cardId} is already claimed` };
  }
  const withState = { ...card, statePath: writerStatePath(boardPath) };
  const result = isDispatchable(withState, boardIndex);
  if (!result.dispatchable) {
    return { eligible: false, reason: result.failedConditions.join("; ") };
  }
  return { eligible: true, reason: null };
}

const PRIORITY_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

// Select the highest-priority dispatchable, unclaimed, provenance-verified
// card. Optional cardId restricts selection to that card.
export function selectDispatchableCard({ cards, boardPath, activeClaims, cardId = null }) {
  const index = new Map(cards.map((card) => [card.cardId, card]));
  const candidates = cards
    .filter((card) => cardId === null || card.cardId === cardId)
    .map((card) => ({ card, eligibility: dispatchEligibility({ card, boardIndex: index, boardPath, activeClaims }) }))
    .filter((entry) => entry.eligibility.eligible)
    .sort((a, b) =>
      (PRIORITY_ORDER[a.card.priority] ?? 99) - (PRIORITY_ORDER[b.card.priority] ?? 99)
      || String(a.card.cardId).localeCompare(String(b.card.cardId)));
  return candidates[0] ?? null;
}

// §3.6 + §4: THE atomic claim. Under the writer lock, in one operation:
// eligibility check → envelope creation → claims-file persist → projection
// republication with the card shown active. A crash leaves either the old or
// the new complete state (both writes are atomic renames); two concurrent
// claims can never both win because the entire read-decide-write sequence
// holds the lock. Expired claims are released first, inside the same lock.
export function claimCard({ boardPath, cardId = null, role, policy = null, configPath = null, now = null, repository = null, startingRevision }) {
  return claimCardInternal({ boardPath, cardId, role, policy, configPath, now, repository, startingRevision, confirmedBatch: null });
}

// ---------------------------------------------------------------------------
// Trusted Pulse-internal confirmed-batch claim path. Host placement is
// claimable ONLY here, and only for a batch context object this module has
// registered after one native confirmation (registerConfirmedBatchForClaims),
// matched by object identity — never by batchId string, user/model field, or
// durable state. Each confirmed entry is single-use: one claim consumes it,
// and a claim for a card outside the confirmed set is refused.
// ---------------------------------------------------------------------------

// batch context object (WeakMap key) -> Set of cardIds still claimable from it.
const confirmedBatchClaims = new WeakMap();

export function registerConfirmedBatchForClaims(batch) {
  if (batch?.schema !== "agentic-driver.pulse-batch.v1" || typeof batch.batchId !== "string" || !Array.isArray(batch.entries)) {
    throw new Error("registerConfirmedBatchForClaims requires a minted pulse batch context");
  }
  confirmedBatchClaims.set(batch, new Set(batch.entries.map((entry) => entry.cardId)));
  return batch.batchId;
}

export function claimCardForConfirmedBatch({ boardPath, cardId = null, role, policy = null, configPath = null, now = null, repository = null, startingRevision = null, confirmedBatch = null }) {
  if (confirmedBatch === null || !confirmedBatchClaims.has(confirmedBatch)) {
    return { ok: false, code: "confirmed-batch-required", reason: "host placement is claimable only through the Pulse confirmed-batch path with a batch registered after native confirmation (fails closed)" };
  }
  if (typeof cardId !== "string" || cardId === "") {
    return { ok: false, code: "confirmed-batch-card-required", reason: "a confirmed-batch claim requires an explicit cardId from the confirmed batch (fails closed)" };
  }
  const expiresMs = Date.parse(confirmedBatch.expiresAt);
  const nowMs = Date.parse(now ?? new Date().toISOString());
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) {
    return { ok: false, code: "confirmed-batch-time-invalid", reason: "the confirmed batch expiry or current time is invalid (fails closed)" };
  }
  if (nowMs >= expiresMs) {
    return { ok: false, code: "confirmed-batch-expired", reason: "the confirmed batch context has expired; a fresh preview and confirmation is required" };
  }
  const entry = confirmedBatch.entries.find((e) => e.cardId === cardId);
  if (!entry || entry.placement !== "host") {
    return { ok: false, code: "confirmed-batch-card-mismatch", reason: "the requested card is not a host entry in the confirmed batch; confirmations cannot be crossed between batch entries" };
  }
  if (entry.state !== "reserved") {
    return { ok: false, code: "confirmed-batch-entry-not-reserved", reason: `confirmed batch entry is ${entry.state}, not reserved; it cannot be claimed again (single-use)` };
  }
  const claimable = confirmedBatchClaims.get(confirmedBatch);
  if (!claimable.has(cardId)) {
    return { ok: false, code: "confirmed-batch-entry-consumed", reason: "the confirmed batch entry was already claimed; confirmation is single-use" };
  }
  const result = claimCardInternal({ boardPath, cardId, role, policy, configPath, now, repository, startingRevision, confirmedBatch });
  if (result.ok) claimable.delete(cardId); // consume the single-use confirmation
  return result;
}

function claimCardInternal({ boardPath, cardId = null, role, policy = null, configPath = null, now = null, repository = null, startingRevision = null, confirmedBatch = null }) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  if (typeof role !== "string" || role === "") {
    throw Object.assign(new Error("role is required"), { code: "role-required" });
  }
  // Contended locks (two pulses racing across processes) retry briefly and
  // then fail as a structured contention error — never a crash. The claim
  // itself stays atomic: whoever takes the lock first wins the card.
  const { sleepSync } = { sleepSync: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return withWriterLock(boardPath, () =>
        claimCardLocked({ boardPath, cardId, role, policy, configPath, now, repository, startingRevision, confirmedBatch }));
    } catch (error) {
      if (error?.code === "writer-lock-held" && attempt < 20) {
        sleepSync(25);
        continue;
      }
      if (error?.code === "writer-lock-held") {
        return { ok: false, code: "lock-contention", reason: "the board writer lock stayed contended; the claim did not land (no card was double-claimed)" };
      }
      throw error;
    }
  }
}

function claimCardLocked({ boardPath, cardId, role, policy, configPath, now, repository, startingRevision, confirmedBatch = null }) {
  const at = now ?? new Date().toISOString();
  if (!existsSync(boardPath)) {
    return { ok: false, code: "board-unavailable", reason: "board file is no longer present (board-unavailable)" };
  }
  if (!ROLE_NAME_RE.test(role)) {
    return { ok: false, code: "role-invalid", reason: `role "${role}" does not match ${ROLE_NAME_RE.source} (fails closed)` };
  }
  const anchorRecovery = recoverClaimsAnchorLocked(boardPath);
  if (!anchorRecovery.ok) {
    return { ok: false, code: "claims-anchor-recovery-failed", recoverable: true, reason: anchorRecovery.reason };
  }
  // F1: read AND verify the claims file. Corruption fails closed.
  const claimsRead = readClaimsState(boardPath);
  if (!claimsRead.ok) {
    return { ok: false, code: "claims-corrupt", reason: claimsRead.reason };
  }
  // F3: reconcile an interrupted transaction before anything else. A crash
  // between the claims-file write and the projection republish leaves a
  // transaction record; roll it forward (republish the projection) so a live
  // claim never exists without its active-state publication, and an envelope
  // never exists without its claim (the envelope is written inside the same
  // claims record, so claims-file presence IS claim+envelope presence).
  // If reconciliation itself fails, REFUSE the mutation — never clear or
  // bypass the pending transaction (item 3).
  const reconciliation = reconcileTransactionLocked({ boardPath, state: claimsRead.state });
  if (reconciliation !== null && reconciliation.failed) {
    return { ok: false, code: "recovery-failed", recoverable: true, reason: reconciliation.reason,
      errors: [reconciliation.reason] };
  }
  // Automation policy first (§4): no policy = no overnight dispatch.
  const resolvedPolicy = policy ?? readAutomationPolicy(boardPath, { configPath });
  const policyCheck = checkAutomationPolicy(resolvedPolicy, { now: at, boardPath });
  if (!policyCheck.ok) {
    return { ok: false, code: "policy-refused", reason: policyCheck.reason };
  }
  if (!policyCheck.policy.roles.includes(role)) {
    return { ok: false, code: "policy-role-refused", reason: `role "${role}" is not declared in the automation policy (fails closed)` };
  }
  // §3.4 mode table: ordinary claims are contained-only (container/microVM),
  // always. Host placement is claimable ONLY through the trusted Pulse-internal
  // confirmed-batch path (claimCardForConfirmedBatch), which requires a batch
  // context registered after one native confirmation. Static pulse.mode=
  // "interactive" plus host placement is never enough on its own; automated
  // dispatch may never use host placement.
  if (confirmedBatch === null && policyCheck.policy.placement !== "container") {
    return { ok: false, code: "policy-placement-refused", reason: "ordinary board dispatch requires container placement per the automation policy (§3.4); host placement is claimable only through the Pulse confirmed-batch path" };
  }
  if (confirmedBatch !== null && policyCheck.policy.placement !== "host") {
    return { ok: false, code: "policy-placement-refused", reason: "the Pulse confirmed-batch claim path requires host placement (fails closed)" };
  }
  // F4: the starting revision comes from the card's repository — the
  // workspace the board lives in, not process.cwd(). A caller-supplied
  // repository override is honored ONLY when it is on the policy's closed
  // acceptedRepositories list (item 4).
  const defaultRepo = dirname(boardPath);
  const repo = repository !== undefined && repository !== null
    ? (repositoryAccepted(policyCheck.policy, repository) ? repository : null)
    : defaultRepo;
  if (repo === null) {
    return { ok: false, code: "policy-repository-refused", reason: `repository "${repository}" is not on the automation policy's acceptedRepositories list (fails closed)` };
  }
  if (!repositoryAccepted(policyCheck.policy, repo)) {
    return { ok: false, code: "policy-repository-refused", reason: `repository "${repo}" is not on the automation policy's acceptedRepositories list (fails closed)` };
  }
  // Expired envelopes release their claims automatically on check (§4.6).
  const activeClaims = releaseExpiredClaimsLocked({ boardPath, at, state: claimsRead.state });
  const concurrency = Number(policyCheck.policy.maxConcurrent);
  if (activeClaims.length >= concurrency) {
    return { ok: false, code: "policy-concurrency-refused", reason: `the automation policy allows at most ${concurrency} concurrent claim(s); ${activeClaims.length} are active` };
  }
  const validatedBoard = validateBoard(readFileSync(boardPath, "utf8"), {});
  if (!validatedBoard.ok) {
    return { ok: false, code: "board-invalid", errors: validatedBoard.errors };
  }
  // F2: an envelope whose attempt was consumed (expired, reclaimed, or
  // completed) can never be reused — the consumed-attempt marker is
  // HMAC-covered in the claims file, and readClaimsState refuses any active
  // claim referencing a consumed envelopeId. A retry mints a NEW envelope.
  const consumedIds = new Set(claimsRead.state.consumedClaims.map((entry) => entry.envelopeId));
  if (cardId !== null && claimsRead.state.claims.some((claim) => claim.cardId === cardId && consumedIds.has(claim.envelopeId))) {
    return { ok: false, code: "envelope-consumed", reason: `card ${cardId} has a consumed envelope attempt; a retry requires a new dispatch and a new envelope` };
  }
  const selected = selectDispatchableCard({ cards: validatedBoard.cards, boardPath, activeClaims, cardId });
  if (selected === null) {
    return { ok: false, code: "no-dispatchable-card", reason: cardId
      ? `card ${cardId} is not dispatchable, is already claimed, or lacks writer provenance`
      : "no dispatchable unclaimed card is available" };
  }
  const card = selected.card;
  const envelope = createEnvelope({ card, policy: policyCheck.policy, now: at, repository: repo, startingRevision });
  const claim = {
    cardId: card.cardId,
    claimedAt: at,
    role,
    envelopeId: envelope.envelopeId,
    envelope,
  };
  const nextClaims = [...activeClaims, claim];
  // F3: the transaction record goes into the claims file BEFORE the
  // projection rename. Both writes are atomic renames under the lock, so a
  // crash leaves either the old or the new complete state, and the record
  // drives roll-forward recovery on the next operation.
  const transaction = { op: "claim", cardId: card.cardId, envelopeId: envelope.envelopeId, at, phase: "claims-written" };
  writeClaims(boardPath, nextClaims, { transaction });
  // Active-state publication: the projection is recomputed with the claim
  // visible, in the same locked operation (§3.6).
  const projection = writeProjection(boardPath, validatedBoard.cards, nextClaims);
  // Item 3: a projection failure returns ok:false as a STRUCTURED
  // RECOVERABLE failure — the claim and envelope are committed in the
  // authenticated claims file with the transaction retained; the next
  // operation rolls the projection forward. Never silently ok:true.
  if (!projection.written) {
    return {
      ok: false,
      claimed: true,
      code: "claim-recoverable",
      recoverable: true,
      reason: `projection publication failed: ${projection.error ?? "unknown"} (claim committed; transaction retained for roll-forward)`,
      cardId: card.cardId,
      role,
      claim,
      envelope,
      projection,
    };
  }
  // F3: finalize — clear the transaction record now that the projection is
  // published.
  finalizeTransactionLocked({ boardPath, claims: nextClaims, projection });
  return {
    ok: true,
    claimed: true,
    cardId: card.cardId,
    role,
    claim,
    envelope,
    projection,
  };
}

// F3: roll an interrupted claim transaction forward — the claims (and their
// envelopes) are already committed in the authenticated claims file, so only
// the projection publication can be stale; republish it. Returns
// {failed: true, reason} when roll-forward fails; callers must REFUSE the
// mutation and never clear the pending transaction (item 3).
function reconcileTransactionLocked({ boardPath, state }) {
  const transaction = state.transaction;
  if (transaction === null || transaction.phase !== "claims-written") return null;
  if (!existsSync(boardPath)) {
    return { failed: true, reason: "a pending claim transaction exists but the board file is unavailable — recovery failed (fails closed)" };
  }
  const validated = validateBoard(readFileSync(boardPath, "utf8"), {});
  if (!validated.ok) {
    return { failed: true, reason: "a pending claim transaction exists but the board is invalid — recovery failed (fails closed)" };
  }
  const projection = writeProjection(boardPath, validated.cards, state.claims);
  if (!projection.written) {
    return { failed: true, reason: `projection republication failed during recovery: ${projection.error ?? "unknown"} (transaction retained)` };
  }
  writeClaims(boardPath, state.claims, { transaction: null });
  return { failed: false };
}

// F3: clear the transaction record once the projection is published.
function finalizeTransactionLocked({ boardPath, claims, projection }) {
  if (!projection?.written) {
    // Leave the transaction record in place so the next operation reconciles.
    return `projection publication failed: ${projection?.error ?? "unknown"} (transaction record retained for recovery)`;
  }
  writeClaims(boardPath, claims, { transaction: null });
  return null;
}

// F2/Item 2: whether an envelope attempt has been consumed (expired,
// reclaimed, or completed) — the journey layer checks this before executing
// an envelope.
export function isEnvelopeConsumed(boardPath, envelopeId) {
  const read = readClaimsState(boardPath);
  if (!read.ok) throw Object.assign(new Error(read.reason), { code: "claims-corrupt" });
  return read.state.consumedClaims.some((entry) => entry.envelopeId === envelopeId);
}

// Prepare the one assigned branch before execution. Authentication happens
// first against the persisted claim; only a missing assigned branch may be
// created, and only from the envelope's exact starting revision. Existing
// branch mismatch is drift, not an implicit checkout.
export function prepareEnvelopeForExecution({ boardPath, envelope }) {
  if (typeof boardPath !== "string" || boardPath === "" || !wellFormedEnvelope(envelope)) {
    return { ok: false, code: "envelope-invalid", reason: "a valid board path and envelope are required" };
  }
  try {
    return withWriterLock(boardPath, () => {
      const recovery = recoverClaimsAnchorLocked(boardPath);
      if (!recovery.ok) return { ok: false, code: "claims-anchor-recovery-failed", reason: recovery.reason };
      const guard = validateEnvelopeForExecutionLocked({ boardPath, envelope, requireBranch: false });
      if (!guard.ok) return guard;
      const current = gitBranch(envelope.repository);
      if (current === envelope.branch) return { ok: true, prepared: false, envelope: guard.envelope };
      if (gitHead(envelope.repository) !== envelope.startingRevision) {
        return { ok: false, code: "revision-drift", reason: "the repository is not at the envelope starting revision (fails closed)" };
      }
      try {
        execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${envelope.branch}`], { cwd: envelope.repository });
        return { ok: false, code: "branch-drift", reason: `assigned branch ${envelope.branch} already exists but is not checked out (fails closed)` };
      } catch (error) {
        if (error?.status !== 1) return { ok: false, code: "branch-unreadable", reason: "the assigned branch state could not be verified (fails closed)" };
      }
      execFileSync("git", ["switch", "-c", envelope.branch, envelope.startingRevision], { cwd: envelope.repository, stdio: "ignore" });
      return { ok: true, prepared: true, envelope: guard.envelope };
    });
  } catch (error) {
    return { ok: false, code: error?.code || "branch-prepare-failed", reason: String(error?.message || error).slice(0, 512) };
  }
}

// Item 2: the authoritative execution-boundary validation. Before an
// envelope is executed or resumed, the journey layer MUST call this: it
// validates authenticated consumption, expiry, card-hash drift, repository
// drift, and HEAD/base/branch drift against the CURRENT board and repository.
// Any drift fails closed — retry requires a new envelope.
export function validateEnvelopeForExecution({ boardPath, envelope, now = null }) {
  if (typeof boardPath !== "string" || boardPath === "") {
    return { ok: false, code: "board-path-required", reason: "boardPath is required" };
  }
  try {
    return withWriterLock(boardPath, () => validateEnvelopeForExecutionLocked({ boardPath, envelope, now }));
  } catch (error) {
    return { ok: false, code: error?.code || "envelope-validation-failed", reason: String(error?.message || error).slice(0, 512) };
  }
}

function validateEnvelopeForExecutionLocked({ boardPath, envelope, now = null, requireBranch = true }) {
  const at = now ?? new Date().toISOString();
  if (!wellFormedEnvelope(envelope)) {
    return { ok: false, code: "envelope-invalid", reason: "the envelope is malformed or has an unknown shape (fails closed)" };
  }
  const recovery = recoverClaimsAnchorLocked(boardPath);
  if (!recovery.ok) return { ok: false, code: "claims-anchor-recovery-failed", reason: recovery.reason };
  const read = readClaimsState(boardPath);
  if (!read.ok) return { ok: false, code: "claims-corrupt", reason: read.reason };
  const claim = read.state.claims.find((entry) => entry.envelopeId === envelope.envelopeId);
  if (!claim) {
    const consumed = read.state.consumedClaims.some((entry) => entry.envelopeId === envelope.envelopeId);
    return { ok: false, code: "envelope-not-active",
      reason: consumed
        ? "the envelope attempt was consumed — a retry requires a new envelope (single-attempt lifecycle)"
        : "the envelope has no active claim on the board (fails closed)" };
  }
  // The caller does not get to supply a well-formed variant. Execution uses
  // exactly the envelope authenticated inside the active claims state.
  if (canonicalJsonString(envelope) !== canonicalJsonString(claim.envelope)) {
    return { ok: false, code: "envelope-authentication-failed", reason: "the supplied envelope does not exactly match the authenticated active-claim envelope (fails closed)" };
  }
  // Single-attempt lifecycle: expiry.
  if (Date.parse(envelope.expiry) <= Date.parse(at)) {
    return { ok: false, code: "envelope-expired", reason: `the envelope expired at ${envelope.expiry} (single-attempt lifecycle)` };
  }
  // Card hash drift: the board's current card must still hash to the
  // envelope's binding.
  if (!existsSync(boardPath)) {
    return { ok: false, code: "board-unavailable", reason: "board file is no longer present (board-unavailable)" };
  }
  const board = validateBoard(readFileSync(boardPath, "utf8"), {});
  if (!board.ok) return { ok: false, code: "board-invalid", reason: "the board is invalid (fails closed)" };
  const card = board.cards.find((entry) => entry.cardId === envelope.cardId);
  if (!card) {
    return { ok: false, code: "card-not-found", reason: `card ${envelope.cardId} no longer exists on the board (drift — new envelope required)` };
  }
  if ((card.hash ?? computeCardHash(card)) !== envelope.cardHash) {
    return { ok: false, code: "card-hash-drift", reason: "the card hash drifted from the envelope binding — semantic edits require a new envelope (fails closed)" };
  }
  // Repository drift.
  if (envelope.repository !== dirname(boardPath)) {
    return { ok: false, code: "repository-drift", reason: `the envelope is bound to repository "${envelope.repository}", not this board's repository (fails closed)` };
  }
  // HEAD/base/branch drift: work must start from the declared starting
  // revision (the card's base revision where present, per item 4) — the
  // repository's current HEAD must equal it.
  if (envelope.startingRevision !== null) {
    const head = gitHead(envelope.repository);
    if (head === null) {
      return { ok: false, code: "head-unreadable", reason: "the envelope's repository HEAD could not be read (fails closed)" };
    }
    if (head !== envelope.startingRevision) {
      return { ok: false, code: "revision-drift",
        reason: `repository HEAD ${head} does not match the envelope's starting revision ${envelope.startingRevision} (drift — new envelope required)` };
    }
  }
  const branch = gitBranch(envelope.repository);
  if (requireBranch && branch !== envelope.branch) {
    return { ok: false, code: "branch-drift",
      reason: `repository branch ${branch ?? "(detached)"} does not match the assigned branch ${envelope.branch} (fails closed)` };
  }
  return { ok: true, claim, envelope: claim.envelope, reason: null };
}

// Item 2: completion consumption — when the work reaches its stopping point,
// the envelope attempt is consumed ("completed") and its claim released.
// Never marks the card done (completion is human-only, §3.1).
export function consumeEnvelope({ boardPath, envelopeId, reason = "completed" } = {}) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  if (!CONSUMED_REASONS.includes(reason)) {
    throw Object.assign(new Error(`reason must be one of ${CONSUMED_REASONS.join(", ")}`), { code: "invalid-input" });
  }
  return withWriterLock(boardPath, () => {
    const anchorRecovery = recoverClaimsAnchorLocked(boardPath);
    if (!anchorRecovery.ok) return { ok: false, code: "claims-anchor-recovery-failed", recoverable: true, reason: anchorRecovery.reason };
    const read = readClaimsState(boardPath);
    if (!read.ok) return { ok: false, code: "claims-corrupt", reason: read.reason };
    const reconciliation = reconcileTransactionLocked({ boardPath, state: read.state });
    if (reconciliation?.failed) {
      return { ok: false, code: "recovery-failed", recoverable: true, reason: reconciliation.reason };
    }
    const claim = read.state.claims.find((entry) => entry.envelopeId === envelopeId);
    if (!claim) {
      return { ok: false, code: "envelope-not-active", reason: "the envelope has no active claim to consume" };
    }
    const kept = read.state.claims.filter((entry) => entry.envelopeId !== envelopeId);
    const consumedClaims = [...read.state.consumedClaims, {
      cardId: claim.cardId,
      envelopeId,
      consumedAt: new Date().toISOString(),
      reason,
    }];
    writeClaims(boardPath, kept, { consumedClaims });
    if (existsSync(boardPath)) {
      const validated = validateBoard(readFileSync(boardPath, "utf8"), {});
      if (validated.ok) writeProjection(boardPath, validated.cards, kept);
    }
    return { ok: true, consumed: true, envelopeId, reason, claims: kept };
  });
}

// Release every claim whose envelope expiry has passed. Returns the surviving
// active claims and republishes the projection. Safe to call anytime.
export function releaseExpiredClaims({ boardPath, now = null } = {}) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  return withWriterLock(boardPath, () => {
    const anchorRecovery = recoverClaimsAnchorLocked(boardPath);
    if (!anchorRecovery.ok) throw Object.assign(new Error(anchorRecovery.reason), { code: "claims-anchor-recovery-failed" });
    const read = readClaimsState(boardPath);
    if (!read.ok) throw Object.assign(new Error(read.reason), { code: "claims-corrupt" });
    // Item 3: every claims mutation reconciles first; refuse on failure.
    const reconciliation = reconcileTransactionLocked({ boardPath, state: read.state });
    if (reconciliation?.failed) {
      throw Object.assign(new Error(reconciliation.reason), { code: "recovery-failed" });
    }
    return { released: releaseExpiredClaimsLocked({ boardPath, at: now ?? new Date().toISOString(), state: read.state }) };
  }).released;
}

function releaseExpiredClaimsLocked({ boardPath, at, state = null }) {
  const existing = (state ?? readClaimsState(boardPath).state ?? { claims: [] }).claims;
  const active = existing.filter((claim) => {
    const expiry = claim?.envelope?.expiry;
    return typeof expiry === "string" && Date.parse(expiry) > Date.parse(at);
  });
  if (active.length !== existing.length) {
    // F2: a released envelope's attempt is consumed — it can never be
    // reused; a retry mints a new envelope.
    const consumedClaims = [...(state?.consumedClaims ?? readClaimsState(boardPath).state?.consumedClaims ?? []),
      ...existing.filter((claim) => !active.includes(claim)).map((claim) => ({
        cardId: claim.cardId,
        envelopeId: claim.envelopeId,
        consumedAt: at,
        reason: "expired",
      }))];
    writeClaims(boardPath, active, { consumedClaims });
    if (existsSync(boardPath)) {
      const validated = validateBoard(readFileSync(boardPath, "utf8"), {});
      if (validated.ok) writeProjection(boardPath, validated.cards, active);
    }
  }
  return active;
}

// Explicit reclaim: drop the claim for one card (or all claims with cardId
// null). Releases the active-state publication. Never marks anything done.
export function reclaimClaim({ boardPath, cardId = null, envelopeId = null } = {}) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  return withWriterLock(boardPath, () => {
    const anchorRecovery = recoverClaimsAnchorLocked(boardPath);
    if (!anchorRecovery.ok) throw Object.assign(new Error(anchorRecovery.reason), { code: "claims-anchor-recovery-failed" });
    const read = readClaimsState(boardPath);
    if (!read.ok) throw Object.assign(new Error(read.reason), { code: "claims-corrupt" });
    // Item 3: reconcile first; refuse the mutation when recovery fails.
    const reconciliation = reconcileTransactionLocked({ boardPath, state: read.state });
    if (reconciliation?.failed) {
      throw Object.assign(new Error(reconciliation.reason), { code: "recovery-failed" });
    }
    const existing = read.state.claims;
    const kept = existing.filter((claim) =>
      (cardId !== null ? claim.cardId !== cardId : true)
      && (envelopeId !== null ? claim.envelopeId !== envelopeId : true));
    if (kept.length === existing.length) {
      return { ok: false, code: "claim-not-found", reason: "no matching claim to reclaim" };
    }
    // F2: a reclaimed envelope's attempt is consumed too.
    const consumedClaims = [...read.state.consumedClaims,
      ...existing.filter((claim) => !kept.includes(claim)).map((claim) => ({
        cardId: claim.cardId,
        envelopeId: claim.envelopeId,
        consumedAt: new Date().toISOString(),
        reason: "reclaimed",
      }))];
    writeClaims(boardPath, kept, { consumedClaims });
    if (existsSync(boardPath)) {
      const validated = validateBoard(readFileSync(boardPath, "utf8"), {});
      if (validated.ok) writeProjection(boardPath, validated.cards, kept);
    }
    return { ok: true, reclaimed: existing.length - kept.length, claims: kept };
  });
}

// §10.4 dispatcher-owned recoverable replaceAttempt: one transition under the
// writer lock that replaces a failed/unresponsive attempt with a new attempt
// (new envelope, new claim) for the same card. Trusted input: the expected
// active card ID, old envelope ID, terminal reason, and replacement route
// (role/repository/starting revision). Not a public model action.
//
// Transaction shape: a prepared transaction is durably staged (HMAC-covered
// via the claims file's own authentication) containing the old terminal
// evidence and the pre-recorded new attempt identity. Only then is the old
// envelope consumed and the new claim published; the transaction record
// clears once the projection is republished. Recovery is idempotent and runs
// first: if only the old consumption landed, the replacement rolls forward
// only while all bound identities still match; otherwise it returns
// REVIEW_REQUIRED. Recovery never creates another envelope.
const REPLACE_TRANSACTION_OPS = Object.freeze(["replace-attempt"]);
const REPLACE_TRANSACTION_PHASES = Object.freeze(["prepared", "committed"]);

export function replaceAttempt({ boardPath, cardId, envelopeId, reason, replacement = {}, now = null } = {}) {
  if (typeof boardPath !== "string" || boardPath === "") {
    throw Object.assign(new Error("boardPath is required"), { code: "board-path-required" });
  }
  if (typeof cardId !== "string" || !CARD_ID_RE.test(cardId)) {
    throw Object.assign(new Error("cardId must be a well-formed card ID"), { code: "invalid-input" });
  }
  if (typeof envelopeId !== "string" || !/^[0-9a-f]{32}$/.test(envelopeId)) {
    throw Object.assign(new Error("envelopeId must be a 32-hex envelope ID"), { code: "invalid-input" });
  }
  if (!CONSUMED_REASONS.includes(reason)) {
    throw Object.assign(new Error(`reason must be one of ${CONSUMED_REASONS.join(", ")}`), { code: "invalid-input" });
  }
  const at = now ?? new Date().toISOString();
  return withWriterLock(boardPath, () => replaceAttemptLocked({ boardPath, cardId, envelopeId, reason, replacement, at }));
}

function replaceAttemptLocked({ boardPath, cardId, envelopeId, reason, replacement, at }) {
  // Recovery first (idempotent): roll any interrupted prior transaction
  // forward before observing state, never creating another envelope.
  const anchorRecovery = recoverClaimsAnchorLocked(boardPath);
  if (!anchorRecovery.ok) {
    return { ok: false, code: "claims-anchor-recovery-failed", recoverable: true, reason: anchorRecovery.reason };
  }
  const read = readClaimsState(boardPath);
  if (!read.ok) return { ok: false, code: "claims-corrupt", reason: read.reason };
  const reconciliation = reconcileTransactionLocked({ boardPath, state: read.state });
  if (reconciliation?.failed) {
    return { ok: false, code: "recovery-failed", recoverable: true, reason: reconciliation.reason };
  }

  // The old attempt must be the exact active authenticated claim for this
  // card. Drift, reuse, or a consumed old envelope fails closed.
  const oldClaim = read.state.claims.find((claim) => claim.envelopeId === envelopeId);
  if (!oldClaim) {
    return { ok: false, code: "envelope-not-active",
      reason: read.state.consumedClaims.some((entry) => entry.envelopeId === envelopeId)
        ? "the old envelope attempt was already consumed — a replacement requires a fresh dispatch (single-attempt lifecycle)"
        : `no active claim for envelope ${envelopeId} (fails closed)` };
  }
  if (oldClaim.cardId !== cardId) {
    return { ok: false, code: "card-drift", reason: `envelope ${envelopeId} is bound to card ${oldClaim.cardId}, not ${cardId} (fails closed)` };
  }

  // Re-evaluate current observations under the lock: card identity/hash,
  // policy validity, and capacity for the replacement route.
  if (!existsSync(boardPath)) {
    return { ok: false, code: "board-unavailable", reason: "board file is no longer present (board-unavailable)" };
  }
  const validatedBoard = validateBoard(readFileSync(boardPath, "utf8"), {});
  if (!validatedBoard.ok) return { ok: false, code: "board-invalid", errors: validatedBoard.errors };
  const card = validatedBoard.cards.find((entry) => entry.cardId === cardId);
  if (!card) return { ok: false, code: "card-not-found", reason: `card ${cardId} no longer exists on the board (drift — REVIEW_REQUIRED)` };
  const currentHash = card.hash ?? computeCardHash(card);
  if (currentHash !== oldClaim.envelope.cardHash) {
    return { ok: false, code: "card-hash-drift", reason: "the card hash drifted from the old envelope binding — semantic edits require human review (REVIEW_REQUIRED)" };
  }

  const resolvedPolicy = readAutomationPolicy(boardPath);
  const policyCheck = checkAutomationPolicy(resolvedPolicy, { now: at, boardPath });
  if (!policyCheck.ok) {
    return { ok: false, code: "policy-refused", reason: policyCheck.reason };
  }
  const replacementRole = typeof replacement.role === "string" && replacement.role !== "" ? replacement.role : oldClaim.role;
  if (!policyCheck.policy.roles.includes(replacementRole)) {
    return { ok: false, code: "policy-role-refused", reason: `replacement role "${replacementRole}" is not declared in the automation policy (fails closed)` };
  }
  if (policyCheck.policy.placement !== "container") {
    return { ok: false, code: "policy-placement-refused", reason: "automated board dispatch requires container placement per the automation policy (§3.4)" };
  }
  const replacementRepository = typeof replacement.repository === "string" && replacement.repository !== ""
    ? replacement.repository
    : dirname(boardPath);
  if (!repositoryAccepted(policyCheck.policy, replacementRepository)) {
    return { ok: false, code: "policy-repository-refused", reason: `repository "${replacementRepository}" is not on the automation policy's acceptedRepositories list (fails closed)` };
  }
  const activeClaims = releaseExpiredClaimsLocked({ boardPath, at, state: read.state });
  const concurrency = Number(policyCheck.policy.maxConcurrent);
  // Capacity: the old claim is being replaced, so it frees exactly one slot.
  if (activeClaims.filter((claim) => claim.envelopeId !== envelopeId).length >= concurrency) {
    return { ok: false, code: "policy-concurrency-refused", reason: `the automation policy allows at most ${concurrency} concurrent claim(s); no free slot for the replacement` };
  }

  // Pre-record the replacement identity, then durably stage the prepared
  // transaction BEFORE consuming the old envelope. The staged claims state
  // carries the complete signed next value, so either crash window rolls
  // forward deterministically (the same prepare→claims→commit scheme as
  // claimCard, extended with the replace op and phase).
  const newEnvelope = createEnvelope({ card, policy: policyCheck.policy, now: at, repository: replacementRepository, startingRevision: replacement.startingRevision ?? undefined });
  const newClaim = {
    cardId,
    claimedAt: at,
    role: replacementRole,
    envelopeId: newEnvelope.envelopeId,
    envelope: newEnvelope,
  };
  const keptClaims = activeClaims.filter((claim) => claim.envelopeId !== envelopeId);
  const nextClaims = [...keptClaims, newClaim];
  const consumedClaims = [...read.state.consumedClaims, {
    cardId, envelopeId, consumedAt: at, reason,
  }];
  const transaction = {
    op: "replace-attempt",
    cardId,
    envelopeId: newEnvelope.envelopeId,
    at,
    phase: "claims-written",
    oldEnvelopeId: envelopeId,
    oldReason: reason,
  };
  writeClaims(boardPath, nextClaims, { consumedClaims, transaction });
  const projection = writeProjection(boardPath, validatedBoard.cards, nextClaims);
  if (!projection.written) {
    return {
      ok: false,
      replaced: true,
      code: "replace-recoverable",
      recoverable: true,
      reason: `projection publication failed: ${projection.error ?? "unknown"} (replacement committed; transaction retained for roll-forward)`,
      cardId,
      oldEnvelopeId: envelopeId,
      claim: newClaim,
      envelope: newEnvelope,
      projection,
    };
  }
  finalizeTransactionLocked({ boardPath, claims: nextClaims, projection });
  return {
    ok: true,
    replaced: true,
    cardId,
    oldEnvelopeId: envelopeId,
    oldReason: reason,
    claim: newClaim,
    envelope: newEnvelope,
    projection,
  };
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
        // The write tool bootstraps: a missing board file is fine (the writer
        // creates it fresh under the lock). Only an unresolvable workspace is
        // refused here.
        if (!activeBoardPath) {
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
            // No requireExistingBoard: the write tool bootstraps a fresh
            // board when none exists. Recreation is safe — fresh content only,
            // and every card still requires a genuine authority record.
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
  // The dispatch tool (§4): claims the highest-priority dispatchable,
  // unclaimed, provenance-verified card for a role under the user's
  // automation policy, creates the assignment envelope, and returns the
  // binding. The policy is the human decision; no policy = refusal. This
  // tool wires claim + envelope only — journey execution integration is a
  // follow-up.
  if (typeof pi?.registerTool === "function") {
    pi.registerTool({
      name: "agentic_kanban_board_dispatch",
      label: "Kanban Board Dispatch",
      description:
        "Claim the highest-priority dispatchable, unclaimed task-board card for a role and create its assignment envelope. Governed by the user's automation policy (roles, placement, maxConcurrent, expiry): no policy = refused; a role not in the policy = refused. Atomic: two concurrent claims can never claim the same card. Expired envelopes release automatically. Returns {cardId, envelope, branch, scope, stoppingPoint}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", description: "The role claiming the card; must be declared in the automation policy." },
          cardId: { type: "string", description: "Optional: claim this specific card instead of the highest-priority dispatchable one." },
        },
        required: ["role"],
      },
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const activeBoardPath = boardPathFor(ctx);
        if (!activeBoardPath || !existsSync(activeBoardPath)) {
          return unavailableResult();
        }
        if (typeof input?.role !== "string" || input.role === "") {
          const value = { ok: false, code: "invalid-input", reason: "role is required", errors: ["role is required"] };
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
        }
        let result;
        try {
          result = claimCard({ boardPath: activeBoardPath, role: input.role, cardId: input?.cardId ?? null });
        } catch (error) {
          const code = typeof error?.code === "string" && error.code !== "claims-corrupt" ? error.code : error.code;
          const value = { ok: false, code, reason: String(error?.message || error).slice(0, 512), errors: [String(error?.message || error).slice(0, 512)] };
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
        }
        let value;
        if (result.ok) {
          value = {
            ok: true,
            claimed: true,
            cardId: result.cardId,
            envelope: result.envelope,
            branch: result.envelope.branch,
            scope: result.envelope.allowedPaths,
            stoppingPoint: result.envelope.stoppingPoint,
            role: result.role,
          };
        } else {
          value = { ok: false, code: result.code, reason: result.reason ?? (result.errors ?? []).join("; "), errors: result.errors ?? [] };
        }
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
      },
    });
    registered.push("agentic_kanban_board_dispatch");
  }
  return { registered, observation: { ...observation, boardPath: observation.boardPath } };
}
