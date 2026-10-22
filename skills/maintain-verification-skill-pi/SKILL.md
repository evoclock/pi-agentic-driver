---
name: maintain-verification-skill-pi
description: Audit an approved project-local Pi verification skill and its feature map against source and a real app path; fix proven map or harness drift without editing product code. Use explicitly for a scoped verifier maintenance pass.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Maintain a Pi verification skill

Adapted from Lauren Tan's pstack `maintain-verification-skill` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). `create-verification-skill-pi` writes a project-local verifier; this method maintains one. The outcome is **clean**, **changed** or **blocked**, not an automatic PR. Source inspection, app launch, shared-instance drive, retry, cleanup and external publication each need their own approved boundary. Read `../how/WORKFLOW_BOUNDARIES.md` and the target verifier before touching an app.

## 0. Locate and bound

Identify the one approved project-local verifier with launch, doctor, drive, evidence, cleanup and a feature-map index. If several match, ask which; if none, stop and offer `create-verification-skill-pi` rather than inventing a target. Fixes stay **inside that verifier's own directory**: its `SKILL.md`, `features/` or harness scripts it owns. A mismatch in product behavior is reported, not hidden by editing product code. Name the allowed instance/data paths, safe exit, private evidence destination and actual model/worker routes. No target or effect grant means source-only planning and live coverage `blocked`.

## 1. Check the index

Read the map index and actual sibling feature files. Correct missing, extra, duplicate or dead index entries inside the approved directory; do not create a second inventory. Each feature remains a user-visible unit with its source pointer, user entry and observable proof. A clean source check is not a live pass.

## 2. Source wave and reconcile

The source method uses one **read-only reader per feature**, concurrent across independent feature files. Use that shape only when `development` roles are configured through `/skill:setup-pstack-pi`, the Pi worker route, capacity and project data scope are explicitly approved. Give each the exact feature file and repository revision; request one source-backed feature summary, actual entry points, cited likely drift (or none) and one concise live recipe. Children do not drive an app or write files. Without approved fan-out, investigate features sequentially and mark the parallel wave `unrun`; do not manufacture subagent reports. Ensure **every** feature has a source result; merge overlapping recipes into the fewest safe app states. Spot-check suspected drift and scan bounded recent product churn for concrete missing user-visible paths. A guess is not a missing feature.

## 3. Live pass, if authorized

The coordinator, not source readers, drives **every feature at least once** using the target verifier's real launch model: one checked shared instance serially for UI/server, or fresh isolated session per short-lived CLI drive. Before the first drive and each new-session drive, run read-only doctor and confirm target/build/profile. After any surprising or failed drive, doctor again; if doctor cannot detect a wedged UI, safely reset only state this run owns or stop until authorized relaunch. Never double-drive another user's shared instance.

Maintain three invariants on every success or failure: (1) doctor/readiness actually identifies the safe target before driving again; (2) action/result evidence survives every cleanup, checked at the named private path; (3) state/processes this run created do not outlive their usefulness. On failure clean only the run-owned residue, not a shared instance. A doctor failure caused by proved verifier drift can be fixed under the directory scope and retried **once only after the prior effect is reconciled and retry is within the task grant**; restart only invalidated owned resources. If permission, identity or safe exit is uncertain, stop `blocked` instead of retrying. An unreachable feature is `verified-unreachable` only with the attempted user route and concrete missing prerequisite; if that prerequisite was absent from the map, record drift. Re-drive any harness fix at the real entry before calling it proven. After the last drive and re-proof, teardown only resources the run owns; evidence stays.

## 4. Triage and hand back

A wrong user-facing description is **doc drift**. Behavior works but the harness cannot drive it is a **harness gap**; its helper must be executable, invoked from the verifier and justified against prior art, with no hidden package install. Broken actual app behavior is a **product gap** for the owner, never repaired in this verifier-only scope. Re-read every changed verifier file and report per-feature source/live coverage, attempted paths, unreachable prerequisites, confirmed fixes, evidence preservation and cleanup results in an approved private note. **Clean** requires full source and live coverage with no worthy correction; **changed** requires proven directory-only corrections, reviewed privately for owner handback; **blocked** names every unfinished feature or unsafe route. No branch/PR/merge is opened by this skill; only the repository owner decides later integration.

- **Positive BDD:** Given one approved verifier, feature map and authorized real app instance, when the Pi maintenance pass runs, then every mapped feature has source and live evidence, proved directory-only drift corrections or a clean result, and run-owned residue is gone while proof survives.
- **Refusal BDD:** Given an unknown target, shared instance without grant, missing doctor/exit, unapproved worker or inaccessible feature, when the next action would cross that boundary, then mark that feature and the pass `blocked`/`unrun` (or evidenced `verified-unreachable`) with exact prerequisite; do not edit product code, retry uncertain effects, erase evidence or claim a clean pass.

Explicit Pi discovery is not a feature-level source wave or a real app drive.
