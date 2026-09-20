// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Question schema contract v2 enforcement (§6).
//
// The request is ATOMIC: any malformed, absent, or contradictory answer fails
// the entire request with validation_error; the caller applies its failure
// policy for the whole batch (fail closed for the binding gate, fail open for
// advisory uses).
//
// Question identity: every question carries a REQUIRED caller-supplied
// `name` — a stable, non-sensitive identifier used for answer keying and
// audit records. The question TEXT itself is separate and is always sent to
// the provider verbatim; it never enters the audit log.
//
// Provider selection is configuration-only: request-level `model` and
// `provider` fields are rejected outright (M8).

import {
  MAX_CHOICES,
  MAX_INSTRUCTIONS_CHARS,
  MAX_QUESTIONS,
  SCORE_LEVELS,
} from "./config.js";
import { validationError } from "./errors.js";

export type RawQuestion = {
  type: unknown;
  name?: unknown;
  question?: unknown;
  choices?: unknown;
  levels?: unknown;
  threshold?: unknown;
  instructions?: unknown;
  criteria?: unknown;
};

export interface BooleanQuestion {
  kind: "boolean";
  name: string;
  question: string;
  threshold: number;
  instructions: string;
  sdkCriteria?: { true?: string | null; false?: string | null } | undefined;
}

export interface ChoiceQuestion {
  kind: "choice";
  name: string;
  question: string;
  choices: string[];
  instructions: string;
}

export interface ScoreQuestion {
  kind: "score";
  name: string;
  question: string;
  levels: number;
  instructions: string;
}

export type EnforcedQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

export interface EnforcedRequest {
  state: unknown;
  timeoutMs?: number | undefined;
  questions: EnforcedQuestion[];
}

export const DEFAULT_BOOLEAN_THRESHOLD = 0.9;
/** Maximum characters for a caller-supplied question name. */
export const MAX_QUESTION_NAME_CHARS = 256;
/** Maximum characters for the question text itself. */
export const MAX_QUESTION_TEXT_CHARS = 20_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Enforce the required, non-sensitive question identifier. */
function enforceQuestionName(raw: RawQuestion, index: number): string {
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw validationError(
      `questions[${index}]: name is required — a nonempty, non-sensitive identifier used for answer keying and audit`,
    );
  }
  if (name.length > MAX_QUESTION_NAME_CHARS) {
    throw validationError(
      `questions[${index}]: name exceeds ${MAX_QUESTION_NAME_CHARS} characters`,
    );
  }
  return name;
}

/** Enforce the required question text. It is always sent to the provider. */
function enforceQuestionText(raw: RawQuestion, name: string): string {
  const question = raw.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw validationError(
      `question ${JSON.stringify(name)}: question text is required and must be a nonempty string`,
    );
  }
  if (question.length > MAX_QUESTION_TEXT_CHARS) {
    throw validationError(
      `question ${JSON.stringify(name)}: question text exceeds ${MAX_QUESTION_TEXT_CHARS} characters`,
    );
  }
  return question;
}

function enforceInstructions(raw: RawQuestion, name: string): string {
  const instructions = raw.instructions;
  if (instructions === undefined) return "";
  if (typeof instructions !== "string") {
    throw validationError(
      `question ${JSON.stringify(name)}: instructions must be a string`,
    );
  }
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw validationError(
      `question ${JSON.stringify(name)}: instructions exceed ${MAX_INSTRUCTIONS_CHARS} characters`,
    );
  }
  return instructions;
}

function enforceBoolean(raw: RawQuestion, name: string): BooleanQuestion {
  let threshold = DEFAULT_BOOLEAN_THRESHOLD;
  if (raw.threshold !== undefined) {
    if (
      typeof raw.threshold !== "number" ||
      !Number.isFinite(raw.threshold) ||
      raw.threshold < 0 ||
      raw.threshold > 1
    ) {
      throw validationError(
        `question ${JSON.stringify(name)}: threshold must be a number in [0, 1]`,
      );
    }
    threshold = raw.threshold;
  }
  const instructions = enforceInstructions(raw, name);

  // Optional boolean criteria pair (SDK shape: {true?, false?}).
  let sdkCriteria: BooleanQuestion["sdkCriteria"];
  if (raw.criteria !== undefined) {
    if (!isPlainObject(raw.criteria)) {
      throw validationError(
        `question ${JSON.stringify(name)}: criteria must be an object with optional true/false labels`,
      );
    }
    const allowed = new Set(["true", "false"]);
    for (const key of Object.keys(raw.criteria)) {
      if (!allowed.has(key)) {
        throw validationError(
          `question ${JSON.stringify(name)}: criteria.${key} is unknown; only true/false labels are accepted`,
        );
      }
    }
    const trueLabel = raw.criteria.true;
    const falseLabel = raw.criteria.false;
    if (trueLabel !== undefined && typeof trueLabel !== "string" && trueLabel !== null) {
      throw validationError(
        `question ${JSON.stringify(name)}: criteria.true must be a string or null`,
      );
    }
    if (falseLabel !== undefined && typeof falseLabel !== "string" && falseLabel !== null) {
      throw validationError(
        `question ${JSON.stringify(name)}: criteria.false must be a string or null`,
      );
    }
    sdkCriteria = {};
    if (trueLabel !== undefined) sdkCriteria.true = trueLabel;
    if (falseLabel !== undefined) sdkCriteria.false = falseLabel;
  }

  return {
    kind: "boolean",
    name,
    question: enforceQuestionText(raw, name),
    threshold,
    instructions,
    sdkCriteria,
  };
}

function enforceChoice(raw: RawQuestion, name: string): ChoiceQuestion {
  const instructions = enforceInstructions(raw, name);

  // §6: the candidate set is REQUIRED in the schema.
  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw validationError(
      `question ${JSON.stringify(name)}: choice questions require a nonempty choices array`,
    );
  }
  if (!choices.every((c) => typeof c === "string" && c.length > 0)) {
    throw validationError(
      `question ${JSON.stringify(name)}: every choice must be a nonempty string`,
    );
  }
  if (new Set(choices).size !== choices.length) {
    throw validationError(
      `question ${JSON.stringify(name)}: choices must be unique`,
    );
  }
  if (choices.length > MAX_CHOICES) {
    throw validationError(
      `question ${JSON.stringify(name)}: more than ${MAX_CHOICES} choices`,
    );
  }
  return {
    kind: "choice",
    name,
    question: enforceQuestionText(raw, name),
    choices,
    instructions,
  };
}

function enforceScore(raw: RawQuestion, name: string): ScoreQuestion {
  const instructions = enforceInstructions(raw, name);

  // §6: score is numeric 0..5, one decimal. Ordinal vocabularies must be
  // choice questions, not scores; there is no per-question override.
  const levels = SCORE_LEVELS;
  if (raw.levels !== undefined || raw.choices !== undefined) {
    throw validationError(
      `question ${JSON.stringify(name)}: score questions have a fixed 0..5 vocabulary; ` +
        `use a choice question for ordinal labels`,
    );
  }
  return {
    kind: "score",
    name,
    question: enforceQuestionText(raw, name),
    levels,
    instructions,
  };
}

export function enforceRequest(body: unknown): EnforcedRequest {
  if (!isPlainObject(body)) {
    throw validationError("request body must be a JSON object");
  }

  // Closed request validation: unknown top-level fields are rejected, not
  // ignored. `model` and `provider` are deliberately absent — provider
  // selection is configuration-only (M8).
  const allowed = new Set(["state", "timeoutMs", "questions"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw validationError(
        `unknown request field ${JSON.stringify(key)}; allowed fields: state, timeoutMs, questions`,
      );
    }
  }

  const state = body.state;
  if (state === undefined) {
    throw validationError("state is required");
  }
  // Strings, plain objects, and arrays (message histories pass directly).
  if (
    typeof state !== "string" &&
    !isPlainObject(state) &&
    !Array.isArray(state)
  ) {
    throw validationError("state must be a string, object, or array");
  }

  let timeoutMs: number | undefined;
  if (body.timeoutMs !== undefined) {
    if (
      typeof body.timeoutMs !== "number" ||
      !Number.isFinite(body.timeoutMs) ||
      !Number.isInteger(body.timeoutMs) ||
      body.timeoutMs <= 0
    ) {
      throw validationError("timeoutMs must be a positive integer (milliseconds)");
    }
    timeoutMs = body.timeoutMs;
  }

  const rawQuestions = body.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw validationError("questions must be a nonempty array");
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    throw validationError(`more than ${MAX_QUESTIONS} questions in one request`);
  }

  const questions: EnforcedQuestion[] = rawQuestions.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw validationError(`questions[${index}] must be an object`);
    }
    const raw = entry as RawQuestion;
    // Closed per-question validation: unknown fields rejected, never ignored.
    const allowedQuestionFields = new Set([
      "type",
      "name",
      "question",
      "choices",
      "threshold",
      "instructions",
      "criteria",
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowedQuestionFields.has(key)) {
        throw validationError(
          `questions[${index}]: unknown field ${JSON.stringify(key)}`,
        );
      }
    }
    const name = enforceQuestionName(raw, index);
    switch (raw.type) {
      case "boolean":
        return enforceBoolean(raw, name);
      case "choice":
        return enforceChoice(raw, name);
      case "score":
        return enforceScore(raw, name);
      default:
        throw validationError(
          `questions[${index}]: type must be one of "boolean", "choice", "score"`,
        );
    }
  });

  // Duplicate question names would make the answer map ambiguous.
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.name)) {
      throw validationError(
        `duplicate question name: ${JSON.stringify(q.name)}`,
      );
    }
    seen.add(q.name);
  }

  return { state, timeoutMs, questions };
}
