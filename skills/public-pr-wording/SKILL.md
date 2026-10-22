---
name: public-pr-wording
description: Use before creating or editing any pull-request title or body. Draft in the four-section shape, rewrite with agentic_aidr and a bro-style restatement, then run pr_wording_lint until it exits 0. CI runs the same lint on every PR.
---

# Public PR wording

Write every PR as if strangers will read it. The lint enforces the rule; this file only says how to pass it.

The lint and its CI workflow check only the PR title and body. They never read repo files, so model names and other text in the README, docs or code are not affected. The only files read are the rules and the optional config.

## Shape

```
## What changed
## Why
## How verified
## Notes for agents
- One reusable lesson per bullet, at most 5, at most 30 words each.
```

Caps: title 10-72 chars, no trailing period. Body at most 300 words and 40 lines. Sentences at most 28 words. Code blocks at most 8 lines.

Write as the repo owner, in first person: "I changed", "I review merges". Never refer to the owner in the third person ("<your name> will", "the owner", "the user", "<your handle> will review"). Your handle may still own plain statements, such as "Only <your handle> merges". Never write bot or model names, local paths, or the story of how the fix was found. Debugging history belongs in private notes or the decision trail, not the PR.

## Setup

The base rules in `pr_wording_rules.json` are generic and name no person, bot or model. They catch "the owner", "the user", local paths, dashes, emoji, filler and battle stories. With no personal config, the lint runs on these alone.

Your own names live in a personal config that is never committed:

1. Copy `pr_wording_config.example.json` and replace the placeholders:
   - `owner_names`: your name forms. Third-person use is flagged ("<name> will", "<name>'s").
   - `handles`: your account handles. Flagged only as a speaking subject ("<handle> will review"), so "Only <handle> merges" passes.
   - `bot_names`: bot or agent names, matched as whole words.
   - `model_names`: model or provider names. Versioned forms also match, so `model` catches `model-2` and `model5.1`.
   - `banned`: extra `{"reason", "pattern"}` regex rules.
2. Save it where the lint looks, first match wins:
   - the `--config <file>` argument;
   - the file named by `$PR_WORDING_CONFIG`;
   - `$PI_CODING_AGENT_DIR/skills-config/public-pr-wording.json`;
   - the installed agent skills-config directory's `public-pr-wording.json`;
   - `pr_wording_config.local.json` beside the lint (git-ignored).
3. Check it is picked up: put a line such as "<your name> will review it." in a test `body.md`, then run `python3 <this skill folder>/pr_wording_lint.py --title "Check my wording config" --body-file body.md`. It must report a third-person reference.

A path given by `--config` or `$PR_WORDING_CONFIG` must exist. A bad config exits 2.

Model family names are not in the base rules. Which models count as private differs per team, and a base ban would block PRs that name a model on purpose. Add them to your config.

In CI the workflow uses the base rules. A repo may commit `.github/pr-wording.json` in the same format to add shared, non-personal rules; the workflow reads it from the base branch.

## Steps

1. Draft the title and body in the shape above.
2. Run `agentic_aidr` with `source: "text"`, `mode: "ste"`. Apply its findings.
3. Restate the body the way `bro` does: same facts, fewer words, plain terms. Keep limits and open decisions.
4. Lint, and repeat from step 2 until it exits 0:

   ```bash
   python3 <this skill folder>/pr_wording_lint.py --title "$TITLE" --body-file body.md
   ```

   In this repo the folder is `skills/public-pr-wording`. Installed, it is the installed agent skills directory's `public-pr-wording`.

5. Create or edit the PR as a draft with the linted text only.

If `agentic_aidr` is not loaded, say so and apply its four rules by hand: clarity, simplicity, brevity, humanity. Do not claim it ran.

To change a generic cap or pattern, edit `pr_wording_rules.json` and add a test in `tests/`. Put anything personal in your config instead. Never reword around a pattern to slip past it.
