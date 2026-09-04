// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeTypeScriptSource } from "./typescript_ast_metrics.mjs";
import { changedRanges } from "./adapters/diff-scope.mjs";
import { buildEvidence, buildCandidates } from "./adapters/evidence.mjs";
import { buildReviewFeedback, REVIEW_INTENT_VOCABULARY } from "./adapters/review-feedback.mjs";
import { buildNarrative, NARRATIVE_SCHEMA, validateNarrative } from "./adapters/narrative.mjs";
import { buildVisualization, THERMALL_POWER_STATION } from "./adapters/visualization.mjs";

export { buildNarrative, validateNarrative, NARRATIVE_SCHEMA, buildVisualization, THERMALL_POWER_STATION };

export const CODE_PHAGE_SCHEMA = "agentic-driver.code-phage.v1";
const MAX_GOAL_BYTES = 4_000;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 512_000;
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".py", ".ts", ".tsx"]);
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
  "is", "it", "of", "on", "or", "the", "this", "to", "use", "with",
  "test", "tests", "code", "check", "checks", "over", "under", "work", "works",
  "run", "runs", "file", "files", "data", "value", "values", "report",
  "reporting", "when", "where", "which", "while", "must", "should", "that",
  "than", "then", "them", "they", "will", "only", "also", "each", "before",
  "after", "without", "declared", "declares",
]);
const PYTHON_METRICS_PATH = fileURLToPath(new URL("./python_ast_metrics.py", import.meta.url));
const WRITE_PATTERN = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|mkdir(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|open\s*\()/;
const PROCESS_PATTERN = /\b(?:spawn|spawnSync|exec|execSync|fork)\s*\(/;
const NETWORK_PATTERN = /\b(?:fetch|https?\.|axios|requests\.)/;
const NETWORK_IMPORT_PATTERN = /(?:\bimport\s+[\s\S]{0,200}?from\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])(?:node:)?(?:http|https|undici|axios)\1/g;
const TIMER_PATTERN = /\b(?:setTimeout|setInterval)\s*\(/;
// Generic identifier words that carry no abstraction identity. Splitting
// snake_case/camelCase symbols yields these constantly (order_total ->
// "order", loadManifest -> "load"), so a single such word must never count
// as a structural prior-art signal. Distinctive multi-word overlap or a full
// symbol-name/signature match is still required to claim reuse.
const GENERIC_SYMBOL_WORDS = new Set([
  "default", "exports", "module", "root", "main", "index", "init",
  "config", "utils", "helpers", "common", "shared", "core", "base",
  "load", "save", "read", "write", "open", "close", "run", "exec",
  "get", "set", "add", "remove", "delete", "create", "make", "build",
  "update", "process", "handle", "parse", "format", "validate",
  "check", "test", "assert", "verify", "report", "print", "log",
  "compute", "sum", "total", "count", "size", "length", "value",
  "item", "items", "entry", "entries", "list", "map", "key", "name",
  "type", "kind", "data", "info", "detail", "details", "state",
  "status", "result", "results", "output", "input", "source", "target",
  "path", "file", "dir", "line", "text", "message", "error", "warn",
  "order", "record", "schema", "model", "view", "controller", "service",
  "manager", "handler", "wrapper", "client", "server", "api", "app",
  "self", "cls", "args", "params", "options", "settings", "props",
  "fixture", "fixtures", "sample", "example", "demo", "mock", "stub",
]);

function fail(message) {
  throw new Error(message);
}

function text(value, field, maxBytes = MAX_GOAL_BYTES) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) {
    fail(`${field} must be non-empty text without outer whitespace or NUL`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail(`${field} exceeds the bounded size`);
  return value;
}

function tokens(value) {
  return [...new Set(
    String(value).toLowerCase().replaceAll("-", " ").replaceAll("_", " ").match(/[a-z][a-z0-9]*/g) || [],
  )].filter((item) => item.length > 1 && !STOP_WORDS.has(item)).sort();
}

function safeRelativePath(value) {
  text(value, "path", 1_024);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized === "." || normalized.split("/").some((part) => part === ".." || part === "")) {
    fail(`path must be repository-relative and contained: ${value}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) fail("Git administrative paths are not analyzable");
  return normalized;
}

function boundedTextArray(value, field, pathValues = false) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILES) fail(`${field} must contain at most ${MAX_FILES} items`);
  return value.map((item) => {
    text(item, field, MAX_GOAL_BYTES);
    if (pathValues) safeRelativePath(item);
    return item;
  });
}

function repositoryRoot(root) {
  const candidate = resolve(text(root, "root", 4_096));
  try {
    if (!statSync(candidate).isDirectory()) fail("root is not a directory");
    return realpathSync(candidate);
  } catch {
    fail("root is unavailable");
  }
}

function changedPaths(root) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) return { paths: [], status: "git-unavailable", reason: "Git status was unavailable; no changed-file inference was made." };
  const paths = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    let value = line.slice(3).trim();
    if (value.includes(" -> ")) value = value.split(" -> ").at(-1);
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { continue; }
    }
    try { paths.push(safeRelativePath(value)); } catch { /* status output is advisory */ }
  }
  return { paths: [...new Set(paths)].sort(), status: "observed" };
}

function candidatePaths(root, requested) {
  if (requested !== undefined && (!Array.isArray(requested) || requested.length > MAX_FILES)) {
    fail(`candidatePaths must contain at most ${MAX_FILES} paths`);
  }
  const observed = requested === undefined ? changedPaths(root) : { paths: requested.map(safeRelativePath), status: "requested" };
  const limitations = observed.reason ? [observed.reason] : [];
  const files = [];
  for (const value of [...new Set(observed.paths)].sort()) {
    const absolute = resolve(root, value);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith("..") || absolute === root) {
      limitations.push(`excluded path outside repository: ${value}`);
      continue;
    }
    try {
      let cursor = root;
      for (const part of rel.split("/")) {
        cursor = resolve(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) {
          limitations.push(`excluded symlinked path: ${value}`);
          cursor = undefined;
          break;
        }
      }
      if (!cursor) continue;
      const canonical = realpathSync(absolute);
      const canonicalRelative = relative(root, canonical);
      if (!canonicalRelative || canonicalRelative.startsWith("..") || canonicalRelative.includes("/../")) {
        limitations.push(`excluded path resolving outside repository: ${value}`);
        continue;
      }
      const info = lstatSync(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        limitations.push(`excluded non-regular or symlink path: ${value}`);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        limitations.push(`excluded oversized source file: ${value}`);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(extname(value).toLowerCase())) files.push(value);
      else limitations.push(`excluded unsupported source extension: ${value}`);
    } catch {
      limitations.push(`excluded unavailable path: ${value}`);
    }
  }
  return { files: files.slice(0, MAX_FILES), limitations, source: observed.status };
}

function sourceLines(source) {
  return source.split(/\r?\n/);
}

function codeLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return "";
  return line.replace(/\/\/.*$/, "").replace(/#.*$/, "").trim();
}

function lineCounts(source) {
  const lines = sourceLines(source);
  let codeLines = 0;
  let commentLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) commentLines += 1;
    else codeLines += 1;
  }
  return { lines: lines.length, codeLines, commentLines, blankLines: lines.length - codeLines - commentLines };
}

function runPythonAstMetrics(source, path) {
  const result = spawnSync("python3", [PYTHON_METRICS_PATH], {
    input: JSON.stringify({ source, path }),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      status: "unavailable",
      path,
      language: "python",
      method: "ast-v1",
      parser: "python.ast",
      ...lineCounts(source),
      error: "Python AST parser could not be executed; complexity metrics are unavailable.",
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      status: "unavailable",
      path,
      language: "python",
      method: "ast-v1",
      parser: "python.ast",
      ...lineCounts(source),
      error: "Python AST parser returned invalid evidence; complexity metrics are unavailable.",
    };
  }
}

function moduleLevelMutableBindings(source, path) {
  if (extname(path).toLowerCase() === ".py") {
    return sourceLines(source).filter((line) => /^\s{0}(?!def\b|class\b)[A-Za-z_]\w*\s*(?::[^=]+)?=/.test(line)).length;
  }
  let depth = 0;
  let count = 0;
  for (const line of sourceLines(source)) {
    if (depth === 0) {
      const declaration = line.match(/^\s*(?:export\s+)?(?:let|var)\s+(.+?)(?:;|$)/);
      if (declaration) count += declaration[1].split(",").length;
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  }
  return count;
}

function analyzeSource(source, path) {
  const ast = extname(path).toLowerCase() === ".py"
    ? runPythonAstMetrics(source, path)
    : analyzeTypeScriptSource(source, path);
  const normalized = [];
  for (const line of sourceLines(source)) {
    const code = codeLine(line);
    if (code) normalized.push(code.replace(/\s+/g, " "));
  }
  const frequencies = new Map();
  for (const line of normalized) {
    if (line.length >= 8) frequencies.set(line, (frequencies.get(line) || 0) + 1);
  }
  const duplicateLineCount = [...frequencies.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count - 1, 0);
  const codeFacts = ast.codeFacts ?? {
    exportedSymbols: [],
    exportedFunctions: [],
    dependencies: [],
    purpose: null,
  };
  return {
    ...ast,
    codeFacts,
    moduleLevelMutableBindings: moduleLevelMutableBindings(source, path),
    duplicateLineCount,
    stateSignals: {
      writes: WRITE_PATTERN.test(source),
      processes: PROCESS_PATTERN.test(source),
      network: NETWORK_PATTERN.test(source) || NETWORK_IMPORT_PATTERN.test(source),
      timers: TIMER_PATTERN.test(source),
    },
  };
}

function inventoryMatches(root, goal, targetRecords = []) {
  const path = resolve(root, "pipeline_output", "codebase_inventory.jsonl");
  const wordHits = (haystack, term) => String(haystack).toLowerCase().split(/[^a-z0-9]+/).includes(String(term).toLowerCase());
  const asArray = (value) => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const factSources = (record) => [record, record?.codeFacts, record?.code_facts]
    .filter((value) => value && typeof value === "object");
  const hasField = (record, names) => factSources(record)
    .some((source) => names.some((name) => Object.prototype.hasOwnProperty.call(source, name)));
  const fieldValues = (record, names) => factSources(record).flatMap((source) => names.flatMap((name) => asArray(source[name])));
  const stringValues = (value) => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(stringValues);
    if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
    return [];
  };
  const uniqueStrings = (values) => [...new Set(values
    .flatMap(stringValues)
    .map((value) => value.trim())
    .filter(Boolean))];
  const identifierWords = (value) => [...new Set(
    String(value)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/[$]/g, " ")
      .replace(/[_.:/-]+/g, " ")
      .toLowerCase()
      .match(/[a-z][a-z0-9]*/g) || [],
  )].filter((item) => item.length > 1 && !STOP_WORDS.has(item) && !GENERIC_SYMBOL_WORDS.has(item));
  const symbolNames = (record) => {
    const exportedFields = [
      "exportedSymbols", "exported_symbols", "exportedNames", "exported_names", "symbolNames", "symbol_names", "exports", "exported",
    ];
    let values = uniqueStrings(fieldValues(record, exportedFields));
    const hasSymbols = hasField(record, ["symbols"]);
    values = [...new Set([
      ...values,
      ...uniqueStrings(fieldValues(record, ["symbols"])),
    ])];
    if (values.length || hasField(record, exportedFields) || hasSymbols) return values;
    return [...new Set([
      ...asArray(record?.functions)
        .filter((item) => item && typeof item === "object" && item.public !== false)
        .map((item) => item.name)
        .filter(Boolean),
      ...asArray(record?.classes)
        .filter((item) => item && typeof item === "object" && item.public !== false)
        .map((item) => item.name)
        .filter(Boolean),
    ])];
  };
  const signatureFromString = (value) => {
    const textValue = String(value).trim();
    let match = textValue.match(/^(.+?)\s*\((\d+)\)$/);
    if (!match) match = textValue.match(/^(.+?)\s*[/#:](\d+)$/);
    return match ? { name: match[1].trim(), parameterCount: Number(match[2]) } : undefined;
  };
  const signatureEntries = (record) => {
    const signatureFields = [
      "exportedFunctions", "exported_functions", "exportedFunctionSignatures", "exported_function_signatures", "functionSignatures", "function_signatures", "signatures", "symbols",
    ];
    const flattenSignatures = (value) => {
      if (Array.isArray(value)) return value.flatMap(flattenSignatures);
      if (value && typeof value === "object"
        && !("name" in value || "symbol" in value || "parameterCount" in value
          || "parameter_count" in value || "arity" in value)) {
        return Object.entries(value).flatMap(([name, nested]) => {
          if (Number.isInteger(nested)) return [{ name, parameterCount: nested }];
          if (nested && typeof nested === "object" && !Array.isArray(nested)
            && !("name" in nested || "symbol" in nested)) return [{ name, ...nested }];
          return flattenSignatures(nested);
        });
      }
      return [value];
    };
    const values = fieldValues(record, signatureFields).flatMap(flattenSignatures);
    const functions = hasField(record, signatureFields)
      ? []
      : asArray(record?.functions)
        .filter((item) => item && typeof item === "object" && item.public !== false)
        .filter((item) => !hasField(record, [
          "exportedSymbols", "exported_symbols", "exportedNames", "exported_names", "symbolNames", "symbol_names", "exports", "exported",
        ]) || symbolNames(record).includes(item.name));
    const entries = [...values, ...functions];
    const result = [];
    const seen = new Set();
    for (const value of entries) {
      const signature = typeof value === "string"
        ? signatureFromString(value)
        : value && typeof value === "object"
          ? {
            name: value.name ?? value.symbol,
            parameterCount: value.parameterCount ?? value.parameter_count ?? value.arity
              ?? (typeof value.parameters === "number" ? value.parameters : undefined)
              ?? (typeof value.params === "number" ? value.params : undefined)
              ?? (typeof value.args === "number" ? value.args : undefined)
              ?? (Array.isArray(value.args) ? value.args.length : undefined)
              ?? (Array.isArray(value.parameters) ? value.parameters.length : undefined)
              ?? (Array.isArray(value.params) ? value.params.length : undefined),
          }
          : undefined;
      if (!signature || typeof signature.name !== "string" || !signature.name.trim()) continue;
      if (!Number.isInteger(signature.parameterCount) || signature.parameterCount < 0) continue;
      const normalized = { name: signature.name.trim(), parameterCount: signature.parameterCount };
      const key = `${normalized.name}/${normalized.parameterCount}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(normalized);
      }
    }
    return result;
  };
  const dependencyValues = (record) => {
    const dependencyFields = ["dependencies", "moduleDependencies", "module_dependencies"];
    const explicit = hasField(record, dependencyFields);
    const values = explicit ? fieldValues(record, dependencyFields) : fieldValues(record, ["imports"]);
    return uniqueStrings(values).flatMap((value) => {
      const normalized = value.replace(/^['\"]|['\"]$/g, "").replace(/^node:/, "");
      if (!normalized) return [];
      if (explicit) return [normalized];
      // Older inventory records stored `from module import name` as module.name.
      // Keep the full value and its Python-style root for compatibility.
      const rootName = normalized.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      return rootName && normalized.includes(".") ? [normalized, rootName] : [normalized];
    });
  };
  const purposeText = (record) => uniqueStrings(fieldValues(record, ["purpose", "module_docstring", "header_comments"]))[0] ?? "";
  const semanticFields = (record) => `${purposeText(record)} ${record?.filename ?? ""} ${symbolNames(record).join(" ")}`;
  // Inventory facts retain only declared parameter counts, so compatibility is
  // exact arity; unknown counts are deliberately not treated as compatible.
  const compatibleArity = (left, right) => left.parameterCount === right.parameterCount;
  const targetList = asArray(targetRecords).filter((record) => record && typeof record === "object");
  const targetPaths = new Set(targetList.map((record) => record.path).filter(Boolean));

  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); }
      catch { return { status: "invalid", matches: [], distinctiveTerms: [], limitation: "inventory contains invalid JSON; prior-art result is incomplete." }; }
    }
    if (!records.length) return { status: "missing", matches: [], distinctiveTerms: [] };
    const priorRecords = records.filter((record) => !targetPaths.has(record.path));

    // Purpose terms are retained for diagnostics and ranking only. They never
    // create a match without a code-structural signal.
    const goalTokens = tokens(goal);
    const documentFrequency = new Map(goalTokens.map((term) => [
      term,
      priorRecords.filter((record) => wordHits(semanticFields(record), term)).length,
    ]));
    const distinctiveTerms = goalTokens.filter((term) => {
      const frequency = documentFrequency.get(term) ?? 0;
      return frequency > 0 && frequency <= Math.max(1, Math.floor(records.length / 2));
    });
    const targetSymbolTerms = [...new Set(targetList.flatMap((record) => symbolNames(record).flatMap(identifierWords)))];
    const symbolFrequency = new Map(targetSymbolTerms.map((term) => [
      term,
      priorRecords.filter((record) => symbolNames(record).some((name) => identifierWords(name).includes(term))).length,
    ]));
    const distinctiveSymbolTerms = targetSymbolTerms.filter((term) => {
      const frequency = symbolFrequency.get(term) ?? 0;
      return frequency > 0 && frequency <= Math.max(1, Math.floor(records.length / 2));
    });

    const matches = records.map((record, index) => {
      if (targetPaths.has(record.path)) return undefined;
      const recordSymbolTerms = new Set(symbolNames(record).flatMap(identifierWords));
      const symbolMatches = distinctiveSymbolTerms.filter((term) => recordSymbolTerms.has(term));
      const signatureMatches = [];
      const priorSignatures = signatureEntries(record);
      for (const target of targetList) {
        for (const left of signatureEntries(target)) {
          for (const right of priorSignatures) {
            if (left.name === right.name && compatibleArity(left, right)) {
              const value = { name: left.name, parameterCount: left.parameterCount };
              if (!signatureMatches.some((item) => item.name === value.name && item.parameterCount === value.parameterCount)) {
                signatureMatches.push(value);
              }
            }
          }
        }
      }
      const targetDependencies = new Set(targetList.flatMap(dependencyValues));
      const dependencyMatches = [...new Set(dependencyValues(record).filter((dependency) => targetDependencies.has(dependency)))].sort();
      const signals = [];
      if (symbolMatches.length) signals.push("symbols");
      if (signatureMatches.length) signals.push("signatures");
      if (dependencyMatches.length) signals.push("dependencies");
      if (!signals.length) return undefined;
      const purposeMatches = distinctiveTerms.filter((term) => wordHits(purposeText(record), term));
      return {
        path: record.path,
        name: record.name ?? record.filename ?? record.path,
        matchedTerms: [...new Set([...symbolMatches, ...purposeMatches])],
        structuralSignals: {
          symbols: symbolMatches,
          signatures: signatureMatches,
          dependencies: dependencyMatches,
        },
        signals,
        purposeTerms: purposeMatches,
        signalCount: signals.length,
        _index: index,
      };
    }).filter(Boolean)
      .sort((left, right) => right.signalCount - left.signalCount
        || right.purposeTerms.length - left.purposeTerms.length
        || left._index - right._index)
      .map(({ _index, ...match }) => match);
    return { status: matches.length ? "observed" : "none", matches: matches.slice(0, 12), distinctiveTerms };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", matches: [], distinctiveTerms: [], limitation: "codebase inventory is missing; no prior-art absence is inferred." };
    return { status: "unavailable", matches: [], distinctiveTerms: [], limitation: "codebase inventory could not be read; no prior-art absence is inferred." };
  }
}

function scopeAssessment(goal, files) {
  const goalTerms = tokens(goal);
  const possibleDriftPaths = files.filter((path) => {
    const pathTerms = tokens(path.replaceAll("/", " "));
    return !goalTerms.some((term) => pathTerms.includes(term));
  });
  const retainedWriteSet = files.filter((path) => !possibleDriftPaths.includes(path));
  return {
    status: possibleDriftPaths.length ? "review-required" : "aligned-signal",
    goalTerms,
    possibleDriftPaths,
    retainedWriteSet,
    excludedPaths: possibleDriftPaths,
    smallestCoherentScope: retainedWriteSet,
    rule: "Lexical signal only; scope fields are advisory and never block work or replace human scope judgment.",
  };
}

const CREDIT_FIELDS = ["source", "version", "license", "accessed"];

function creditAssessment(credits) {
  if (credits === undefined) return { incompleteCredit: false };
  const values = Array.isArray(credits) ? credits : [];
  return {
    credits: values,
    incompleteCredit: !Array.isArray(credits) || values.some((credit) =>
      !credit || typeof credit !== "object" || CREDIT_FIELDS.some((field) =>
        typeof credit[field] !== "string" || !credit[field].trim())),
  };
}

function requirementCoverage(repository, requirements, tests, analyses) {
  const searchable = (analysis) => `${analysis.path} ${JSON.stringify(analysis.codeFacts || {})} ${(analysis.callables || []).map((item) => item.name).join(" ")}`.toLowerCase();
  const bindings = analyses.map((analysis) => ({
    path: analysis.path,
    acceptedRequirements: requirements.filter((requirement) => {
      const terms = tokens(requirement);
      const haystack = searchable(analysis);
      return terms.length > 0 && terms.some((term) => haystack.includes(term));
    }),
  }));
  const bound = new Set(bindings.flatMap((item) => item.acceptedRequirements));
  const uncoveredTests = tests.filter((path) => {
    try {
      const absolute = resolve(repository, safeRelativePath(path));
      const rel = relative(repository, absolute);
      return !rel || rel.startsWith("..") || !statSync(absolute).isFile();
    } catch { return true; }
  });
  return {
    candidateBindings: bindings,
    unboundCandidateFiles: bindings.filter((item) => item.acceptedRequirements.length === 0).map((item) => item.path),
    unboundRequirements: requirements.filter((requirement) => !bound.has(requirement)),
    uncoveredTests,
    advisoryOnly: true,
  };
}

function comparisonMetrics(result) {
  const files = Array.isArray(result.files) ? result.files : [];
  const candidateFiles = result.budget?.candidateFiles || [];
  const callableNames = files.flatMap((file) => (file.callables || []).map((item) => item.name));
  const frequencies = callableNames.reduce((counts, name) => counts.set(name, (counts.get(name) || 0) + 1), new Map());
  return {
    dependencies: [...new Set(files.flatMap((file) => file.codeFacts?.dependencies || []))].sort(),
    moduleLevelMutableBindings: files.reduce((sum, file) => sum + (Number(file.moduleLevelMutableBindings) || 0), 0),
    testFilesInWriteSet: candidateFiles.filter((path) => /(^|\/)(?:test[^/]*|tests?)(?:\/|[._-])/i.test(path)).sort(),
    rollbackProxy: {
      lines: files.reduce((sum, file) => sum + (Number(file.lines) || 0), 0),
      files: candidateFiles.length,
    },
    duplicateFunctionNames: [...frequencies].filter(([, count]) => count > 1).map(([name]) => name).sort(),
  };
}

export function assessScopeDrift(goal, allowedPaths = [], path) {
  const value = safeRelativePath(path);
  const allowed = Array.isArray(allowedPaths) ? allowedPaths.map(safeRelativePath) : [];
  if (allowed.length && !allowed.some((prefix) => value === prefix || value.startsWith(`${prefix}/`))) {
    return { status: "possible-drift", path: value, reason: "path is outside the reviewed candidate scope" };
  }
  const assessment = scopeAssessment(goal, [value]);
  return assessment.possibleDriftPaths.length
    ? { status: "possible-drift", path: value, reason: "path has no lexical goal-term match" }
    : undefined;
}

export function compareCodePhagePlan(plan, review) {
  if (!plan || plan.schema !== CODE_PHAGE_SCHEMA || plan.phase !== "plan") {
    return { status: "no-plan", reason: "no prior code-phage plan is available for comparison" };
  }
  if (!review || review.schema !== CODE_PHAGE_SCHEMA || review.phase !== "review") {
    return { status: "not-a-review", reason: "the current result is not a code-phage review" };
  }
  if (plan.goal !== review.goal) {
    return { status: "no-plan", reason: "the stored plan has a different goal; comparison requires a plan from the same stated goal" };
  }
  const planned = new Set(plan.budget?.candidateFiles || []);
  const actual = new Set(review.budget?.candidateFiles || []);
  const addedPaths = [...actual].filter((path) => !planned.has(path)).sort();
  const removedPaths = [...planned].filter((path) => !actual.has(path)).sort();
  const delta = (field) => (review.budget?.[field] || 0) - (plan.budget?.[field] || 0);
  const plannedMetrics = comparisonMetrics(plan);
  const realizedMetrics = comparisonMetrics(review);
  const listDelta = (field) => {
    const before = plan.budget?.[field] || [];
    const after = review.budget?.[field] || [];
    return {
      planned: before,
      realized: after,
      added: after.filter((item) => !before.includes(item)),
      removed: before.filter((item) => !after.includes(item)),
    };
  };
  return {
    status: addedPaths.length ? "scope-expanded" : "within-planned-scope",
    goalMatch: true,
    plannedPaths: [...planned].sort(),
    realizedPaths: [...actual].sort(),
    addedPaths,
    removedPaths,
    acceptedRequirements: listDelta("acceptedRequirements"),
    testPaths: listDelta("testPaths"),
    plannedDependencies: plannedMetrics.dependencies,
    realizedDependencies: realizedMetrics.dependencies,
    addedDependencies: realizedMetrics.dependencies.filter((item) => !plannedMetrics.dependencies.includes(item)),
    removedDependencies: plannedMetrics.dependencies.filter((item) => !realizedMetrics.dependencies.includes(item)),
    moduleLevelMutableBindingCount: {
      planned: plannedMetrics.moduleLevelMutableBindings,
      realized: realizedMetrics.moduleLevelMutableBindings,
      delta: realizedMetrics.moduleLevelMutableBindings - plannedMetrics.moduleLevelMutableBindings,
    },
    testFilesInWriteSet: {
      planned: plannedMetrics.testFilesInWriteSet,
      realized: realizedMetrics.testFilesInWriteSet,
    },
    rollbackProxy: {
      planned: plannedMetrics.rollbackProxy,
      realized: realizedMetrics.rollbackProxy,
      delta: {
        lines: realizedMetrics.rollbackProxy.lines - plannedMetrics.rollbackProxy.lines,
        files: realizedMetrics.rollbackProxy.files - plannedMetrics.rollbackProxy.files,
      },
    },
    duplicateFunctionNames: {
      planned: plannedMetrics.duplicateFunctionNames,
      realized: realizedMetrics.duplicateFunctionNames,
    },
    metricDelta: {
      lines: delta("observedLines"),
      codeLines: delta("observedCodeLines"),
      cognitiveComplexity: delta("observedCognitiveComplexity"),
      cyclomaticComplexity: delta("observedCyclomaticComplexity"),
      duplicateLines: delta("observedDuplicateLines"),
    },
    reviewQuestion: addedPaths.length
      ? "Which accepted requirement or failure-mode check justifies each added path?"
      : "Which accepted requirement or failure-mode check would fail if any realized unit were removed?",
  };
}

export function analyzeCodePhage({
  root,
  goal,
  candidatePaths: requestedPaths,
  phase = "plan",
  credits,
  acceptedRequirements,
  testPaths,
}) {
  const repository = repositoryRoot(root);
  const purpose = text(goal, "goal");
  const requirements = boundedTextArray(acceptedRequirements, "acceptedRequirements");
  const tests = boundedTextArray(testPaths, "testPaths", true);
  if (!["plan", "review"].includes(phase)) fail("phase must be plan or review");
  const selected = candidatePaths(repository, requestedPaths);
  const analyses = [];
  const limitations = [...selected.limitations];
  for (const path of selected.files) {
    try { analyses.push(analyzeSource(readFileSync(resolve(repository, path), "utf8"), path)); }
    catch { limitations.push(`source could not be read: ${path}`); }
  }
  const inventory = inventoryMatches(repository, purpose, analyses);
  if (inventory.limitation) limitations.push(inventory.limitation);
  const total = (field) => analyses.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
  const max = (field) => analyses.reduce((value, item) => Math.max(value, Number(item[field]) || 0), 0);
  const coverage = requirementCoverage(repository, requirements, tests, analyses);
  return {
    schema: CODE_PHAGE_SCHEMA,
    status: "advisory-review",
    phase,
    advisoryOnly: true,
    authorityCreated: false,
    mutated: false,
    repository,
    goal: purpose,
    ...creditAssessment(credits),
    priorArt: {
      status: inventory.status,
      matches: inventory.matches,
      distinctiveTerms: inventory.distinctiveTerms,
      absenceClaimed: false,
      creditRequired: inventory.matches.length > 0,
    },
    scope: scopeAssessment(purpose, selected.files),
    budget: {
      basis: "code-phage.v1",
      candidateFiles: selected.files,
      fileCount: selected.files.length,
      observedLines: total("lines"),
      observedCodeLines: total("codeLines"),
      observedCognitiveComplexity: total("totalCognitiveComplexity"),
      observedCyclomaticComplexity: total("totalCyclomaticComplexity"),
      observedDuplicateLines: total("duplicateLineCount"),
      suggestedWriteSet: selected.files,
      acceptedRequirements: requirements,
      testPaths: tests,
      coverageCheck: coverage,
      unboundRequirements: coverage.unboundRequirements,
      uncoveredTests: coverage.uncoveredTests,
      acceptanceChecks: [
        "Every changed unit supports an accepted requirement or failure-mode check.",
        "Prior art and existing abstractions were inspected before new code.",
        "Complexity signals are diagnostic, not universal rejection thresholds.",
        "Scope additions receive a possible-drift warning and human review.",
      ],
      deletionTest: "Which accepted semantic requirement or failure-mode check would fail if this unit were removed?",
      thresholdsAreAdvisory: true,
    },
    files: analyses,
    summary: {
      filesAnalyzed: analyses.length,
      maxCognitiveComplexity: max("cognitiveComplexity"),
      maxCyclomaticComplexity: max("cyclomaticComplexity"),
      duplicateLines: total("duplicateLineCount"),
      statefulFiles: analyses.filter((item) => Object.values(item.stateSignals).some(Boolean)).map((item) => item.path),
    },
    limitations,
    nextAction: "Review prior-art matches, possible scope drift, complexity signals, and the deletion test; no source mutation is performed.",
  };
}

export function canonicalDigest(value) {
  return createHash("sha256").update(JSON.stringify(value, Object.keys(value).sort())).digest("hex");
}

// Map changed line ranges onto AST callables. Concept provenance: pi-simplify
// changed-line scope, extended to AST callable spans with content-bound
// anchors (Review Craft style). Pure function; no Git or filesystem access.
export function mapChangedRangesToCallables(analysis, changedFile) {
  if (!analysis || analysis.status !== "parsed" || !Array.isArray(analysis.callables)) {
    return { status: analysis?.status === "parse-error" ? "parse-error" : "unavailable", touchedCallables: [] };
  }
  const added = Array.isArray(changedFile?.added) ? changedFile.added : [];
  const removed = Array.isArray(changedFile?.removed) ? changedFile.removed : [];
  const classify = (callable) => {
    const start = Number(callable.line) || 0;
    const end = Number(callable.endLine) || start;
    const addedOverlap = added.some((range) => range.start <= end && range.end >= start);
    const removedOverlap = removed.some((range) => range.start <= end && range.end >= start);
    if (addedOverlap && removedOverlap) return "modified";
    if (addedOverlap) return "added-lines";
    if (removedOverlap) return "removed-lines";
    return undefined;
  };
  const touchedCallables = analysis.callables
    .map((callable) => ({
      name: callable.name,
      kind: callable.kind,
      line: callable.line,
      endLine: callable.endLine,
      cyclomaticComplexity: callable.cyclomaticComplexity,
      cognitiveComplexity: callable.cognitiveComplexity,
      changeClassification: changedFile?.wholeCurrentFile ? "whole-file" : classify(callable),
    }))
    .filter((item) => item.changeClassification)
    .sort((a, b) => a.line - b.line);
  return { status: "mapped", touchedCallables };
}

// Analyze the current changed scope against a ref. Read-only; advisory only.
export function analyzeChangedCodePhage({ root, goal, ref = "HEAD", phase = "review" }) {
  const repository = repositoryRoot(root);
  const purpose = text(goal, "goal");
  const scope = changedRanges(repository, ref);
  const analyses = [];
  const limitations = [...scope.limitations];
  const touched = [];
  const candidates = [];
  const candidatePaths = scope.files
    .filter((file) => file.status !== "D" && SOURCE_EXTENSIONS.has(extname(file.path).toLowerCase()))
    .map((file) => file.path)
    .slice(0, MAX_FILES);
  for (const path of candidatePaths) {
    try {
      const source = readFileSync(resolve(repository, path), "utf8");
      const analysis = analyzeSource(source, path);
      analyses.push(analysis);
      const changedFile = scope.files.find((file) => file.path === path);
      const mapping = mapChangedRangesToCallables(analysis, changedFile);
      const evidence = buildEvidence(source, analysis);
      touched.push({ path, evidence, ...mapping });
      candidates.push(...buildCandidates(path, { wholeCurrentFile: changedFile?.wholeCurrentFile, touched: mapping.touchedCallables }, evidence));
    } catch {
      limitations.push(`source could not be read: ${path}`);
    }
  }
  const deletedPaths = scope.files.filter((file) => file.deleted).map((file) => file.path);
  const nonSourcePaths = scope.files
    .filter((file) => !SOURCE_EXTENSIONS.has(extname(file.path).toLowerCase()) && file.status !== "D")
    .map((file) => file.path);
  const inventory = inventoryMatches(repository, purpose, analyses);
  if (inventory.limitation) limitations.push(inventory.limitation);
  const totalTouched = touched.reduce((sum, item) => sum + item.touchedCallables.length, 0);
  const reviewFeedback = buildReviewFeedback(candidates);
  const result = {
    schema: CODE_PHAGE_SCHEMA,
    status: "advisory-review",
    phase,
    advisoryOnly: true,
    authorityCreated: false,
    mutated: false,
    repository,
    goal: purpose,
    changedScope: {
      ref,
      status: scope.status,
      changedFiles: scope.files.length,
      analyzedFiles: analyses.length,
      deletedPaths,
      nonSourcePaths,
      touchedCallables: totalTouched,
    },
    priorArt: {
      status: inventory.status,
      matches: inventory.matches,
      distinctiveTerms: inventory.distinctiveTerms,
      absenceClaimed: false,
      creditRequired: inventory.matches.length > 0,
    },
    budget: {
      basis: "code-phage.v1",
      candidateFiles: candidatePaths,
      fileCount: analyses.length,
      observedCognitiveComplexity: analyses.reduce((sum, item) => sum + (Number(item.totalCognitiveComplexity) || 0), 0),
      observedCyclomaticComplexity: analyses.reduce((sum, item) => sum + (Number(item.totalCyclomaticComplexity) || 0), 0),
      suggestedWriteSet: candidatePaths,
      deletionTest: "Which accepted semantic requirement or failure-mode check would fail if this unit were removed?",
      thresholdsAreAdvisory: true,
    },
    files: analyses,
    changedCallables: touched,
    candidates,
    candidateOutcomeVocabulary: ["RETAIN", "TIDY", "HOLD", "PROFILE", "DESCRIBE"],
    reviewFeedback,
    reviewIntentVocabulary: REVIEW_INTENT_VOCABULARY,
    summary: {
      filesAnalyzed: analyses.length,
      touchedCallables: totalTouched,
      deletedFiles: deletedPaths.length,
      maxCognitiveComplexity: analyses.reduce((value, item) => Math.max(value, Number(item.cognitiveComplexity) || 0), 0),
      candidateCount: candidates.length,
      candidateOutcomes: candidates.reduce((counts, item) => {
        counts[item.suggestedOutcome] = (counts[item.suggestedOutcome] || 0) + 1;
        return counts;
      }, {}),
      reviewFeedback: reviewFeedback.reduce(
        (counts, item) => {
          counts[item.intent] = (counts[item.intent] || 0) + 1;
          return counts;
        },
        { AMEND: 0, CONSULT: 0 },
      ),
    },
    limitations,
    nextAction: "Review touched callables within changed ranges only; no source mutation is performed.",
  };
  // Narrative is derived from the near-final result so every reference
  // resolves against the completed review-feedback and candidate sets.
  result.narrative = buildNarrative(result, "walkthrough");
  return result;
}
