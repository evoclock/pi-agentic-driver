---
name: benchmark-checklist-pi
description: "Vet an approved performance result before reporting or acting on it: limiter, tuning, physical limits, errors, variation, user relevance and proof that measured work happened. Use explicitly for a measured speedup or regression."
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Benchmark checklist for Pi

Adapted from Lauren Tan's pstack `benchmark-checklist` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). These questions are a judgment method, not permission to run a benchmark, profiler, server, script or host telemetry. Load and data effects remain inside the approved task; avoid touching GPU/CUDA or another user's running workload. Do not put an unreviewed number in public copy.

## Frame before measurement

Write the exact proposed claim with unit, percentile or aggregation, dataset and configuration. Read the actual harness; identify what it times, counts and omits. If the task permits host observation, check current load and core capacity with tools available **on that host**; do not assume `nproc` or Linux `pidstat`/`strace` exists on macOS. If noisy, interleave compared sides when authorized and disclose interference rather than stopping unrelated processes. Verify that each side uses comparable real production-like flags, versions, data, transactions, pools and cache state.

For a **quick ballpark explicitly requested by the user**, one approved run may be reported as one run after checks 4 and 7 below; skip the other questions unless the result looks wrong. Never use a one-run ballpark to select a winning implementation. A comparative decision or claimed improvement needs the full checklist.

## Seven evidence questions

1. **Why not double?** Name the observed limiter. Inspect CPU/I/O/memory and the load generator using authorized platform-appropriate telemetry. Profile in a separate run, not the reported timed run, and trace the hot spot to source. An unmoved metric needs an explained limiter before calling a change useless.
2. **Was it tuned?** Compare production-relevant build/configuration and equivalent warmup. Fix an untuned setting and rerun before choosing; if tuning cannot be done, verdict is inconclusive, not a narrower claim that one implementation wins.
3. **Did it break limits?** Check dimensional arithmetic against disk/network bandwidth, CPU cost and fraction of total time spent in the changed component. An impossible improvement suggests no-op, cache, missing work or a bug; investigate before reporting.
4. **Did it error?** Count errors, timeouts and retries on every side and verify actual output correctness, not only presence. A harness that omits errors cannot support a speed verdict.
5. **Does it reproduce?** For a comparative claim, alternate sides for at least five approved runs each; report median and range. If the gap is inside run-to-run spread, say no measurable difference. Use a suitable rank-sum/harness statistical check for a close call, with its assumptions disclosed.
6. **Does it matter?** Measure the user-facing end-to-end path on realistic data/concurrency beside a micro result. Give the micro work's share of total latency; do not equate helper speed with product speed.
7. **Did it happen?** Prove the timed work reached its target and produced consumed output: awaited promises, iterated generators, persisted rows, actual response bytes and no timeout shortcut. A fast result for skipped work is invalid.

## Verdict and evidence

Lead with faster, slower, no measurable difference or **inconclusive**. Report unit, number of runs, median/range, configuration and observed limiter with bounded private evidence. A missing limiter for a claimed difference, an untuned side, or unchecked questions 4 or 7 makes it inconclusive. If an approved performance investigation later freezes its harness, keep error and completed-work counts in each subsequent keep/revert check. External PR/public text remains owner-approved; an internal result is not publication approval. Do not infer installation or launch from this checklist.

- **Positive BDD:** Given authorized comparable benchmark runs and evidence from the real timed work, when Pi applies all seven questions, then a defensible verdict reports errors, limiter, unit, spread and user relevance, or honestly states no measurable difference.
- **Refusal BDD:** Given no grant to run the workload or missing error/work confirmation, when asked to certify a speedup, then return `blocked` for measurement or `inconclusive` for the claim; do not run unapproved profiling, silently tune a side, publish a number or present a one-run ballpark as a winner.

This document does not itself measure anything. Record what actually ran and which questions remain unrun.
