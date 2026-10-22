---
name: principle-prove-it-works-pi
description: Before declaring an approved task done, check the actual output, value or feature at its real entry rather than trusting proxies or an agent report. Use explicitly for a completion claim.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Prove it works

Adapted from Lauren Tan's `principle-prove-it-works` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This is the direct-artifact completion rule, not permission to start an app, instrument a host, install a verifier, write to an unapproved evidence location or mark a task done. The existing `verify-journey` skill details user-facing BDD drives when that method is actually loaded and the target/effects are approved.

Before saying done, name the **real output** and the owner's observable pass/fail predicate. Check that output directly at the approved entry: inspect the actual changed value or Git diff, exercise the real feature if its target is granted, and check process liveness at the process rather than a derived status. A file mtime, fresh-looking output, cached screenshot, passing compile, worker receipt or self-report is a lead, not the result. Compare the observed value to an independent expected value, not to the same algorithm's echo. When verification fails or passes implausibly easily, first challenge the observation method and make sure the check reached the target; then diagnose the product if the measurement seam is sound. Record both consequential accepted and refusal paths where the task requires them.

Where an approved, deterministic check is practical, prefer a rerunnable script or existing harness over a one-off eyeball: inspect inventory/prior art before new code, run it against a known good and bad case if possible, and retain its exact output as a reviewable private artifact. **Do not author a script merely to assert its own output**, hide an install, or run effects outside the task. Keep evidence visible to the owner. Commit a check/evidence artifact only for large or complex work where an audit trail is warranted **and the Git scope is separately approved**; ordinary verification does not self-commit. If a real target or effect grant is absent, show what source/static checks ran and label the live claim `blocked`/`unrun`, not verified.

- **Positive BDD:** Given an approved completed task, real target and independent expected result, when Pi observes the actual output or user-path behavior and rechecks it through a meaningful rerunnable seam, then the completion claim cites the exact artifact and successful accepted/refusal observations rather than proxies.
- **Refusal BDD:** Given only a compile, fixture, cached view, receipt, inaccessible real entry or unapproved effect, when completion is requested, then identify the missing direct check, mark the real path `blocked`/`unrun` and do not invent a pass, run an app, commit evidence or declare owner acceptance.

A source-inspected or discoverable skill is not a live Pi verification journey.
