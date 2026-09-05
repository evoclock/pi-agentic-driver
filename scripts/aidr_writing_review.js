// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, resolve, relative } from "node:path";

export const AIDR_SCHEMA = "agentic-driver.aidr.v1";
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DIFF_PREVIEW_BYTES = 12 * 1024;
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
const STE_WORD_GUIDANCE = Object.freeze({
  utilize: "use",
  facilitate: "help",
  approximately: "about",
  commence: "start",
  terminate: "stop",
  "prior to": "before",
  "subsequent to": "after",
  "in lieu of": "instead of",
  numerous: "many",
  sufficient: "enough",
});
const STE_PHRASAL_GUIDANCE = Object.freeze({
  "carry out": "perform",
  "find out": "determine",
  "look at": "examine",
  "set up": "configure or install",
});
const STE_MODAL_GUIDANCE = Object.freeze({
  should: "use must for a requirement, or state the recommendation directly",
  may: "use can for ability or must have permission language when needed",
  might: "state the condition and result directly",
  could: "state the condition and result directly",
  would: "state the action and condition directly",
});
const STE_DOCUMENT_TYPES = new Set(["procedural", "descriptive"]);
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

function proseParagraphs(prose) {
  return prose
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const paragraphs = [];
      let current = "";
      for (const line of block.split("\n")) {
        const startsListItem = /^\s*(?:[-*+] |\d+[.)] )/.test(line);
        if (startsListItem && current.trim()) {
          paragraphs.push(current.trim());
          current = "";
        }
        current += `${line}\n`;
      }
      if (current.trim()) paragraphs.push(current.trim());
      return paragraphs;
    })
    .filter(Boolean);
}

function steTermExamples(prose, terms) {
  return Object.entries(terms)
    .filter(([term]) => new RegExp(`\\b${term.replaceAll(" ", "\\s+")}\\b`, "i").test(prose))
    .map(([term, replacement]) => `${term} → ${replacement}`);
}

function steFindings(prose, sentences, documentType) {
  const findings = [];
  const sentenceLimit = documentType === "descriptive" ? 25 : 20;
  const longSentences = sentences.filter((item) => item.wordCount > sentenceLimit).slice(0, 6);
  if (longSentences.length) findings.push({
    rule: "STE-S1",
    kind: "ste-sentence-length",
    message: `Keep ${documentType} sentences to about ${sentenceLimit} words, then split longer sentences.`,
    examples: longSentences.map((item) => `${item.wordCount} words: ${clipped(item.sentence)}`),
  });
  const wordExamples = steTermExamples(prose, STE_WORD_GUIDANCE);
  if (wordExamples.length) findings.push({
    rule: "STE-W1",
    kind: "ste-word-choice",
    message: "Prefer a direct, familiar word. Confirm the replacement against your licensed ASD-STE100 dictionary or project terminology list.",
    examples: wordExamples,
  });
  const phrasalExamples = steTermExamples(prose, STE_PHRASAL_GUIDANCE);
  if (phrasalExamples.length) findings.push({
    rule: "STE-V1",
    kind: "ste-phrasal-verb",
    message: "Replace an ambiguous phrasal verb with one precise verb when the meaning permits.",
    examples: phrasalExamples,
  });
  const modalExamples = steTermExamples(prose, STE_MODAL_GUIDANCE);
  if (modalExamples.length) findings.push({
    rule: "STE-M1",
    kind: "ste-modal-meaning",
    message: "State requirement, ability, permission, or condition precisely; do not leave the modal meaning implicit.",
    examples: modalExamples,
  });
  if (/\band\/or\b/i.test(prose)) findings.push({
    rule: "STE-C1",
    kind: "ste-conjunction",
    message: "Replace “and/or” with the exact allowed combination.",
    examples: ["and/or"],
  });
  const vagueTime = [...prose.matchAll(/\b(?:as soon as possible|at this point in time|from time to time)\b/gi)]
    .slice(0, 6)
    .map((match) => match[0]);
  if (vagueTime.length) findings.push({
    rule: "STE-A1",
    kind: "ste-ambiguity",
    message: "Use a measurable time or condition instead of a vague time phrase.",
    examples: vagueTime,
  });
  return findings;
}

function principle(status, finding) {
  return { status, finding };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function diffPreview(before, after) {
  const oldLines = before.replaceAll("\r\n", "\n").split("\n");
  const newLines = after.replaceAll("\r\n", "\n").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix).map((line) => `- ${line}`);
  const added = newLines.slice(prefix, newLines.length - suffix).map((line) => `+ ${line}`);
  const header = `@@ lines ${prefix + 1}-${oldLines.length - suffix} -> ${prefix + 1}-${newLines.length - suffix} @@`;
  return clipped([header, ...removed, ...added].join("\n"), MAX_DIFF_PREVIEW_BYTES);
}

function blockedReport(reason, extra = {}) {
  return {
    schema: AIDR_SCHEMA,
    ok: false,
    status: "blocked",
    reason,
    nonAuthorizing: true,
    authorityCreated: false,
    ...extra,
  };
}

export function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function reviewText(input, {
  mode = "review",
  source = "text",
  standard = "none",
  documentType = "procedural",
} = {}) {
  const text = boundedText(input);
  if (!["review", "simple", "analogy", "ste"].includes(mode)) {
    throw new Error("AI;DR mode must be review, simple, analogy, or ste");
  }
  if (!["none", "asd-ste100"].includes(standard)) throw new Error("AI;DR standard must be none or asd-ste100");
  if (!STE_DOCUMENT_TYPES.has(documentType)) throw new Error("AI;DR documentType must be procedural or descriptive");
  const useSte = standard === "asd-ste100" || mode === "simple" || mode === "ste";
  const effectiveStandard = useSte ? "asd-ste100" : "none";
  const prose = visibleProse(text);
  const sentences = sentenceRecords(prose);
  const paragraphs = proseParagraphs(prose);
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
  const steReviewFindings = useSte ? steFindings(prose, sentences, documentType) : [];
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
  findings.push(...steReviewFindings);

  const hasIssues = findings.length > 0;
  const rewriteInstructions = mode === "simple" || mode === "ste"
    ? [
        "Start with the answer in one sentence.",
        "Use plain words and short sentences.",
        "Put steps, choices, and comparisons in bullets.",
        "Keep technical terms, but explain each one at first use.",
        "Use ASD-STE100-style controlled English as an advisory guide: choose one precise term, state one action per sentence, and make requirements, permissions, and conditions explicit.",
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
    standard: effectiveStandard,
    documentType,
    principles: {
      clarity: principle(longSentences.length || longParagraphs.length || steReviewFindings.some((item) => item.rule === "STE-S1") ? "watch" : "clear",
        "Every sentence should contain the cleanest useful idea."),
      simplicity: principle(clutter.length || steReviewFindings.some((item) => ["STE-W1", "STE-V1"].includes(item.rule)) ? "watch" : "clear",
        "Remove clutter and explain necessary technical terms."),
      brevity: principle(longSentences.length || longParagraphs.length || steReviewFindings.some((item) => item.rule === "STE-S1") ? "watch" : "clear",
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
      steFindingCount: steReviewFindings.length,
    },
    standards: useSte ? {
      "ASD-STE100": {
        status: steReviewFindings.length ? "watch" : "advisory_clear",
        profile: "ASD-STE100-informed",
        rulesApplied: [...new Set(steReviewFindings.map((item) => item.rule))],
        findings: steReviewFindings,
        limitation: "This bounded advisory profile does not reproduce the licensed ASD-STE100 dictionary and does not certify conformance.",
      },
    } : undefined,
    findings,
    rewriteInstructions,
    analogyExample: mode === "analogy"
      ? "For FIFO: imagine a bag of bread. The first slice in is the first slice out; the bag tightens around the remaining slices, but the slices are not reordered."
      : undefined,
    editPolicy: "Review is read-only. File rewrites require an explicit apply action, an exact replacement, native confirmation, and drift revalidation.",
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

async function applyConfirmedFileReplacement(path, before, replacement, context) {
  boundedText(replacement, "replacement");
  if (before === replacement) return blockedReport("the proposed replacement is identical to the current file", { action: "apply", path });
  if (typeof context?.ui?.confirm !== "function") {
    return blockedReport("native confirmation is unavailable; AI;DR will not write the file", { action: "apply", path });
  }
  const preview = diffPreview(before, replacement);
  const confirmed = await context.ui.confirm(
    "AI;DR: apply confirmed rewrite",
    `File: ${path}\n\n${preview}\n\nApply this exact replacement?`,
  );
  if (!confirmed) return blockedReport("native confirmation declined", { action: "apply", path, diffPreview: preview });
  const current = readFileSync(path, "utf8");
  if (current !== before) return blockedReport("the file changed after review; no write was performed", { action: "apply", path, diffPreview: preview });
  writeFileSync(path, replacement, "utf8");
  const after = readFileSync(path, "utf8");
  if (after !== replacement) throw new Error("the file did not match the confirmed replacement after writing");
  return {
    schema: AIDR_SCHEMA,
    ok: true,
    status: "applied",
    action: "apply",
    path,
    diffPreview: preview,
    beforeHash: sha256(before),
    afterHash: sha256(after),
    nonAuthorizing: true,
    authorityCreated: false,
  };
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
    description: "Review the last response, supplied prose, or a Markdown/documentation file for clarity, simplicity, brevity, humanity, neurodivergent-friendly structure, and optional ASD-STE100-informed controlled English. An explicit file apply action can write an exact proposed replacement only after native confirmation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["review", "apply"] },
        source: { type: "string", enum: ["last-response", "text", "file"] },
        text: { type: "string", maxLength: MAX_TEXT_BYTES },
        replacement: { type: "string", maxLength: MAX_TEXT_BYTES },
        path: { type: "string", maxLength: 1024 },
        mode: { type: "string", enum: ["review", "simple", "analogy", "ste"] },
        standard: { type: "string", enum: ["none", "asd-ste100"] },
        documentType: { type: "string", enum: ["procedural", "descriptive"] },
      },
      required: ["source"],
    },
    async execute(_id, params, _signal, _update, context) {
      try {
        const action = params.action ?? "review";
        if (!["review", "apply"].includes(action)) throw new Error("AI;DR action must be review or apply");
        let text;
        let source = params.source;
        let path;
        if (source === "last-response") text = lastAssistantText;
        else if (source === "text") text = params.text;
        else if (source === "file") {
          path = resolveReviewFile(params.path, context.cwd);
          text = readFileSync(path, "utf8");
          source = path;
        } else throw new Error("AI;DR source must be last-response, text, or file");
        if (!text) throw new Error("there is no text available for AI;DR to review");
        if (action === "apply") {
          if (source !== path) throw new Error("AI;DR apply is available only for files");
          const result = await applyConfirmedFileReplacement(path, text, params.replacement, context);
          if (result.ok) result.review = reviewText(params.replacement, {
            mode: params.mode ?? "simple",
            standard: params.standard ?? "none",
            documentType: params.documentType ?? "procedural",
            source: path,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        }
        const report = reviewText(text, {
          mode: params.mode ?? "review",
          standard: params.standard ?? "none",
          documentType: params.documentType ?? "procedural",
          source,
        });
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report };
      } catch (error) {
        const report = blockedReport(error?.message ?? String(error));
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: { ok: false } };
      }
    },
  });
}
