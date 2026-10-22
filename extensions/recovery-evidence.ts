// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Thin extension wrapper for owner-only full-evidence review and a bounded,
// metadata-only summary tool. Full evidence remains in the native TUI overlay;
// the model never receives entries, identifiers or retrieval references. The registration is async (the
// trusted root is resolved and snapshotted); Pi awaits an asynchronous
// default factory before startup continues (extensions.md), so no return
// value or extra await is needed here.
import { registerRecoveryEvidenceReview } from "../scripts/enforcement/recovery_evidence_review_pi.js";

export default async function registerRecoveryEvidenceReviewExtension(pi: any) {
  await registerRecoveryEvidenceReview(pi);
}
