---
name: tdd-pi
description: For an explicitly requested TDD or regression path, or a bug with an obvious cheap local test, demonstrate a focused red check before the smallest fix and green after. Use explicitly when the test seam is practical.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# TDD bug fix for Pi

Adapted from Lauren Tan's unchanged `tdd` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md` and existing `../diagnosing-bugs/SKILL.md` for bug investigations. The source allows **skipping a new automated test** when the seam is impractical; it does **not** waive this project's stricter authorized red-capable reproduction requirement before a bug hypothesis/fix. No install, production access or broad harness follows from this skill.

Use when the user explicitly asks for TDD, a failing/regression test, or an obvious cheap local bug test. Otherwise skip this method when the only candidate needs broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague repro or large fixture churn. First identify intended behavior, observed failure, affected entry and smallest observable reproduction. Choose the narrowest existing unit/component/integration/regression seam that exercises **behavior**; do not create a new framework to clear a process checkbox. For an actual bug, if no authorized red-capable seam exists, stop the diagnosis/fix at its existing gate and report the needed permission or artifact; a proposed closest check is not observed red.

When the seam is practical, write a focused test against an independent expected behavior, run it **before** production edits, and confirm it fails for the intended reason. A green test, unrelated failure, mock self-assertion or changed assertion that mirrors broken code is not red proof: correct the seam first. Make the smallest permitted cause fix that preserves adjacent contracts; rerun the same regression green and check the original scenario. Do not weaken a prior assertion without a genuinely changed accepted requirement. Keep fixtures scoped and stabilize flaky timing with a declared deterministic signal; first prove this defect, then consider sibling coverage within a separate grant.

If a **new automated** failing test is impractical but an approved red-capable manual reproduction, targeted script, browser drive, snapshot or log assertion can exercise the same wrong behavior, record the actual before failure and after observation there instead. If none can run safely, mark bug repair `blocked` and offer the closest proposed check without claiming a fix. In the handback name exact pre-fix failure, post-fix run, nearby checks and every missing/unrun step; passing a fixture alone is not a real packaged app/user journey.

- **Positive BDD:** Given an approved bug with an inexpensive executable behavior seam, when Pi observes a focused red result before editing, applies the smallest cause fix and reruns that check plus the original scenario, then the regression turns green for the right reason without losing negative behavior.
- **Refusal BDD:** Given no safe red-capable seam, only brittle mocks, no edit/target grant or a test that was already green, when a fix is proposed, then hold bug diagnosis/fix `blocked`/`unrun`, report the closest check and do not invent red evidence or loosen tests to pass.

Discovering a Pi TDD skill is not an executed red/green loop or the Pi session verification.
