// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// review-feedback adapter — two-intent review items for code-phage.
//
// Concept provenance: pi-slopchop v0.10.1 (MIT, robzolkos/pi-slopchop,
// commit f2cae88) separates edit-intent comments from prose-intent
// comments so reviewers never conflate "change this" with "explain
// this". Adapted here under different terms: AMEND marks a concrete
// edit point a human may choose to act on; CONSULT marks a question
// that must be answered in prose and never becomes a code change.
// Items are advisory, content-bound, and rendered for human submission;
// no intent is ever applied autonomously and no Pi editor or TUI is
// touched.
import { createHash } from "node:crypto";

export const REVIEW_INTENT_VOCABULARY = Object.freeze(["AMEND", "CONSULT"]);

// Candidate outcomes that point at a concrete edit are AMEND material;
// everything else is a prose question. Outcome terms use this project's
// own vocabulary (see evidence adapter provenance).
const AMEND_OUTCOMES = new Set(["TIDY", "PROFILE"]);
const CONSULT_OUTCOMES = new Set(["RETAIN", "HOLD", "DESCRIBE"]);

function shortId(path, callable, spanSha256) {
  return createHash("sha256").update(`${path}#${callable}#${spanSha256}`, "utf8").digest("hex").slice(0, 12);
}

function amendMessage(candidate) {
  if (candidate.suggestedOutcome === "PROFILE") {
    return `Measure ${candidate.callable} against the acceptance checks; it exceeds an advisory complexity ceiling.`;
  }
  return `Consider flattening ${candidate.callable}; nesting exceeds the advisory ceiling without behavior change.`;
}

function consultMessage(candidate) {
  switch (candidate.suggestedOutcome) {
    case "HOLD":
      return `Which accepted behavior does ${candidate.callable} still owe after its removed lines? Confirm surrendered behavior before further change.`;
    case "DESCRIBE":
      return `Document the intent and deletion test for ${candidate.callable} before this review closes.`;
    default:
      return `Confirm the deletion test still holds for ${candidate.callable} after these changes.`;
  }
}

const VALID_DIGEST = /^[0-9a-f]{64}$/;

// Build stable review items from evidence candidates. Candidates must
// carry a valid 64-hex content-bound span digest; malformed candidates
// are skipped so they can never silently shape an ID.
export function buildReviewFeedback(candidates) {
  if (!Array.isArray(candidates)) return [];
  const items = [];
  for (const candidate of candidates) {
    if (!candidate || candidate.decisionOwner !== "human" || candidate.advisoryOnly !== true) continue;
    if (typeof candidate.spanSha256 !== "string" || !VALID_DIGEST.test(candidate.spanSha256)) continue;
    const isAmend = AMEND_OUTCOMES.has(candidate.suggestedOutcome);
    const isConsult = CONSULT_OUTCOMES.has(candidate.suggestedOutcome);
    if (!isAmend && !isConsult) continue;
    items.push({
      id: shortId(candidate.path, candidate.callable, candidate.spanSha256),
      intent: isAmend ? "AMEND" : "CONSULT",
      path: candidate.path,
      callable: candidate.callable,
      targetSide: candidate.changeClassification === "removed-lines" ? "old-side" : "new-side",
      lineStart: candidate.line,
      lineEnd: candidate.endLine,
      spanSha256: candidate.spanSha256,
      suggestedOutcome: candidate.suggestedOutcome,
      message: isAmend ? amendMessage(candidate) : consultMessage(candidate),
      requiresHumanSubmission: true,
      autonomousEditAllowed: false,
    });
  }
  return items.sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart);
}
