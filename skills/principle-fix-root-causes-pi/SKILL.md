---
name: principle-fix-root-causes-pi
description: During an approved bug investigation, trace a reproduced symptom to the first wrong decision and correct that decision rather than hiding the failure. Use explicitly before choosing a fix.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Fix root causes

Adapted from Lauren Tan's `principle-fix-root-causes` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This principle selects the **kind of fix**; the existing `diagnosing-bugs` skill owns the authorized red-capable reproduction and feedback loop. Neither skill grants an app launch, history scan, worker, edit or retry beyond the task contract.

Reproduce the exact symptom at an approved seam **before** forming a cause or changing code. Trace the observed state and error backward, asking “why?” until the answer is the first wrong code decision, not another consequence. If the chain is unclear, use scoped instrumentation to inspect the **actual** state; do not guess from a later stack frame. For a failure that appears after restart, inspect approved persisted config, caches, locks and serialized state first, while respecting data access. State the falsifiable cause and show what observation would contradict it.

Ask whether the state at the failure is **legitimate**. If it can correctly occur, handle it at the code that broke: that guard can be the root-cause fix. If the state must never occur, trace its producer and repair that producer; a catch, retry, clamped value, discarded state or local guard that merely masks the producer is not a fix. Preserve the red-capable behavior check, fix the cause within approved scope, and observe both the minimized check and original scenario turn green. Look for other reachable instances of the **same proved fault** inside the approved paths and verify the repaired pattern; unknown/out-of-scope callers stay reported, not silently rewritten.

If a workaround needs a paragraph-long comment, challenge the workaround rather than writing an explanation for broken behavior. If the decisive fact was hard to uncover, **propose** a cheap always-on signal at the appropriate boundary, with prior-art and effect checks; do not install a global hook or telemetry from this principle. Record genuine negative cases where the new guard must still reject invalid input. An unrun repro, green-only test or changed mock is not evidence of a root-cause fix.

- **Positive BDD:** Given a reproduced approved failure and a red-capable behavioral check, when Pi traces backward to a proved first wrong decision, then an in-scope cause fix (including a legitimate-state handler when appropriate) turns the minimized and original paths green and checks the same fault pattern without hiding errors.
- **Refusal BDD:** Given no authorized reproduction, inaccessible persisted data, uncertain state legitimacy or an out-of-scope producer, when a masking guard or retry is proposed, then leave that change `blocked`/`unrun`, name the missing observation or grant and do not claim root-cause resolution or sweep other repositories.

Pi discovering this file is not a reproduced bug, an applied fix or a live Pi test.
