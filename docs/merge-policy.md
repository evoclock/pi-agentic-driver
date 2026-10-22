# Merge policy

The driver has one merge setting. It is the first piece of driver-native setup.

| Value | Meaning |
| --- | --- |
| `human-merges-only` (default) | The owner merges on GitHub. Every agent merge command is refused. |
| `agents-after-checks-and-review` | An agent may run `gh pr merge <number or URL>` once every check on the PR head has passed and a Standards PASS and a Spec PASS are recorded for that exact head. |

## Where it is stored

Copy `config/merge-policy.v1.example.json` to `{PI_CODING_AGENT_DIR}/config/merge-policy.v1.json` (fallback to the installed agent config directory) and set `policy`. The guard never reads a policy from the working tree. A missing file means `human-merges-only`. An unreadable file, an unknown value or a missing schema also falls back to `human-merges-only`.

## How it is enforced

`attended-authority-guard` checks every bash call for a pull-request merge: `gh pr merge`, the REST merge endpoint and the `mergePullRequest` mutation. The answer never depends on a prompt, so a headless bot session and direct Pi use behave the same. A refusal starts with `pi-agentic-driver.merge-policy.v1: needs-owner-approval:` so a coordinator can pass it up as an owner decision.

## Bypasses are refused under both values

These are refused whatever the policy says: `gh pr merge --admin`, `gh pr merge --auto` (alone or with `--admin`), writes to branch protection or rulesets through `gh api`, edits to protection bypass lists, and the GraphQL `enablePullRequestAutoMerge`, `mergeBranch` and branch protection rule mutations. The REST merge endpoint and `mergePullRequest` cannot be checked, so they are refused too. Reading protection or rulesets is allowed.

## The agents value

The guard reads the PR head, its author and its checks through the existing `gh` login. It reads the review record from `{profile}/merge-reviews/<head sha>.json`, written by `agentic_merge_review_record`. Only a simple `gh pr merge <ref>` can be checked, and never one with `--repo` or `-R`, since that could target a different repository from the one the evidence comes from. A new push changes the head, so the review must be recorded again.

Each verdict carries its reviewer identity or session id. The tool adds the recording session id from the host, not from the model, and refuses to record a verdict whose reviewer is the recording session. At merge time a PASS counts only when:

- every check on the head has passed;
- both reviewer identities are present, and neither is the PR author's login or the merging session's id;
- the record was not written by the merging session.

If the merging session has no id, or the PR author is unknown, the merge is refused.

## Limits

This is a workflow guard, not a security boundary.

- Reviewer identities are strings supplied by whoever records them. The guard checks that they differ from the author and the merging session. It cannot prove that a separate reviewer really ran. Two cooperating sessions can still record a review for each other.
- Session ids come from the Pi host. A process outside Pi can write the record file directly.
- Detection reads command text. A merge hidden behind shell indirection, another tool or the GitHub web page is not seen.
- Branch protection on GitHub, with required checks and required reviews, is the real gate. This setting does not change any repository settings.

## Relation to the PR wording check

The PR wording check is a GitHub check like any other. Under `agents-after-checks-and-review` it must pass on the PR head before an agent merge is allowed, because every reported check must pass. A PR with no reported checks is refused. To make the wording check binding for human merges too, the owner marks it required in branch protection. The driver does not do that.
