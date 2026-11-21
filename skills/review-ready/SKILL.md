---
name: review-ready
description: Run reusable review checks and record guard evidence before requesting review.
---

# Review ready

Use before every review request or review-fix handoff in the PAD repository.

1. Before baseline, run `node scripts/review_gate_tools.mjs` and `python3 scripts/review_contract_preflight.py`; register reviewed focused mutation keys before taking the lock. Never change contracts after the lock. Then run `make preflight` with working Java and a TLC jar configured through `JAVA` and `TLA2TOOLS_JAR` (or `TLA2TOOLS`). The command requires TLC, checks the current main ancestry, owner terms, inherited test tokens, negative controls and boundary cases. If main moved, merge `origin/main` with `--no-ff` and rerun. Never rebase or force-push.
2. If a fix contradicts frozen gate inputs, follow `decision-gate` and the native audited `test-gate` route. Model reversible choices with `statechart-pi` if installed; if unavailable, write the smallest bounded TLA+ model manually as `decision-gate` directs. Record the model, TLC result and choice; missing TLC still blocks verification. Do not edit locks, gate policy, mutation entries or pipeline configuration. A blocked step remains blocked; continue independent work.
3. List every new guard alongside its detecting test and named mutant or negative cfg. Verify the safe model succeeds and each negative cfg fails on the intended invariant or property, not a parser error. Record historical coverage exceptions honestly; an allowlist is not proof.
4. Run the official checks through their existing mechanisms. Record exact commands, exit codes, log references and any skipped or blocked checks. Never claim a check passed without observed evidence. Behavior proof for this skill is separate from packaging tests.
5. Map recurring findings F1 through F23 to checks or explicit deferred work in the PR body or a linked design document. Run the owner terms lint against added lines and the final PR title/body. Request review only for the final head, with a draft PR and current-base evidence; do not mark ready or merge.

## Limits

This is guidance, not an authorization mechanism or a replacement for the official test gate. The local preflight does not change CI or frozen mutation contracts. TLC proves only the bounded models supplied; historical missing negative controls remain visible exceptions. Repository commands require the source checkout; the packaged skill supplies guidance only. No credential access, installs or real worker dispatch is needed.
