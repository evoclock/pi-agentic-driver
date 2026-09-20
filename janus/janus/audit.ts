// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Audit log (§5, M9 + round-2 retention rule): append-only local log of
// request id, timestamps, question NAMES (non-sensitive identifiers, never
// question text or state contents), verdict probabilities, and token usage.
// 90-day default retention (config-adjustable), size-capped with
// oldest-first rotation.
//
// Retention (review fix #7): enforced for the ACTIVE file as well as rotated
// files. On start, after each rotation, and on a periodic sweep, records
// older than the retention window are purged from the active file by
// rewriting it without them, and rotated files older than the window are
// deleted. Records older than retention never survive indefinitely.

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  requestId: string;
  timestamp: string;
  event: "evaluate" | "evaluate_result" | "evaluate_error";
  /** Non-sensitive question identifiers — never question text. */
  questionNames: string[];
  verdictProbabilities?: Record<string, number>;
  tokenUsage?: { inputTokens?: number | undefined; outputTokens?: number | undefined; totalTokens?: number | undefined };
  errorCode?: string;
  durationMs?: number;
  coalesced?: boolean;
  /** How many provider attempts this request consumed (1 = no failover). */
  providerAttempts?: number;
  /** Provider id that produced the result (or last attempted). */
  provider?: string;
}

const MAX_ROTATED_FILES = 5;
/** How often the active-file retention sweep runs while the log is open. */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function entryTimestampMs(line: string): number | undefined {
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    if (typeof parsed.timestamp !== "string") return undefined;
    const ms = Date.parse(parsed.timestamp);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

export class AuditLog {
  private fd: number | null = null;
  private readonly activePath: string;
  private lastSweepAt = 0;

  constructor(
    private readonly basePath: string,
    private readonly maxBytes: number,
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.activePath = basePath === "stdout" ? "stdout" : `${basePath}.jsonl`;
  }

  /** Open (or reopen) the log and apply retention. Call once at startup. */
  start(): void {
    if (this.activePath === "stdout") return;
    mkdirSync(dirname(this.activePath), { recursive: true });
    this.applyRetention();
    this.openFd();
  }

  stop(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private openFd(): void {
    this.fd = openSync(this.activePath, "a");
  }

  /**
   * Purge records older than the retention window from the ACTIVE file by
   * rewriting it without them. Rotated-file deletion is handled separately
   * by mtime in applyRetention(). This guarantees active-file records do not
   * survive past retention (review fix #7).
   */
  private sweepActiveFile(): void {
    if (this.activePath === "stdout") return;
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;

    let size = 0;
    try {
      size = statSync(this.activePath).size;
    } catch {
      return;
    }
    if (size === 0) return;

    // Read the whole active file (bounded by maxBytes + slack), filter, and
    // rewrite in place if anything expired.
    let raw: string;
    const fd = openSync(this.activePath, "r");
    try {
      const buffer = Buffer.alloc(size);
      const read = readSync(fd, buffer, 0, size, 0);
      raw = buffer.toString("utf8", 0, read);
    } finally {
      closeSync(fd);
    }

    const lines = raw.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      const ts = entryTimestampMs(line);
      if (ts === undefined || ts >= cutoff) kept.push(line);
    }
    if (kept.length === lines.filter((l) => l.length > 0).length) return; // nothing expired

    const replacement = `${kept.join("\n")}\n`;
    // Rewrite via a temp file + rename for atomicity, then reopen for append.
    const tempPath = `${this.activePath}.sweep`;
    const tempFd = openSync(tempPath, "w");
    try {
      writeSync(tempFd, replacement);
    } finally {
      closeSync(tempFd);
    }
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    renameSync(tempPath, this.activePath);
    this.openFd();
  }

  private applyRetention(): void {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (let i = 1; i <= MAX_ROTATED_FILES; i += 1) {
      const rotated = `${this.activePath}.${i}`;
      if (!existsSync(rotated)) continue;
      try {
        if (statSync(rotated).mtimeMs < cutoff) unlinkSync(rotated);
      } catch {
        // A missing file mid-scan is fine; retention is best-effort.
      }
    }
    this.sweepActiveFile();
    this.lastSweepAt = this.now().getTime();
  }

  private rotateIfNeeded(): void {
    if (this.activePath === "stdout" || this.fd === null) return;
    let size = 0;
    try {
      size = fstatSync(this.fd).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;

    // Oldest-first rotation: .4→.5, .3→.4, … .1→.2, active→.1.
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i -= 1) {
      const from = `${this.activePath}.${i}`;
      const to = `${this.activePath}.${i + 1}`;
      if (existsSync(from)) {
        try {
          unlinkSync(to);
        } catch {
          /* first shift may have no target */
        }
        renameSync(from, to);
      }
    }
    closeSync(this.fd);
    this.fd = null;
    renameSync(this.activePath, `${this.activePath}.1`);
    this.applyRetention();
    this.openFd();
  }

  append(entry: AuditEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    if (this.activePath === "stdout") {
      process.stdout.write(line);
      return;
    }
    if (this.fd === null) this.openFd();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    writeSync(this.fd!, line);
    this.rotateIfNeeded();
    // Periodic active-file retention sweep (review fix #7).
    const nowMs = this.now().getTime();
    if (nowMs - this.lastSweepAt >= RETENTION_SWEEP_INTERVAL_MS) {
      this.sweepActiveFile();
      this.lastSweepAt = nowMs;
    }
  }
}
