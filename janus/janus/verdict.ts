// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Verdict enforcement (§6, review fix #8): the model's answers are checked
// against the enforced question contract before anything is returned to the
// caller. The answer shape is closed:
//   - every requested question must have an answer (missing → fail);
//   - the answer type must match the requested question type;
//   - boolean probability must be a finite number in [0, 1];
//   - choice must be a member of the requested choices;
//   - score must be a finite number in [0, levels - 1];
//   - probabilities maps (when present) must be finite numbers over the
//     question's own vocabulary.
// ANY violation — missing, malformed, contradictory, wrong type, invalid
// probability, out-of-range score, out-of-set choice — fails the ENTIRE
// request with validation_error (atomic, fail-closed). Transport
// timeout/unavailability remains a no-verdict outcome (timeout /
// gateway_unavailable) and is classified upstream; enforcement itself never
// converts a provider shape problem into a no-verdict.

import type { EnforcedQuestion } from "./schema.js";
import { validationError } from "./errors.js";

/** One decimal, per §6. */
export function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface EnforcedVerdict {
  answers: Record<
    string,
    { type: "boolean"; probability: number; passed: boolean } | {
      type: "choice";
      choice: string;
      probabilities?: Record<string, number>;
    } | {
      type: "score";
      score: number;
      probabilities?: Record<string, number>;
    }
  >;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
}

interface RawAnswer {
  type?: unknown;
  probability?: unknown;
  choice?: unknown;
  score?: unknown;
  probabilities?: unknown;
}

function enforceProbabilities(
  question: EnforcedQuestion,
  vocabulary: readonly string[] | undefined,
  raw: unknown,
): Record<string, number> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw validationError(
      `question ${JSON.stringify(question.name)}: probabilities must be an object`,
    );
  }
  const collected: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (vocabulary !== undefined && !vocabulary.includes(key)) {
      throw validationError(
        `question ${JSON.stringify(question.name)}: probabilities key ${JSON.stringify(key)} is outside the question's vocabulary`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw validationError(
        `question ${JSON.stringify(question.name)}: probability for ${JSON.stringify(key)} is not a finite number`,
      );
    }
    collected[key] = value;
  }
  return collected;
}

/**
 * Enforce the provider result against the enforced questions.
 * `rawAnswers` maps question name → provider answer.
 */
export function enforceAnswers(
  questions: readonly EnforcedQuestion[],
  rawAnswers: Record<string, unknown>,
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  },
): EnforcedVerdict {
  const answers: EnforcedVerdict["answers"] = {};

  for (const question of questions) {
    const raw = rawAnswers[question.name];
    if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      // Atomic fail-closed: a missing or malformed answer fails the whole
      // request with validation_error (review fix #8).
      throw validationError(
        `question ${JSON.stringify(question.name)}: no valid answer was returned`,
      );
    }
    const answer = raw as RawAnswer;

    if (question.kind === "boolean") {
      if (answer.type !== undefined && answer.type !== "boolean") {
        throw validationError(
          `question ${JSON.stringify(question.name)}: expected a boolean answer, got type ${JSON.stringify(answer.type)}`,
        );
      }
      const probability = answer.probability;
      if (typeof probability !== "number" || !Number.isFinite(probability)) {
        throw validationError(
          `question ${JSON.stringify(question.name)}: boolean answer missing a numeric probability`,
        );
      }
      if (probability < 0 || probability > 1) {
        throw validationError(
          `question ${JSON.stringify(question.name)}: probability ${probability} outside [0, 1]`,
        );
      }
      answers[question.name] = {
        type: "boolean",
        probability,
        // §6: comparison is probability >= threshold. "Model returned false"
        // is a normal 200 verdict with passed=false.
        passed: probability >= question.threshold,
      };
      continue;
    }

    if (question.kind === "choice") {
      if (answer.type !== undefined && answer.type !== "choice") {
        throw validationError(
          `question ${JSON.stringify(question.name)}: expected a choice answer, got type ${JSON.stringify(answer.type)}`,
        );
      }
      const choice = answer.choice;
      if (typeof choice !== "string") {
        throw validationError(
          `question ${JSON.stringify(question.name)}: choice answer missing the selected choice`,
        );
      }
      if (!question.choices.includes(choice)) {
        // Atomic fail-closed: an answer outside the candidate set is a
        // contradictory result, not a verdict.
        throw validationError(
          `question ${JSON.stringify(question.name)}: answer ${JSON.stringify(choice)} is not a member of the choices array`,
          { question: question.name, choice },
        );
      }
      const probabilities = enforceProbabilities(question, question.choices, answer.probabilities);
      answers[question.name] =
        probabilities === undefined
          ? { type: "choice", choice }
          : { type: "choice", choice, probabilities };
      continue;
    }

    // score
    if (answer.type !== undefined && answer.type !== "score") {
      throw validationError(
        `question ${JSON.stringify(question.name)}: expected a score answer, got type ${JSON.stringify(answer.type)}`,
      );
    }
    const score = answer.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw validationError(
        `question ${JSON.stringify(question.name)}: score answer missing a numeric score`,
      );
    }
    // Provider contract: fractional position in [0, levels - 1].
    if (score < 0 || score > question.levels - 1) {
      throw validationError(
        `question ${JSON.stringify(question.name)}: score ${score} outside [0, ${question.levels - 1}]`,
      );
    }
    const probabilities = enforceProbabilities(question, undefined, answer.probabilities);
    answers[question.name] =
      probabilities === undefined
        ? { type: "score", score: roundScore(score) }
        : { type: "score", score: roundScore(score), probabilities };
  }

  return { answers, usage };
}
