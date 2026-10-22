// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only

// Canonical, authority-bearing board payload and free-text encodings.
// Both surface parsers and the trusted writer use the same pure primitives.
import { createHash } from "node:crypto";

export function nfc(value) {
  return typeof value === "string" ? value.normalize("NFC") : value;
}

// Keys recursively sorted; absent optional fields omitted; strings normalized.
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

// Sanitize field and HTML-comment syntax before serializing free text.
export function sanitizeFreeText(text) {
  return String(text ?? "").normalize("NFC")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/\[[A-Za-z][A-Za-z0-9_-]*::[^\]]*\]?/g, " ")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ").trim();
}

export function encodeFieldText(text) {
  return Buffer.from(String(text ?? ""), "utf8").toString("base64url");
}

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

// Authority-source reference and presentation fields are outside this hash.
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
