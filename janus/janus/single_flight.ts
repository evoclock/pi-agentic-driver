// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Single-flight and concurrency (§5, M9).
//
// One in-flight evaluation per evalInputDigest: identical requests coalesce
// and share the same eventual result. A global cap (default 4) on DISTINCT
// in-flight evaluations rejects new distinct requests with `busy`.
//
// Coalescing accounting (review fix #11): the number of coalesced waiters is
// observable per digest (waitersFor) and reported to the flight owner's
// onSettle callback, so the audit log can mark coalescing accurately — the
// provider call and its usage are charged exactly once regardless of how
// many callers shared the flight.

import { busyError } from "./errors.js";

interface Flight<T> {
  promise: Promise<T>;
  waiters: number;
}

export class SingleFlight {
  private readonly flights = new Map<string, Flight<unknown>>();
  private inFlight = 0;

  constructor(private readonly maxConcurrent: number) {}

  get size(): number {
    return this.inFlight;
  }

  /**
   * How many callers are currently coalesced onto `digest` (0 = none; the
   * flight owner is not counted as a waiter).
   */
  waitersFor(digest: string): number {
    return this.flights.get(digest)?.waiters ?? 0;
  }

  /**
   * Run `task` keyed by `digest`. Identical concurrent digests coalesce onto
   * one task. Distinct digests beyond the concurrency cap reject with busy.
   * `onSettle` (optional) fires exactly once when the flight settles, with
   * the number of coalesced waiters that joined — used to mark coalescing
   * accurately in the audit log (review fix #11).
   */
  run<T>(
    digest: string,
    task: () => Promise<T>,
    onSettle?: (info: { waiters: number }) => void,
  ): Promise<T> {
    const existing = this.flights.get(digest) as Flight<T> | undefined;
    if (existing) {
      existing.waiters += 1;
      return existing.promise;
    }

    if (this.inFlight >= this.maxConcurrent) {
      throw busyError(
        `global concurrency cap of ${this.maxConcurrent} reached; retry later`,
      );
    }

    this.inFlight += 1;
    let settledWaiters = 0;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.inFlight -= 1;
      this.flights.delete(digest);
      onSettle?.({ waiters: settledWaiters });
    };

    const promise: Promise<T> = (async () => {
      try {
        return await task();
      } finally {
        settle();
      }
    })();

    // Proxy so late waiters still bump the count seen at settle time.
    const flight: Flight<T> = {
      get promise() {
        return promise;
      },
      get waiters() {
        return settledWaiters;
      },
      set waiters(value: number) {
        settledWaiters = value;
      },
    };
    this.flights.set(digest, flight as Flight<unknown>);
    return promise;
  }
}
