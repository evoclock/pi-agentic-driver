// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Attended-authority destructive-command guard for Pi.
//
// Ported observable behavior (private reference: scripts/enforcement/
// pi_attended_authority.js + cc_destructive_command_guard_hook.py):
// - Intercept tool calls before execution via the `tool_call` event.
// - Destructive shell/Git operations require native confirmation.
// - Safe reads/builds/tests pass through untouched.
// - An explicit denial returns a clear reason and the session continues;
//   no hidden retry and no automatic re-ask.
// - Headless / no-confirmation contexts refuse destructive operations
//   fail-closed.
// - No bypasses, no model-supplied authority, no silent escalation. The
//   model cannot mark a call safe; classification is structural only.

import { isNativeTuiContext } from "./native_tui_context.js";

export const GUARD_SCHEMA = "pi-agentic-driver.attended-authority.v1";

// Tool names that can mutate the workspace.
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

// Read-only / build / test commands that always pass through.
const SAFE_COMMAND_PREFIXES = [
  "cat", "ls", "head", "tail", "grep", "rg", "find", "sed -n", "awk",
  "wc", "file", "stat", "which", "echo", "pwd", "date", "env",
  "node --check", "node --test", "npm test", "npm run",
  "python3 -m pytest", "pytest", "make", "cmake",
  "git status", "git log", "git diff", "git show", "git branch",
  "git remote", "git rev-parse", "git blame", "git describe",
  "git config --get", "git ls-files",
];

// Arbitrary-code interpreter execution: any code payload can perform a
// destructive operation, so these forms are classified fail-closed.
const DESTRUCTIVE_SHELL_PATTERNS = [
  { pattern: /\brm\b[^|;&]*\s(-[a-z]*[rf][a-z]*\s|--recursive|--force)/, kind: "recursive or forced file deletion" },
  { pattern: /\bsudo\s+rm\b/, kind: "privileged file deletion" },
  { pattern: /\brmdir\b|\bunlink\b/, kind: "file or directory deletion" },
  { pattern: /\bmkfs\b|\bshred\b|\bdd\b\s+if=/, kind: "irreversible disk or file operation" },
  { pattern: /\btruncate\s+-s\s*0\b/, kind: "file truncation" },
  { pattern: /\bkill\b\s+-9\b|\bpkill\b/, kind: "forced process termination" },
  { pattern: /\bchmod\s+-R\b|\bchown\s+-R\b/, kind: "recursive permission change" },
  { pattern: /\bnode\s+(-e|--eval)\b/, kind: "arbitrary JavaScript execution via node -e" },
  { pattern: /\bpython3?\s+-c\b/, kind: "arbitrary Python execution via python -c" },
  { pattern: /\bnpx\b/, kind: "arbitrary package execution via npx" },
];

// Destructive Git operations.
const DESTRUCTIVE_GIT_PATTERNS = [
  { pattern: /\bgit\s+push\b[^|;&]*(--force|-f\b)/, kind: "forced Git push" },
  { pattern: /\bgit\s+push\b/, kind: "Git push" },
  { pattern: /\bgit\s+reset\s+--hard\b/, kind: "hard Git reset" },
  { pattern: /\bgit\s+reset\b/, kind: "Git reset" },
  { pattern: /\bgit\s+clean\b/, kind: "Git clean" },
  { pattern: /\bgit\s+checkout\s+--\s/, kind: "Git working-tree discard" },
  { pattern: /\bgit\s+restore\b/, kind: "Git working-tree discard" },
  { pattern: /\bgit\s+stash\s+(drop|clear|pop)\b/, kind: "Git stash mutation" },
  { pattern: /\bgit\s+stash\b/, kind: "Git stash mutation" },
  { pattern: /\bgit\s+rebase\b/, kind: "Git history rewrite" },
  { pattern: /\bgit\s+filter-(branch|repo)\b/, kind: "Git history rewrite" },
  { pattern: /\bgit\s+commit\b[^|;&]*--amend\b/, kind: "Git history rewrite" },
  { pattern: /\bgit\s+branch\s+(-D|-d)\b/, kind: "protected branch deletion" },
  { pattern: /\bgit\s+tag\s+-d\b/, kind: "protected tag deletion" },
  { pattern: /\bgit\s+cherry-pick\b|\bgit\s+revert\b/, kind: "Git history mutation" },
];

// Paths whose deletion or overwrite is always treated as destructive.
const PROTECTED_PATHS = [
  ".env", ".ssh", ".gnupg", "node_modules", ".git",
  "package-lock.json", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
];

// Quote-aware tokenization: strips shell quoting so `rm '-rf'` or
// `git "push"` still expose their destructive tokens to the patterns.
function unquoteTokens(text) {
  return String(text ?? "")
    .split(/[\s\n]+/)
    .map((token) => {
      if (token.length >= 2) {
        const first = token[0];
        const last = token[token.length - 1];
        if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
          return token.slice(1, -1);
        }
      }
      return token;
    })
    .join(" ");
}

export function classifyBashCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) return { destructive: false };
  // A safe prefix wins only when the whole command is that single simple
  // command (no chaining, redirection, or command substitution), so a
  // destructive payload cannot hide behind a safe-looking prefix.
  const compound = /[;&|>`]|\$\(|\n/.test(text);
  const redirection = /(^|\s)(>{1,2}|<)/.test(text);
  // Structural destructive verdicts win over safe-looking prefixes, so a
  // destructive form such as `git branch -D` cannot hide behind a safe
  // prefix such as `git branch`.
  for (const { pattern, kind } of DESTRUCTIVE_SHELL_PATTERNS) {
    if (pattern.test(text) || pattern.test(unquoteTokens(text))) return { destructive: true, kind };
  }
  for (const { pattern, kind } of DESTRUCTIVE_GIT_PATTERNS) {
    if (pattern.test(text) || pattern.test(unquoteTokens(text))) return { destructive: true, kind };
  }
  if (!compound && !redirection) {
    for (const prefix of SAFE_COMMAND_PREFIXES) {
      if (text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\t`)) {
        return { destructive: false };
      }
    }
  }
  // Output redirection overwrites an existing file in place.
  const redirect = text.match(/(?:^|\s)>{1,2}\s*([^\s;&|]+)\s*$/);
  if (redirect) {
    const target = redirect[1].replace(/^["']|["']$/g, "");
    return {
      destructive: true,
      kind: `file overwrite via redirection to ${target}`,
    };
  }
  // Unrecognized non-safe commands are not destructive by default; the
  // guard only intercepts structurally destructive operations.
  return { destructive: false };
}

function touchesProtectedPath(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  return PROTECTED_PATHS.some((entry) =>
    normalized === entry
    || normalized.endsWith(`/${entry}`)
    || normalized.includes(`/${entry}/`)
    || normalized.startsWith(`./${entry}`),
  );
}

// Existing-file overwrite detection is injected so tests stay filesystem-free.
export function classifyWriteCall(toolName, input, existsSync) {
  if (toolName !== "write" && toolName !== "edit") {
    return { destructive: false };
  }
  const path = input?.path ?? input?.file_path ?? "";
  if (touchesProtectedPath(path)) {
    return { destructive: true, kind: `protected path write to ${path}` };
  }
  if (toolName === "write" && typeof existsSync === "function" && path && existsSync(path)) {
    return { destructive: true, kind: `overwrite of existing file ${path}` };
  }
  return { destructive: false };
}

export function confirmationBody(toolName, input, kind) {
  return [
    `Attended-authority guard: ${kind}.`,
    `Tool: ${toolName}`,
    toolName === "bash" ? `Command: ${input?.command}` : `Path: ${input?.path ?? input?.file_path ?? ""}`,
    "",
    "Allow this destructive operation?",
  ].join("\n");
}

export function denialReason(toolName, kind, context) {
  if (!isNativeTuiContext(context)) {
    return `${GUARD_SCHEMA}: destructive ${toolName} operation (${kind}) refused fail-closed: no native confirmation surface in this headless context`;
  }
  return `${GUARD_SCHEMA}: destructive ${toolName} operation (${kind}) denied by user; the session continues and this call is not retried`;
}

/**
 * Core guard for one tool call. Returns undefined to allow the call, or
 * `{ block: true, reason }` to refuse it. Confirmation is native-only:
 * `ctx.ui.confirm` in an interactive TUI. Headless contexts never confirm.
 * Model-supplied fields on the event can never grant authority.
 */
export async function guardToolCall(event, ctx, options = {}) {
  const toolName = String(event?.toolName ?? "").toLowerCase();
  if (!MUTATING_TOOLS.has(toolName)) return undefined;
  const input = event?.input && typeof event.input === "object" ? event.input : {};

  const bash = toolName === "bash"
    ? classifyBashCommand(input.command)
    : { destructive: false };
  const write = toolName === "bash"
    ? { destructive: false }
    : classifyWriteCall(toolName, input, options.existsSync);
  const verdict = bash.destructive ? bash : write;
  if (!verdict.destructive) return undefined;

  const context = options.context ?? ctx;
  if (!isNativeTuiContext(context)) {
    return { block: true, reason: denialReason(toolName, verdict.kind, context) };
  }
  const confirmed = await context.ui.confirm(
    "Destructive operation",
    confirmationBody(toolName, input, verdict.kind),
  );
  if (confirmed === true) return undefined;
  return { block: true, reason: denialReason(toolName, verdict.kind, context) };
}

/**
 * Register the guard on a Pi host instance. Duplicate registration on the
 * same instance is ignored.
 */
const REGISTERED = new WeakSet();

export function registerAttendedAuthorityGuard(pi, options = {}) {
  if (!pi || REGISTERED.has(pi)) return undefined;
  REGISTERED.add(pi);
  pi.on?.("tool_call", (event, ctx) => guardToolCall(event, ctx, options));
  return { registered: true, schema: GUARD_SCHEMA };
}

export default guardToolCall;
