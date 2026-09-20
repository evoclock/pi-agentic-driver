// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Keychain key handling (§5, M10).
//
// Each provider's key is read from the macOS Keychain at runtime via
// `security find-generic-password -a <account> -s <service> -w` with guarded
// capture:
//   - stdout is captured in-memory only; the value is never echoed, never
//     logged, never included in errors, and never passed to subprocesses.
//   - stderr is captured ONLY to distinguish exit codes; it never enters
//     public errors or the audit log (review fix #5).
//   - the secret lives in a Buffer, not a JS string, for as long as possible.
//
// Memory honesty (review fix #6): JS strings are immutable and copied by
// engines in uncontrolled ways (GC movement, substring sharing, JSON
// encoding). Zeroing `chunks.length = 0` drops references so GC can reclaim
// the memory, but janus does NOT claim guaranteed erasure of every
// intermediate copy. The claims are: no disk persistence, no logging, no
// subprocess/env forwarding, and reference release as early as possible.
//
// The bashrc env var remains for interactive shells; janus does not rely on
// inherited env — it reads the Keychain directly.

import { spawn } from "node:child_process";
import type { KeychainRef } from "./config.js";

export type KeyResolution =
  | { status: "resolved"; key: string }
  | { status: "missing"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Public, fixed reason strings. They never embed stderr text, OS messages,
 * or any value fragment (review fix #5).
 */
export const KEYCHAIN_PUBLIC_REASONS = {
  notFound: (ref: KeychainRef) =>
    `Keychain item not found. Provision it with: security add-generic-password -U -a ${ref.account} -s ${ref.service} -w`,
  denied: "Keychain access denied or cancelled by the user",
  failed: "Keychain read failed; see local janus diagnostics",
} as const;

/**
 * Read a provider key from the Keychain. `security` output is piped directly
 * into memory; neither the command line nor any log ever sees the value.
 * The account and service names are argv elements, not shell strings.
 */
export function readGatewayKey(ref: KeychainRef): Promise<KeyResolution> {
  return new Promise((resolvePromise) => {
    // -w prints the password on stdout. argv is fixed (no shell
    // interpolation); the secret is NEVER a command-line argument — the
    // provisioning flow uses `-w` with the interactive prompt instead.
    const child = spawn(
      "/usr/bin/security",
      ["find-generic-password", "-a", ref.account, "-s", ref.service, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const settle = (resolution: KeyResolution) => {
      if (settled) return;
      settled = true;
      // Drop references promptly so GC can reclaim the secret buffers.
      // (Honesty note: this is reference release, not guaranteed erasure —
      // see the module header.)
      chunks.length = 0;
      errChunks.length = 0;
      resolvePromise(resolution);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
    });
    child.on("error", () => {
      // The OS error message (e.g. spawn failure details) is sanitized away.
      settle({ status: "failed", reason: KEYCHAIN_PUBLIC_REASONS.failed });
    });
    child.on("close", (code) => {
      const key = Buffer.concat(chunks).toString("utf8").replace(/\n+$/, "");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code === 0 && key.length > 0) {
        settle({ status: "resolved", key });
        return;
      }
      if (code === 44) {
        // 44 = item not found in the keychain. Public hint only.
        settle({ status: "missing", reason: KEYCHAIN_PUBLIC_REASONS.notFound(ref) });
        return;
      }
      if (code === 45 || code === 51 || /user.*denied|cancel/i.test(stderr)) {
        settle({ status: "missing", reason: KEYCHAIN_PUBLIC_REASONS.denied });
        return;
      }
      // stderr content is inspected for the exit-code class only and is
      // never included in the public reason.
      settle({ status: "failed", reason: KEYCHAIN_PUBLIC_REASONS.failed });
    });
  });
}

/**
 * Readiness state for a provider key. Resolves only when the key exists and
 * is readable; never exposes the value.
 */
export async function keyReadiness(ref: KeychainRef): Promise<{
  ready: boolean;
  reason?: string;
}> {
  const resolution = await readGatewayKey(ref);
  if (resolution.status === "resolved") return { ready: true };
  return { ready: false, reason: resolution.reason };
}
