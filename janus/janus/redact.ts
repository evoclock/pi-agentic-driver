// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Secrets/PII redaction pass (§7, M10): a general redaction pass runs in
// janus over the whole state before ANY external call. There is no disable
// knob — redaction is unconditional (review fix #4). The audit log never
// contains state contents; this pass is defense-in-depth for what reaches a
// provider.

const REDACTED = "[REDACTED]";

interface PatternRule {
  name: string;
  pattern: RegExp;
}

/**
 * Ordered redaction rules. Each rule targets a recognizable secret or PII
 * shape. Keys/variable names are preserved (context survives redaction);
 * values are replaced with [REDACTED].
 */
const STRING_RULES: PatternRule[] = [
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-pat", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  {
    name: "bearer-authorization",
    pattern: /\b(Authorization|Proxy-Authorization)\s*[:=]\s*"?Bearer\s+[A-Za-z0-9._~+/=-]+"?/gi,
  },
  {
    name: "assigned-secret",
    pattern:
      /\b(api[_-]?key|api[_-]?secret|secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential[s]?|auth[_-]?token)\b\s*[:=]\s*("[^"\n]{4,}"|'[^'\n]{4,}'|[A-Za-z0-9._~+/=-]{8,})/gi,
  },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    name: "credit-card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
  },
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
];

/** Redact a single string. Key/variable names are preserved; values are dropped. */
export function redactString(text: string): string {
  let result = text;
  for (const rule of STRING_RULES) {
    result = result.replace(rule.pattern, (match, ...groups) => {
      // bearer-authorization and assigned-secret rules keep the key/header
      // name (context survives redaction) and redact only the value.
      if (rule.name === "bearer-authorization" && typeof groups[0] === "string") {
        return `${groups[0]}: [REDACTED]`;
      }
      if (rule.name === "assigned-secret" && typeof groups[0] === "string") {
        const separator = groups[1] === "=" ? "=" : ": ";
        return `${groups[0]}${separator}[REDACTED]`;
      }
      // Keep benign structural matches readable: card numbers keep spacing
      // shape but no digits; emails are fully redacted.
      if (rule.name === "credit-card") {
        const digits = match.replace(/\D/g, "");
        if (digits.length < 13 || digits.length > 19) return match;
        if (digits === "0".repeat(digits.length)) return match; // all-zero placeholder
        return match.replace(/\d/g, "•");
      }
      return REDACTED;
    });
  }
  return result;
}

/**
 * Structural keys whose entire value is dropped regardless of the value's
 * type or nesting depth (review fix #4): string, number, boolean, object,
 * array — anything under a sensitive key is replaced with [REDACTED].
 */
const SENSITIVE_KEYS =
  /^(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|credential[s]?)$/i;

/** Recursively redact any JSON value; arrays and objects are traversed. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(key)) {
        // Unconditional: the whole value is dropped whatever its shape —
        // nested objects, arrays, numbers, booleans, null all become
        // [REDACTED]. There is no path where a sensitive-key value survives.
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(val);
      }
    }
    return out;
  }
  return value;
}
