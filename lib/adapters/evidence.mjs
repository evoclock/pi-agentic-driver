// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// evidence adapter — content-bound source anchors for code-phage.
//
// Concept provenance: review-craft v0.7.1 (MIT, bigKING67/review-craft,
// commit cfd74b9) content-bound source/span SHA-256 anchors, the
// candidate → finding → decision separation, and advisory complexity
// ceilings with human-owned decisions. Adapted, not copied: this adapter
// is a pure function over in-memory source text; it creates no ledger,
// no files, and no authority. Agentic Driver remains the canonical
// evidence owner.
import { createHash } from "node:crypto";

// Advisory review ceilings per callable. They are diagnostic signals for
// human review, never automatic rejection thresholds.
export const ADVISORY_CEILINGS = Object.freeze({
  cognitiveComplexity: 15,
  cyclomaticComplexity: 10,
  maxNesting: 4,
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceLines(source) {
  return source.split(/\r?\n/);
}

// Build one content-bound anchor for a callable span. The span text is the
// exact raw source lines [line, endLine]; the digest changes whenever the
// span content changes.
export function spanAnchor(source, callable) {
  const lines = sourceLines(source);
  const start = Math.max(1, Number(callable.line) || 1);
  const end = Math.min(lines.length, Math.max(start, Number(callable.endLine) || start));
  const spanText = lines.slice(start - 1, end).join("\n");
  return {
    line: start,
    endLine: end,
    lineCount: end - start + 1,
    spanSha256: sha256(spanText),
  };
}

// Build the full evidence record for one analyzed file: a source-level
// digest plus per-callable span anchors. Deleted files have no current
// source side; their evidence stays path-level only.
export function buildEvidence(source, analysis) {
  if (typeof source !== "string" || !analysis || analysis.status !== "parsed") {
    return { status: "unavailable", sourceSha256: undefined, anchors: [] };
  }
  const byLine = new Map(
    (analysis.callables || []).map((callable) => [Number(callable.line) || 0, callable]),
  );
  const anchors = [];
  const lines = sourceLines(source);
  // Walk callables in source order; nested callables share parent spans.
  const ordered = [...(analysis.callables || [])].sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0));
  const covered = [];
  for (const callable of ordered) {
    const anchor = spanAnchor(source, callable);
    covered.push({ start: anchor.line, end: anchor.endLine, name: callable.name });
    anchors.push({
      name: callable.name,
      kind: callable.kind,
      ...anchor,
      cyclomaticComplexity: callable.cyclomaticComplexity,
      cognitiveComplexity: callable.cognitiveComplexity,
      overCeiling: {
        cognitiveComplexity: (Number(callable.cognitiveComplexity) || 0) > ADVISORY_CEILINGS.cognitiveComplexity,
        cyclomaticComplexity: (Number(callable.cyclomaticComplexity) || 0) > ADVISORY_CEILINGS.cyclomaticComplexity,
        maxNesting: (Number(callable.maxNesting) || 0) > ADVISORY_CEILINGS.maxNesting,
      },
    });
  }
  return {
    status: "anchored",
    sourceSha256: sha256(source),
    lineCount: lines.length,
    anchors,
    ceilings: ADVISORY_CEILINGS,
  };
}

// Map a changeClassification onto an advisory candidate outcome.
// This is a heuristic signal for human review; the decision owner is
// always the human reviewer, and no outcome is applied automatically.
// Outcome terms are this project's own vocabulary, adapted from the
// review-craft evidence model (see README provenance).
function suggestedOutcome(classification, anchor) {
  if (anchor.overCeiling.cognitiveComplexity || anchor.overCeiling.cyclomaticComplexity) {
    return {
      outcome: "PROFILE",
      rationale: "callable exceeds an advisory complexity ceiling; measure against the acceptance checks before deciding",
    };
  }
  if (anchor.overCeiling.maxNesting) {
    return {
      outcome: "TIDY",
      rationale: "nesting exceeds the advisory ceiling; consider flattening without behavior change",
    };
  }
  if (classification === "removed-lines") {
    return {
      outcome: "HOLD",
      rationale: "only removed lines touch this callable; confirm surrendered behavior before further change",
    };
  }
  if (classification === "whole-file") {
    return {
      outcome: "DESCRIBE",
      rationale: "new file-level unit; document intent and the deletion test before review closes",
    };
  }
  return {
    outcome: "RETAIN",
    rationale: "changed lines stay within advisory limits; confirm the deletion test still holds",
  };
}

// Candidate findings for one changed file. Candidates are not decisions:
// review-craft's separation is preserved, and rejected candidates remain
// visible to the human reviewer rather than disappearing.
export function buildCandidates(path, changedFile, evidence) {
  if (!evidence || evidence.status !== "anchored" || !changedFile) return [];
  const classificationFor = (name) => {
    if (changedFile.wholeCurrentFile) return "whole-file";
    const touched = changedFile.touched;
    if (!Array.isArray(touched)) return undefined;
    const record = touched.find((item) => item.name === name);
    return record?.changeClassification;
  };
  return evidence.anchors.map((anchor) => {
    const classification = classificationFor(anchor.name) || "untouched";
    const suggestion = suggestedOutcome(classification, anchor);
    return {
      path,
      callable: anchor.name,
      line: anchor.line,
      endLine: anchor.endLine,
      spanSha256: anchor.spanSha256,
      changeClassification: classification,
      suggestedOutcome: suggestion.outcome,
      rationale: suggestion.rationale,
      decisionOwner: "human",
      advisoryOnly: true,
    };
  });
}
