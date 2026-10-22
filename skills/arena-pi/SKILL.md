---
name: arena-pi
description: Compare separately produced candidate solutions to one approved non-trivial Pi task, cross-judge against a rubric, select a base, graft only the best parts and verify the synthesized result. Use explicitly when one attempt could lock in the wrong shape.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Arena for Pi

Adapted from Lauren Tan's pstack `arena` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Preserve Frame → Fan out → Cross-judge → Pick → Graft → Verify. Do not import Cursor `Task` defaults, Cursor model rules, background fan-out or `/tmp/arena-*`. Read `../how/WORKFLOW_BOUNDARIES.md` first.

## Before launching candidates

Use the approved task contract, exact repository and revision, effect/data boundary, capacity, candidate paths, artifact rubric, budget and stopping point. An arena is not permission to create a new assignment or choose a provider. Resolve required roles through `/skill:setup-pstack-pi`; confirm the actual author and `independent-review` identities differ. Any additional candidate role and its model/data grant must be selected by the owner and validated before use. Do not turn the independent reviewer into a second author to manufacture model diversity, or silently reuse the development role as a supposedly diverse model. If no approved isolated candidate routes exist, produce a labelled single-author comparison proposal and mark the multi-candidate run `blocked`. The same independent-review role may cross-judge finished candidates **in a fresh read-only context** if the task permits it; a later final-artifact reviewer must use a **different fresh context** after synthesis. Cross-judging never satisfies final exact-artifact Standards/Spec review or user-path QA.

Use Pi session tasks to track the six phases when loaded; otherwise keep a visible six-phase checklist in the approved task evidence. A Treehouse lease is an ownership boundary, not runtime containment. Candidate writes require separate approved work locations and exact assigned paths; read-only candidates can use separate contexts with the same fixed inputs. Do not create worktrees, spawn workers, install packages, delete candidates, publish, open a PR or merge by implication. Only the repository owner merges.

## A. Frame

1. State the **one** artifact each candidate must produce and the exact shared brief. Derive 3–6 observable, task-specific criteria for comparing it. Candidates see the same task, grounding and input revision; the rubric is for selection and the cross-judge. State any invariant a candidate must not violate and the real verification seam.
2. Choose the number of candidates and distinct authorized routes based on the task's budget. Do not quietly start more workers or select fallback identities when a route refuses. Use separate, approved output locations; preserve and label incomplete or missing results.

## B. Fan out

Within the already approved Pi coordinator/worker interface, dispatch each candidate once with the identical contract, its own output destination and a request for rationale and rejected alternatives. Confirm the actual candidate artifact exists and its exact revision/content identity; a worker receipt or self-report is not the artifact. If a candidate drops out, record the failure and continue with fewer only if the approved rubric still permits a meaningful comparison. With one candidate, stop the arena selection and label the comparison `unrun`.

## C. Cross-judge

After candidate writes finish, give a separately approved, read-only `independent-review` context the same rubric and immutable candidate artifacts, labelled by path, to score each criterion and recommend a base with reasons. Do not let the judge edit candidates or spawn them. If the reviewer is missing, unavailable or not distinct from the authors, mark cross-judging `blocked`; a self-score is not an independent verdict.

## D. Pick

Read **every** candidate in full. Score each criterion against actual evidence, independently of the cross-judge; then compare recommendations. If they disagree, inspect the disputed criterion before deciding. Prefer a base whose boundary and interface are easier for the next maintainer to extend. Convergence can justify a shared shape; wild divergence may mean the brief is underspecified, in which case reframe within scope rather than averaging incompatible designs.

## E. Graft

Identify at most the few genuinely useful parts of losing candidates. Fold them deliberately into the selected design so it retains one coherent ownership model. Do not paste competing implementations or recreate parallel sources of truth. Preserve which candidate supplied each graft and why another idea was rejected. Changes to effects, data routes or accepted specification require an owner decision.

## F. Verify and hand back

Run the approved checks on the **synthesized** artifact, not a losing candidate's test report. A failure due to a wrong task frame returns to A; a missed useful candidate idea returns to E. Record the base choice, cross-judge verdict, each graft, rejected alternatives, convergence/dropouts, actual verification output and unrun paths. After synthesis, run independent exact-artifact Standards and Spec review in fresh contexts **separate from the cross-judge context** through the configured different-model reviewer; applicable user-path QA is also separate. Neither a cross-judge verdict nor this method certifies those checks.

- **Positive BDD:** Given one approved task, at least two authorized isolated candidate routes and a distinct read-only judge, when Pi runs the six phases, then two real artifacts are compared criterion by criterion, a base and justified grafts produce one checked artifact, and the evidence names both successes and failures.
- **Refusal BDD:** Given no approved distinct candidate capacity, writable isolation, reviewer, budget or effect route, when the next phase would require it, then the missing phase is `blocked`/`unrun` without a substitute provider, invented verdict, shared-write race, hidden install or external action.

The skill can be explicitly discovered and reviewed without running an arena. That is **not** positive BDD or Pi loading evidence.
