---
name: release-public
description: Use when preparing a tagged public package release or verifying its tag after merge.
---

# Public release

Read [the release procedure](../../docs/release-public.md). Check the source and public branches and run the command with `--dry-run` first. Run the release only for an approved version. Inspect outgoing changes, packed contents, release notes, and PR wording before publishing review artifacts. Keep the PR draft until every check passes and the merge state is clean. Require a merge commit and verify tag ancestry after the owner merges. Leave npm publication to the owner.

Update README status labels for every feature included in this release before you run the command. The command refuses while `README.md` contains "merged, unreleased" in any capitalization, and CI refuses a `chore/release-*` pull request that still has that label. Use shipped or packaged-since wording in the same release commit. Do not open a later pull request after npm publish only to mark those labels shipped.
