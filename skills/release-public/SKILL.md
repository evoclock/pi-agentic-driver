---
name: release-public
description: Use when preparing a tagged public package release or verifying its tag after merge.
---

# Public release

Read [the release procedure](../../docs/release-public.md). Check the source and public branches and run the command with `--dry-run` first. Run the release only for an approved version. Inspect outgoing changes, packed contents, release notes, and PR wording before publishing review artifacts. Keep the PR draft until every check passes and the merge state is clean. Require a merge commit and verify tag ancestry after the owner merges. Leave npm publication to the owner.
