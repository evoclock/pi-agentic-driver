// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Budget accounting (§2, §5): the authoritative request budget is 30k tokens
// for state + questions + framing. Anything exceeding the budget after
// shaping is rejected with state_too_large — never truncated silently.
//
// Conservative token bound (review fix #3): the estimate is byte-based with
// an explicit worst-case floor of 1 token per 2 UTF-8 bytes. This dominates
// chars/4 for every encoding shape:
//   - ASCII prose:        1 byte/char  → 2 bytes/token  (≥ chars/4)
//   - CJK / emoji:        3–4 bytes/char → 1.5–2 bytes/token (chars/4 would
//     undercount a 4-byte emoji as 0.25 tokens; this bound charges ≥ 2)
//   - dense/base64 JSON:  1 byte/char → 2 bytes/token (chars/4 undercounts
//     by 2×; dense JSON tokenizes at ~1–2 bytes/token in practice)
// The bound can over-reject (e.g. very compressive scripts) but never
// materially undercounts. It runs BEFORE any external call so oversized
// requests never reach a provider.

import { createHash } from "node:crypto";
import { stateTooLarge } from "./errors.js";
import type { EnforcedQuestion } from "./schema.js";

/** Conservative worst-case bytes per token (finding #3): 1 token per 2 UTF-8 bytes. */
export const BYTES_PER_TOKEN_CONSERVATIVE = 2;

/** Canonical JSON with object keys sorted (stable digests). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Conservative token estimate for a string: UTF-8 bytes / 2, rounded up.
 * Dominates chars/4 for CJK, emoji, and dense encoded content; can
 * over-reject but never materially undercounts.
 */
export function estimateStringTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN_CONSERVATIVE);
}

export interface RequestSize {
  estimatedTokens: number;
  stateBytes: number;
}

export function estimateRequestTokens(
  state: unknown,
  questions: readonly EnforcedQuestion[],
  budgetTokens: number,
  maxStateBytes: number,
): RequestSize {
  const stateJson = canonicalJson(state);
  const stateBytes = Buffer.byteLength(stateJson, "utf8");
  if (stateBytes > maxStateBytes) {
    throw stateTooLarge(
      `state is ${stateBytes} bytes; the hard byte ceiling is ${maxStateBytes} — shape to digests/summaries and retry`,
      { stateBytes, maxStateBytes },
    );
  }

  let tokens = estimateStringTokens(stateJson);
  for (const question of questions) {
    tokens += estimateStringTokens(question.question);
    tokens += estimateStringTokens(question.instructions);
    if (question.kind === "choice") {
      tokens += question.choices.reduce((sum, c) => sum + estimateStringTokens(c), 0);
    }
  }

  if (tokens > budgetTokens) {
    throw stateTooLarge(
      `estimated request size ${tokens} tokens exceeds the ${budgetTokens}-token budget ` +
        `(state + questions + framing); never truncated silently — shape the state down`,
      { estimatedTokens: tokens, budgetTokens },
    );
  }

  return { estimatedTokens: tokens, stateBytes };
}

/** evalInputDigest (M9): stable digest of the exact evaluation input. */
export function evalInputDigest(
  state: unknown,
  questions: readonly EnforcedQuestion[],
): string {
  const hash = createHash("sha256");
  hash.update(canonicalJson({ state, questions }));
  return hash.digest("hex");
}
