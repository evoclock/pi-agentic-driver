// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Daily cost breaker (§5, M10): a daily token/cost ceiling in config; on
// exceed, /evaluate returns busy with budget_exhausted detail until the
// window resets. Windows are UTC calendar days (the audit log uses the same
// day key). Usage arrives from the SDK result after each evaluation; the
// breaker is updated by the evaluate path.

import { busyError } from "./errors.js";

export interface UsageRecord {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  costUsd?: number | undefined;
}

export interface BudgetStatus {
  dayKey: string;
  tokensUsed: number;
  costUsdUsed: number;
  tokenCeiling: number;
  costCeilingUsd: number;
  exhausted: boolean;
}

export class DailyBudget {
  private dayKey = "";
  private tokensUsed = 0;
  private costUsdUsed = 0;

  constructor(
    private readonly tokenCeiling: number,
    private readonly costCeilingUsd: number,
    private readonly costPerMtokenUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static dayKeyFor(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private rollIfNeeded(): void {
    const key = DailyBudget.dayKeyFor(this.now());
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.tokensUsed = 0;
      this.costUsdUsed = 0;
    }
  }

  /**
   * Record usage after an evaluation completes (success or failure after the
   * gateway accepted the call — retries consume budget too).
   */
  record(usage: UsageRecord): void {
    this.rollIfNeeded();
    const total =
      usage.totalTokens ??
      (usage.inputTokens !== undefined || usage.outputTokens !== undefined
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : 0);
    this.tokensUsed += total;
    this.costUsdUsed +=
      usage.costUsd ?? (total / 1_000_000) * this.costPerMtokenUsd;
  }

  /** Check before dispatch. Throws busy/budget_exhausted when over either ceiling. */
  assertWithinBudget(): void {
    this.rollIfNeeded();
    if (this.tokenCeiling > 0 && this.tokensUsed >= this.tokenCeiling) {
      throw busyError(
        `daily token ceiling of ${this.tokenCeiling} reached; resets at 00:00 UTC`,
        { budget_exhausted: { kind: "tokens", dayKey: this.dayKey, used: this.tokensUsed } },
      );
    }
    if (this.costCeilingUsd > 0 && this.costUsdUsed >= this.costCeilingUsd) {
      throw busyError(
        `daily cost ceiling of $${this.costCeilingUsd} reached; resets at 00:00 UTC`,
        {
          budget_exhausted: {
            kind: "cost",
            dayKey: this.dayKey,
            usedUsd: Number(this.costUsdUsed.toFixed(4)),
          },
        },
      );
    }
  }

  status(): BudgetStatus {
    this.rollIfNeeded();
    return {
      dayKey: this.dayKey,
      tokensUsed: this.tokensUsed,
      costUsdUsed: Number(this.costUsdUsed.toFixed(4)),
      tokenCeiling: this.tokenCeiling,
      costCeilingUsd: this.costCeilingUsd,
      exhausted:
        (this.tokenCeiling > 0 && this.tokensUsed >= this.tokenCeiling) ||
        (this.costCeilingUsd > 0 && this.costUsdUsed >= this.costCeilingUsd),
    };
  }
}
