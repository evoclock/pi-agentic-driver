# Public release

From the source repository (not the public package), use `python3 scripts/release_public.py X.Y.Z --public <public-checkout> --dry-run` for a side-effect-free step list. Prepare a clean source release branch based on `origin/main` and a clean public checkout on `chore/release-X.Y.Z` based on its `origin/main`. Then run without `--dry-run` only when the release version and notes are approved. The command syncs, tags the public branch head, packs it, records the tarball checksum, creates a GitHub release, and opens a draft PR. Review the generated changelog entry and release notes before using them for a real release.

Before the command bumps the version, syncs, tags, or packs, it reads the source `README.md` that sync will copy. If that file contains the status text "merged, unreleased" in any capitalization, the release stops. Features included in this version need released wording in that same README, such as shipped or packaged since X.Y.Z. Do not leave the old label in place and open a later pull request after npm publish only to mark it shipped.

The same check runs in CI for branches named `chore/release-*`. A release pull request cannot pass while the label remains. The shared script is `scripts/check_readme_release_status.py`. Agents Buildkite runs it directly. Public sync copies the script and the public content scan, and the public pipeline already runs that scan, so the public release pull request runs the same check.

Merge the public PR with a **merge commit**. Squash and rebase do not preserve the tagged commit on main. After merging, run `python3 scripts/release_public.py X.Y.Z --public <public-checkout> --verify-merged`. It fails if the tag is not reachable from `origin/main`. The owner then handles npm sign-in and package publication. The command never performs those operations or merges or pushes main.

## Public sync pull requests

After `scripts/public_sync.py --apply`, open the public draft PR with `skills/public-pr-wording` only. Required sections are `## What changed`, `## Why`, `## How verified`, and `## Notes for agents` (first person, short bullets, no bot names, local paths, or battle story). Never use GitHub's `## Summary` / `## Test plan` template. `scripts/open_public_sync_pr.py` runs the lint and opens the draft. Release PRs from `release_public.py` already use this shape.
