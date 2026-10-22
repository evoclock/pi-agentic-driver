---
name: principle-explain-the-number-pi
description: Challenge a measured speedup, regression, throughput, latency or eval score before trusting or reporting it. Use explicitly when a number drives an approved decision.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Explain the number

Adapted from Lauren Tan's `principle-explain-the-number` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. A proposed measurement is not authority to launch a benchmark, profile a host, change settings, consume private trial data or publish a claim. `principle-prove-it-works` checks whether an output is real; this principle asks **why the measured magnitude is plausible**.

Before using a number, state the claim, unit, measured work, configuration, comparison, run count and spread. Ask **why not double?** Name the limiting resource or code path using an authorized profile or system counters **observed during a run**, then map the bottleneck to source. Include the load generator: if it saturates first, the tested service is not the demonstrated limiter. A guess based on reading code is not measured limiter evidence. If no authorized measurement exists, label the claimed difference **inconclusive** and the observation `unrun`, rather than inventing a ceiling.

List plausible alternative explanations and rule each out with evidence: errors or timeouts; skipped, lazy or cached work; the target code never executing or its output never consumed; one side left at default settings; noisy trials; or a component too small to affect the user-visible total. Compare the time saved with the changed piece's former share of the full path. A saving larger than that piece took is a measurement problem to investigate, not a speedup to celebrate. Keep the run count, range/spread, observed limiter, units, error/work counts and private evidence pointer beside the number. Do not silently drop failed trials.

For a **performance** claim, use the full reviewed `benchmark-checklist-pi` only when actually loaded; otherwise check its seven source questions directly before a comparison or mark the unanswered questions `unrun`. A single authorized run may be called a **one-run ballpark** only when the user explicitly asks for one and both error and completed-work checks pass; it cannot choose a winner. For an **eval** claim, establish that every trial actually did the task, check whether the gap holds across trials and across **only approved** model routes when a cross-model comparison is in scope, and explain why the scenario matters to users. Never add providers, workers, data reads or repeated trials from this principle alone.

- **Positive BDD:** Given an approved comparable performance or eval measurement with real run evidence, when Pi tests the proposed number against limiter observations, alternative explanations, run count, spread and task relevance, then it reports a supported scoped claim or an explicit inconclusive result with cited evidence.
- **Refusal BDD:** Given missing run count, spread, measured limiter, proof that work completed, comparable configuration or permission to observe, when asked to trust or publish a number, then call the claim `inconclusive` and the missing check `blocked`/`unrun`; do not launch a profiler, invent trials or present a one-run ballpark as a winner.

This reviewed method has not measured a workload or validated a live Pi journey merely because Pi can discover its file.
