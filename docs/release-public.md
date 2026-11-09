# Public release

Use the official script from the source repository, not an installed driver copy. Prepare a clean source release branch containing current private `origin/main` and a clean public checkout on `chore/release-X.Y.Z` containing its current `origin/main`. Do not change dirty primary checkouts or create another worktree to avoid reconciliation.

## Draft public sync PR only

```bash
python3 scripts/release_public.py 3.1.8 --public <public-release-checkout> --prepare-pr-only --changelog-note "Show who starts tasks and which skills each task uses." --dry-run
```

Inspect the preview, then omit `--dry-run` only within the approved preparation scope. The official mode validates the exact generated title/body with the existing wording lint before sync, tests, versioning or any public push/PR creation. It retains the normal README/privacy preflight, both source test suites, package/lock/changelog bump and source commit, curated sync and public commit, and tracked-archive checks. It then pushes only the public review branch and opens a **draft** PR. It returns before any tag or GitHub release operation. It never publishes to npm or merges.

The tests and packing are real execution, not a preview or an isolation guarantee. They may execute repository code, package hooks and offline test-fixture installations. For the specifically approved3.1.8 preparation, these ordinary official steps may run on clean release worktrees on this Mac. Only test-fixture installations are covered, with Socket Firewall mandatory. Installing/activating the released driver, global changes, npm publication, tags, GitHub releases and merges are not covered. This task-specific exception is not a general host-execution policy. Do not replace normal tests with a test seam, omit them silently or invent a new off-host artifact pipeline.

`--prepare-pr-only`, `--refresh-tag`, and `--verify-merged` are mutually exclusive. A lint, privacy or archive failure blocks the outward operation. Preserve any partial source/public commits and validation evidence; do not blindly repeat the command or delete partial work. The same title/body tuple validated before preparation is passed to draft creation, not regenerated after a push. Customer copy retains the existing four mandatory headings. `How verified` describes customer-visible failure/unknown behavior, not test/build procedure; `Notes for agents` gives product-usage guidance, not internal identities or development history. Do not include literal commands, paths, models or crew details. Keep the existing verifier, profile, bans and caps unchanged.

**A release-worktree pack is only a validation artifact. It is not the final publishable tarball.** The final publishable tarball and npm publication must come from the verified **primary public main checkout after owner merge**, never a release worktree, downloaded asset or fixture. A successful PR-only preparation creates no tag; the tag-verification workflow below is not a preparation closeout check. Merge and later publication remain separate owner decisions.

## Existing publication route

Without `--prepare-pr-only`, the original route syncs and packs the public branch, refuses untracked/unsafe archive members, pushes the branch and tag, creates a GitHub release and opens a draft PR. Archive verification precedes the first public push. That route and `--refresh-tag` retain publication effects and require their own explicit authorization. A PR-only grant does not authorize either route. Use `--dry-run` for a side-effect-free step list.

Before versioning, sync or packing, the source README must not contain "merged, unreleased" in any capitalization. Included features need accurate status wording in the same candidate, such as packaged since X.Y.Z. Do not leave stale status labels for a post-publication follow-up. CI applies the shared `scripts/check_readme_release_status.py --if-release-branch` check to release branches.

For a separately authorized tagged release, merge the public PR with a **merge commit** so the tagged commit remains on main. After owner merge, use `--verify-merged` with the **primary public main checkout**. It refuses a worktree or stale main, checks tag ancestry/version and verifies tracked, generated-file-free package contents against the tag. Only the owner publishes from that verified main checkout using supported authentication. The script never publishes to npm, merges or pushes main.
