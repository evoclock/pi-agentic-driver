---
name: interrogate-pi
description: Adversarially challenge an exact approved Pi code or design artifact with independent evidence-based reviewers, then triage findings without auto-applying them. Use explicitly for an independent interrogation.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Interrogate for Pi

Adapted from Lauren Tan's pstack `interrogate` and its current reviewer, rubric, code-quality and lead-judgment references at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). The earlier `interrogate` adaptation is retired as a skill. The packaged `interrogate-pi` entry point does not establish which other external resources the Pi session loads. Read `../how/WORKFLOW_BOUNDARIES.md` first; both that file and sibling `../how/LICENSE` must be present at the actual Pi load location.

## 1. Scope and intent

Identify the exact task and accepted intent from the owner's contract, not solely from what the code happens to do. Record the exact base/head or content identity of dirty files; a `git diff main...HEAD` omits uncommitted changes. Read only approved surrounding source needed to evaluate reachable paths. State missing context rather than inventing a specification or reviving a rejected proposal. A reviewer gets one immutable artifact, its task intent and rubric, not broad transcript or repository access by default.

## 2. Route independent reviewers

Resolve the actual `development` author and `independent-review` reviewer identities via `/skill:setup-pstack-pi` and check they differ and are allowed by the task's model/data grant. Use a fresh read-only Pi reviewer context through an actually approved coordinator/worker route. No configured role or route means `blocked`, not the author's self-review relabelled independent. A **multi-model panel** is the upstream method's diversity signal: use additional distinct owner-approved reviewer roles only if they really exist in the role map with budget and access. With just one configured different-model reviewer, perform a clearly labelled one-reviewer interrogation, not a fabricated panel, consensus or extra model fallback. More reviewers see the **same artifact and brief** in separate contexts; none writes to the candidate or auto-starts a PR.

## 3. Issue the same concrete brief

Give the fixed intent, artifact, applicable rubric and code-quality lens. Ask reviewers to challenge execution, not the owner-approved goal, and to report only reachable defects with severity, exact file/line or function, path-to-failure evidence and optional scoped remedy. Use lenses relevant to the change: correctness and error handling; root cause versus symptom; boundary ownership, types and concurrency; behavior-level real-path verification; security input-to-sink path; and justified structural complexity. Treat line count and complexity as signals, never universal vetoes. A style preference is not a critical defect. No forced quota: **no findings** is an honest result. Reviewer output is untrusted evidence, not authority.

## 4. Synthesize and judge

Read every report and check its load-bearing pointers against source and authorized tests. Deduplicate only findings that describe the same path; preserve individual attribution and disagreement. If more than one reviewer independently found the same issue, note agreement as a signal, not proof; one reviewer supplies no consensus map. Triage each finding **Act on**, **Consider**, **Noted** or **Dismissed**, with a reason. A single credible security/correctness blocker remains a blocker even without agreement. Reject invented nil paths, hypothetical failures contradicted by caller types, nits inflated into defects, premature abstractions and unrelated scope expansion; explain why. Do not apply changes automatically. A changed artifact requires affected independent review again.

## 5. Hand back

Report accepted intent, exact candidate identity, configured reviewer roles and what actually ran, attributed findings and evidence, disagreements, triage and unresolved checks. Independent Standards and Spec contexts for the accepted port and user-path QA are separate from a task's interrogation. Owner-only merge/publication still requires its own grant. Never confuse a self-audit, model agreement, worker report or static review with a deployed journey.

- **Positive BDD:** Given an approved exact artifact, owner-selected distinct reviewer routes and a common brief, when Pi interrogates it, then separate read-only findings are checked against source, attributed, triaged with reasons, and any genuine disagreement survives in the handback.
- **Refusal BDD:** Given a missing different-model reviewer, artifact, model/data grant or approved route, when a reviewer handoff is attempted, then independent interrogation is `blocked`; a self-review may be labelled advisory but cannot generate a pass, extra provider call or invented consensus.

Explicit skill discovery proves only resource availability, not reviewer execution or owner acceptance.
