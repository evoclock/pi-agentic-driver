// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, resolve, relative } from "node:path";

export const AIDR_SCHEMA = "agentic-driver.aidr.v1";
const MAX_TEXT_BYTES = 256 * 1024;
const ALLOWED_FILE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".html", ".htm"]);
const CLUTTER_PHRASES = Object.freeze([
  "in order to",
  "due to the fact that",
  "at this point in time",
  "it is important to note that",
  "in the event that",
  "with regard to",
  "subsequent to",
  "a number of",
  "utilize",
  "facilitate",
  "aforementioned",
]);
const PASSIVE_PATTERN = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ed|\w+en)\b/gi;
const SENTENCE_PATTERN = /[^.!?\n]+(?:[.!?]+|$)/g;

function boundedText(value, label = "text") {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`${label} is missing or exceeds the bounded review size`);
  }
  return value;
}

function words(value) {
  return (value.match(/[A-Za-z0-9][A-Za-z0-9'/-]*/g) ?? []);
}

function visibleProse(value) {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  let inFence = false;
  let frontmatter = false;
  let seenContent = false;
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!seenContent && trimmed === "---") {
      frontmatter = !frontmatter;
      continue;
    }
    if (frontmatter) continue;
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed) seenContent = true;
    kept.push(line.replace(/<[^>]+>/g, " "));
  }
  return kept.join("\n");
}

function sentenceRecords(prose) {
  return [...prose.matchAll(SENTENCE_PATTERN)]
    .map((match) => match[0].trim())
    .filter(Boolean)
    .map((sentence) => ({ sentence, wordCount: words(sentence).length }));
}

function clipped(value, length = 180) {
  return value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
}

function principle(status, finding) {
  return { status, finding };
}

export function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function reviewText(input, { mode = "review", source = "text" } = {}) {
  const text = boundedText(input);
  if (!["review", "simple", "analogy"].includes(mode)) {
    throw new Error("AI;DR mode must be review, simple, or analogy");
  }
  const prose = visibleProse(text);
  const sentences = sentenceRecords(prose);
  const paragraphs = prose.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const longSentences = sentences.filter((item) => item.wordCount > 28).slice(0, 6);
  const longParagraphs = paragraphs
    .map((paragraph) => ({ paragraph, wordCount: words(paragraph).length }))
    .filter((item) => item.wordCount > 120)
    .slice(0, 4);
  const clutter = CLUTTER_PHRASES.filter((phrase) => new RegExp(`\\b${phrase}\\b`, "i").test(prose));
  const passive = [...prose.matchAll(PASSIVE_PATTERN)].slice(0, 6).map((match) => match[0]);
  const hasLists = /(?:^|\n)\s*(?:[-*+] |\d+[.)] )/m.test(prose);
  const hasStepLanguage = /\b(?:first|second|third|steps?|options?|choices?)\b/i.test(prose);
  const bulletOpportunity = !hasLists && hasStepLanguage && sentences.length >= 3;
  const findings = [];
  if (longSentences.length) findings.push({
    kind: "long-sentence",
    message: "Break long sentences into one idea at a time.",
    examples: longSentences.map((item) => `${item.wordCount} words: ${clipped(item.sentence)}`),
  });
  if (longParagraphs.length) findings.push({
    kind: "long-paragraph",
    message: "Split dense paragraphs so the reader can find the next point.",
    examples: longParagraphs.map((item) => `${item.wordCount} words: ${clipped(item.paragraph, 140)}`),
  });
  if (clutter.length) findings.push({
    kind: "clutter",
    message: "Replace padded phrases with direct words.",
    examples: clutter,
  });
  if (passive.length) findings.push({
    kind: "passive-voice",
    message: "Check whether an active subject would make the sentence clearer.",
    examples: passive,
  });
  if (bulletOpportunity) findings.push({
    kind: "bullet-opportunity",
    message: "Turn the steps or choices into bullets to reduce working-memory load.",
    examples: [],
  });

  const hasIssues = findings.length > 0;
  const rewriteInstructions = mode === "simple"
    ? [
        "Start with the answer in one sentence.",
        "Use plain words and short sentences.",
        "Put steps, choices, and comparisons in bullets.",
        "Keep technical terms, but explain each one at first use.",
      ]
    : mode === "analogy"
      ? [
          "Start with the plain technical answer.",
          "Use one familiar analogy, not a chain of metaphors.",
          "Map each important part of the analogy back to the technical idea.",
          "State where the analogy stops being exact.",
        ]
      : [];

  return {
    schema: AIDR_SCHEMA,
    ok: true,
    status: hasIssues ? "needs_revision" : "clear",
    source,
    mode,
    principles: {
      clarity: principle(longSentences.length || longParagraphs.length ? "watch" : "clear",
        "Every sentence should contain the cleanest useful idea."),
      simplicity: principle(clutter.length ? "watch" : "clear",
        "Remove clutter and explain necessary technical terms."),
      brevity: principle(longSentences.length || longParagraphs.length ? "watch" : "clear",
        "If the same meaning fits in fewer words, use fewer words."),
      humanity: principle("manual",
        "Preserve an authentic voice; this cannot be measured reliably by a lint rule."),
    },
    metrics: {
      wordCount: words(prose).length,
      sentenceCount: sentences.length,
      paragraphCount: paragraphs.length,
      longSentenceCount: longSentences.length,
      longParagraphCount: longParagraphs.length,
      clutterPhraseCount: clutter.length,
      passivePhraseCount: passive.length,
      bulletOpportunity,
    },
    findings,
    rewriteInstructions,
    analogyExample: mode === "analogy"
      ? "For FIFO: imagine a bag of bread. The first slice in is the first slice out; the bag tightens around the remaining slices, but the slices are not reordered."
      : undefined,
    editPolicy: "AI;DR is read-only. Use the normal confirmed Pi edit flow to apply a proposed rewrite.",
    nonAuthorizing: true,
    authorityCreated: false,
  };
}

function resolveReviewFile(requestedPath, cwd) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new Error("a file path is required");
  const candidate = resolve(cwd, requestedPath);
  const root = realpathSync(cwd);
  const actual = realpathSync(candidate);
  const relativePath = relative(root, actual);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("AI;DR only reviews files inside the current project");
  if (!ALLOWED_FILE_EXTENSIONS.has(extname(actual).toLowerCase())) throw new Error("AI;DR only reviews Markdown, text, and HTML prose files");
  return actual;
}

export function registerAidrInterface(pi) {
  if (typeof pi?.registerTool !== "function") return;
  let lastAssistantText = "";
  pi.on?.("message_end", async (event) => {
    const text = extractAssistantText(event?.message);
    if (text) lastAssistantText = text;
  });
  pi.registerTool({
    name: "agentic_aidr",
    label: "AI;DR",
    description: "Review the last response, supplied prose, or a Markdown/documentation file for clarity, simplicity, brevity, humanity, and neurodivergent-friendly structure. AI;DR is read-only and never edits files automatically.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", enum: ["last-response", "text", "file"] },
        text: { type: "string", maxLength: MAX_TEXT_BYTES },
        path: { type: "string", maxLength: 1024 },
        mode: { type: "string", enum: ["review", "simple", "analogy"] },
      },
      required: ["source"],
    },
    async execute(_id, params, _signal, _update, context) {
      try {
        let text;
        let source = params.source;
        if (source === "last-response") text = lastAssistantText;
        else if (source === "text") text = params.text;
        else if (source === "file") {
          const path = resolveReviewFile(params.path, context.cwd);
          text = readFileSync(path, "utf8");
          source = path;
        } else throw new Error("AI;DR source must be last-response, text, or file");
        if (!text) throw new Error("there is no text available for AI;DR to review");
        const report = reviewText(text, { mode: params.mode ?? "review", source });
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ schema: AIDR_SCHEMA, ok: false, status: "blocked", reason: error?.message ?? String(error), nonAuthorizing: true, authorityCreated: false }, null, 2) }], details: { ok: false } };
      }
    },
  });
}
