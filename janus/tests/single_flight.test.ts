// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests: single-flight per evalInputDigest (M9) and the global
// concurrency cap with busy rejection.

import test from "node:test";
import assert from "node:assert/strict";
import { SingleFlight } from "../janus/single_flight.js";
import { JanusError } from "../janus/errors.js";

test("identical digests coalesce onto one task", async () => {
  const sf = new SingleFlight(4);
  let runs = 0;
  const task = () =>
    sf.run("digest-a", async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 50));
      return "result";
    });

  const [a, b, c] = await Promise.all([task(), task(), task()]);
  assert.equal(runs, 1);
  assert.equal(a, "result");
  assert.equal(b, "result");
  assert.equal(c, "result");
});

test("distinct digests run as separate tasks", async () => {
  const sf = new SingleFlight(4);
  let runs = 0;
  const make = (digest: string) =>
    sf.run(digest, async () => {
      runs += 1;
      return digest;
    });
  await Promise.all([make("d1"), make("d2"), make("d3")]);
  assert.equal(runs, 3);
});

test("global cap rejects distinct digests with busy", async () => {
  const sf = new SingleFlight(2);
  const release: (() => void)[] = [];
  const make = (digest: string) =>
    sf.run(digest, () => new Promise<string>((resolvePromise) => release.push(() => resolvePromise(digest))));

  void make("d1");
  void make("d2");
  assert.throws(() => make("d3"), (error: unknown) => {
    return error instanceof JanusError && error.code === "busy";
  });
  for (const r of release) r();
});

test("digests are released after completion", async () => {
  const sf = new SingleFlight(1);
  await sf.run("d1", async () => "x");
  // Cap of 1 must allow the next request after the first completes.
  assert.equal(await sf.run("d2", async () => "y"), "y");
  assert.equal(await sf.run("d1", async () => "z"), "z");
});

test("failed flights release their digest", async () => {
  const sf = new SingleFlight(1);
  await assert.rejects(
    sf.run("d1", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await sf.run("d1", async () => "recovered"), "recovered");
});

test("coalesced waiters share a failed flight's rejection", async () => {
  const sf = new SingleFlight(4);
  const task = () =>
    sf.run("digest-fail", async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error("gateway down");
    });
  const results = await Promise.allSettled([task(), task()]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
});
