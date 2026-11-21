---
name: decision-gate
description: Settle bounded autonomous design or gate decisions with statechart modeling, TLC evidence, and an enforcing check without expanding authority.
---

# Decision gate

Use when a review fix conflicts with frozen test inputs, a locked baseline, or a stale mutation mapping. Resolve reversible choices inside the accepted plan; do not wait for a decision that an existing sanctioned route can settle.

## Workflow

1. State the decision, frozen plan/spec, affected inputs and design invariants. Enumerate options, always including the sanctioned native/audited route (such as the gate's audited refresh) and **hold**. Identify permitted effects and exclusions before comparing options. A model result never grants permission.
2. Run `statechart-pi` from `pi-poteto-mode` on Pi if installed (Claude equivalent: `/statechart`); if unavailable, follow Missing tooling below. Model **each option** as a TLA+ specification, with bounded states and explicit assumptions. Use the reviewed example model and configurations from a private source checkout if available; they do not ship with this skill and are not proof of the actual system. Map likely outcomes, failures, recovery, and how each option rejoins the original plan/spec. Include hold and owner-only paths. Check each option with TLC; save the model, config, exact invocation, exit status and complete result. Safe configs must pass; `-unsafe-` negative configs must fail on the intended invariant, not a syntax error. Check coverage and unreachable states so a vacuous success is not mistaken for safety.
3. Choose the permitted option that satisfies the spec/design invariants. Prefer the native audited route over custom repair. For locked-input changes, follow `test-gate`: use its audited refresh only when its preconditions hold, never edit locks or evidence. A stale mapping is not permission to remove inherited contracts or weaken assertions. If no permitted option passes, choose hold for the affected step and continue independent work.
4. Encode the choice as a verifiable gate, lint rule or test aligned to the invariants. Demonstrate failure for the forbidden behavior and success for the selected behavior. Run the normal checks after any audited refresh; refresh alone is not a pass. Do not proceed through the affected step until its enforcement and decision record exist.
5. Record the decision in both the PR body and checkpoint: options, selected choice, invariant rationale, model/config references, TLC result, enforcing check and observed result, return path into the original plan, held steps and next independent action. Then proceed without waiting for approval inside the existing boundary.

## Owner-only exclusions

Never decide or perform these autonomously: merges, undraft, tag, release, public mirror sync, repo forwarding, wording or naming changes the owner has not approved, npm publish, deploy, force-push or rebase, CI-limit or gate-cap changes, and credential access. If the only passing option is owner-only, pick **hold** for that step, record why, and continue everything else. Neither TLC success nor this skill expands scope or replaces required human confirmation.

## Missing tooling

If the statechart skill is unavailable, report that exact gap and build the smallest honest TLA+ model manually. If Java or TLC is unavailable, record **TLC not run** in the PR body and checkpoint. Missing statechart tooling does not mean TLC was unavailable; record each result separately. Never claim a check ran. Continue with the best-reasoned sanctioned option within existing authority, with an enforcing check; hold the affected step if safety cannot be established. Tool absence is not a bypass for a failing invariant.

## Sample verification

If the reviewed model and configurations are available in a private source checkout, copy them into a temporary directory under `.scratch`, then run TLC there with `-workers 1 -metadir <temporary-directory>/meta`. The safe config must exit 0. The `-unsafe-owner`, `-unsafe-record` and `-unsafe-enforce` configs must each exit 12 with their corresponding `OwnerBoundary`, `RecordedBeforeProceed` and `EnforcedBeforeProceed` counterexample. Never write states or trace artifacts into the shipped source directory. The repository skill contract test does this when `tlc` is on PATH or `TLA2TOOLS` names an existing jar (`JAVA` optionally selects Java). It explicitly skips otherwise. The sample models record-before-proceed and enforcement-before-proceed, not the correctness of a repository's actual refresh implementation.

## Limits

This skill is decision guidance, not an authorization engine or a general proof of safety. Its current `kind: code` registration proves only the package/model contract: behavior proof remains unconfigured because no shared proof model was selected. Do not interpret it as a passing guidance trial. Hold is available by construction in the sample; no separate hold invariant proof is claimed. TLC checks only the supplied finite model and assumptions. The repository contract verifies packaging and required workflow text; the sample invariants do not enforce arbitrary real actions. Actual gates must enforce the selected decision in the affected system.
