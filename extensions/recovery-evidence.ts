// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Thin extension wrapper for the owner-only recovery-evidence review command.
// Deliberately registers no model-callable tool: the full evidence surface is
// the interactive native TUI overlay only. The registration is async (the
// trusted root is resolved and snapshotted); Pi awaits an asynchronous
// default factory before startup continues (extensions.md), so no return
// value or extra await is needed here.
import { registerRecoveryEvidenceReview } from "../scripts/enforcement/recovery_evidence_review_pi.js";

export default async function registerRecoveryEvidenceReviewExtension(pi: any) {
  await registerRecoveryEvidenceReview(pi);
}
