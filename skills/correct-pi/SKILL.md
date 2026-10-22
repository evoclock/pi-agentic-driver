---
name: correct-pi
description: Find a recurring, evidenced agent mistake in an approved repository and prevent it structurally, then prove the guard catches a real past failure. Use explicitly after the owner identifies a repeated correction.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Correct repeated mistakes for Pi

Adapted from Lauren Tan's pstack `correct` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Preserve evidence-based mistake classes, architecture-before-prose, a failing check against an actual mistake and a rule/enforcer map. This method is not permission to read unrelated conversations, alter project instructions, install a lint tool, rewrite a repository, commit, run CI or push. Read `../how/WORKFLOW_BOUNDARIES.md` before effectful work.

## 1. Find a repeated class

Within the named approved repository and bounded history, inspect existing commits/reverts, review findings, authorized correction records, instruction files and comments explaining workarounds. Do not search unrelated Pi sessions or private chats. Group the exact errors by underlying class and link at least **two real occurrences** before calling one recurrent. A single incident can deserve a fix, but label it one incident, not a trend. Favor the most frequent consequential confirmed class. State how a future agent seeing only one nearby file could repeat it.

## 2. Prevent it at the highest workable level

Choose the first level that actually blocks this class, and justify why any higher one did not fit:

1. **Architecture:** one state owner and supported route, hidden internals and derived lists, with redundant examples/legacy paths removed **only** after authorized caller and compatibility checks. Do not delete private evidence.
2. **Types or a focused lint/build rule:** make the bad state unrepresentable; if it still compiles, make a check fail with an error that names the correct file/type/function. If existing violations are widespread, enforce no new violations while planning an approved migration.
3. **Behavior test:** exercise the user-visible mistake and ensure the test fails when it recurs but passes for internal refactors. Do not accept a mock that tests itself.
4. **Documentation/agent rules:** reserve for judgment calls that a structural check cannot encode. A skipped instruction does not fail by itself; do not call prose a guard.

Inspect inventory and existing enforcement before adding a helper, function, script or rule. State: “Existing X does Y; a new one is needed because Z,” when Z is real. Do not infer from an upstream instruction to edit `AGENTS.md`, installed Pi settings or a global hook; ask for exact destination and grant. Every exception requires an inline reason, an expiry and a human decision where the authorized enforcement mechanism supports one.

## 3. Prove the barrier and record ownership

Reproduce a **real past mistake** at a safe, red-capable seam before claiming the new check prevents it. Record the observed failure from the same check that will guard future work, then the corrected case passing. If local and CI routes both exist and are separately approved, verify the same check in each; otherwise mark CI `unrun`. Make one verified unit per class, not an unsolicited series of commits. Document approved rules in a rule-to-enforcer table in the authorized project instruction destination, or propose the table without writing when that file is outside scope. On a later owner correction, update the fix and table; a rule with no enforcing check is a signal to improve structure. Remove an obsolete rule only after proving its mistake cannot occur.

Hand back each class, two source pointers, chosen enforcement level, reason higher levels failed, observed red/green output, exception and runtime/CI gaps. Only the repository owner chooses any merge or publication.

- **Positive BDD:** Given two cited occurrences and an approved code/test seam, when Pi corrects the class, then an actual prior bad case fails against the new barrier, the good case passes and the proposed rule maps to its enforcer without changing unrelated behavior.
- **Refusal BDD:** Given only one occurrence, no permission for history/instructions/tests, or no safe red seam, when asked to install a global rule or claim prevention, then label the class unproven or work `blocked`/`unrun`, and do not mutate instructions, commit or manufacture green evidence.

A skill discovered in Pi is not proof that any mistake is prevented.
