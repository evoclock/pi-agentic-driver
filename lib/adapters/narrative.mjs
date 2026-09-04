// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// narrative adapter — structured, concern-grouped review narrative.
//
// Concept provenance: semantic-review v0.3.0 (MIT, mikker/semantic-review,
// commit f77e5c8) groups review guidance as a short narrative with
// schema-validated structured output, stable hunk references, and levels
// from summary to full walkthrough. Adapted here without any model
// backend or network: the narrative is derived deterministically from
// code-phage results, grouped by concern rather than file order, and
// every reference resolves to a review-feedback item or a content-bound
// candidate span. The narrative is an isolated advisory artifact; it
// never triggers edits, submissions, or remote calls.
export const NARRATIVE_SCHEMA = "agentic-driver.code-phage-narrative.v1";

const SECTION_TITLES = {
  amend: "EDIT POINTS",
  consult: "OPEN QUESTIONS",
  removed: "SURRENDERED BEHAVIOR",
  ceilings: "MEASUREMENT SIGNALS",
};

// Narrative summary wording uses this project's outcome vocabulary;
// see the evidence adapter provenance in README.md.

const VALID_DIGEST = /^[0-9a-f]{64}$/;

function candidateRef(candidate) {
  if (!candidate || typeof candidate.spanSha256 !== "string" || !VALID_DIGEST.test(candidate.spanSha256)) return null;
  return `CAND:${candidate.path}#${candidate.callable}#${candidate.spanSha256.slice(0, 12)}`;
}

function buildSections(result) {
  const sections = [];
  const reviewFeedback = Array.isArray(result.reviewFeedback) ? result.reviewFeedback : [];
  const amendItems = reviewFeedback.filter((item) => item.intent === "AMEND");
  if (amendItems.length) {
    sections.push({
      id: "amend",
      title: SECTION_TITLES.amend,
      items: amendItems.map((item) => ({
        ref: `RF:${item.id}`,
        path: item.path,
        callable: item.callable,
        lineStart: item.lineStart,
        lineEnd: item.lineEnd,
        message: item.message,
      })),
    });
  }
  const consultItems = reviewFeedback.filter((item) => item.intent === "CONSULT");
  if (consultItems.length) {
    sections.push({
      id: "consult",
      title: SECTION_TITLES.consult,
      items: consultItems.map((item) => ({
        ref: `RF:${item.id}`,
        path: item.path,
        callable: item.callable,
        lineStart: item.lineStart,
        lineEnd: item.lineEnd,
        message: item.message,
      })),
    });
  }
  const deletedPaths = result.changedScope?.deletedPaths || [];
  if (deletedPaths.length) {
    sections.push({
      id: "removed",
      title: SECTION_TITLES.removed,
      items: deletedPaths.map((path) => ({
        ref: `DEL:${path}`,
        path,
        callable: undefined,
        message: `Confirm the consumer map and surrendered behavior for the deleted unit ${path} before review closes.`,
      })),
    });
  }
  const overCeiling = [];
  for (const entry of result.changedCallables || []) {
    for (const anchor of entry.evidence?.anchors || []) {
      if (!anchor || typeof anchor.spanSha256 !== "string" || !VALID_DIGEST.test(anchor.spanSha256)) continue;
      if (Object.values(anchor.overCeiling || {}).some(Boolean)) {
        overCeiling.push({
          ref: `CAND:${entry.path}#${anchor.name}#${anchor.spanSha256.slice(0, 12)}`,
          path: entry.path,
          callable: anchor.name,
          lineStart: anchor.line,
          lineEnd: anchor.endLine,
          message: `${anchor.name} exceeds an advisory ceiling; measure against the acceptance checks.`,
        });
      }
    }
  }
  if (overCeiling.length) {
    sections.push({
      id: "ceilings",
      title: SECTION_TITLES.ceilings,
      items: overCeiling,
    });
  }
  return sections;
}

// Validate one narrative value against the schema. Fails closed: any
// missing field, unknown level, or unresolvable reference returns errors
// instead of a pass.
export function validateNarrative(narrative) {
  const errors = [];
  if (!narrative || typeof narrative !== "object") return { valid: false, errors: ["narrative must be an object"] };
  if (narrative.schema !== NARRATIVE_SCHEMA) errors.push("schema mismatch");
  if (!["summary", "walkthrough"].includes(narrative.level)) errors.push("level must be summary or walkthrough");
  if (typeof narrative.summary !== "string" || !narrative.summary.trim()) errors.push("summary must be non-empty text");
  if (!Array.isArray(narrative.sections)) errors.push("sections must be an array");
  const VALID_DIGEST = /^[0-9a-f]{64}$/;
  const knownRefs = new Set(Object.keys(narrative.referenceIndex || {}));
  for (const [ref, digest] of Object.entries(narrative.referenceIndex || {})) {
    if (digest !== null && (typeof digest !== "string" || !VALID_DIGEST.test(digest))) {
      errors.push(`reference ${ref} is not bound to a valid span digest`);
    }
  }
  for (const section of narrative.sections || []) {
    if (!section.id || !section.title || !Array.isArray(section.items)) {
      errors.push(`section ${section.id || "<missing-id>"} is malformed`);
      continue;
    }
    for (const item of section.items) {
      if (!item.ref || !item.message) errors.push(`item in ${section.id} lacks ref or message`);
      if (!knownRefs.has(item.ref)) errors.push(`unresolvable reference ${item.ref}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Build the narrative plus its reference index. The reference index maps
// every stable ref to its span digest so narrative guidance stays
// content-bound across session restarts and compaction.
export function buildNarrative(result, level = "walkthrough") {
  if (!result || result.schema !== "agentic-driver.code-phage.v1") {
    return { schema: NARRATIVE_SCHEMA, level, valid: false, errors: ["input is not a code-phage result"], sections: [], referenceIndex: {} };
  }
  const sections = buildSections(result);
  const referenceIndex = {};
  for (const item of result.reviewFeedback || []) referenceIndex[`RF:${item.id}`] = item.spanSha256;
  for (const candidate of result.candidates || []) {
    const ref = candidateRef(candidate);
    if (ref) referenceIndex[ref] = candidate.spanSha256;
  }
  for (const path of result.changedScope?.deletedPaths || []) referenceIndex[`DEL:${path}`] = null;
  const counts = result.summary?.reviewFeedback || {};
  const summary = [
    `${result.changedScope?.changedFiles ?? 0} changed file(s) reviewed;`,
    `${result.changedScope?.touchedCallables ?? 0} callable(s) touched;`,
    `${counts.AMEND || 0} AMEND point(s), ${counts.CONSULT || 0} CONSULT question(s);`,
    `${result.summary?.deletedFiles ?? 0} deleted unit(s).`,
    "All findings are advisory; decisions remain with the human reviewer.",
  ].join(" ");
  const narrative = {
    schema: NARRATIVE_SCHEMA,
    level,
    isolated: true,
    modelBackend: "none",
    networkAccess: false,
    summary,
    sections,
    referenceIndex,
  };
  const validation = validateNarrative(narrative);
  return { ...narrative, valid: validation.valid, errors: validation.errors };
}
