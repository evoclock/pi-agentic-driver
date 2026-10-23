---
name: weekly-build-recap
description: Draft a local weekly GitHub shipping recap with a PNG, an X post, and a LinkedIn post. Use when asked what shipped this week across repositories.
---

# Weekly build recap

Use when the owner asks for a weekly draft of what they shipped on GitHub. It writes drafts locally; the owner posts them. Never post, like, send, or call a write API.

Run `python3 skills/weekly-build-recap/recap.py --output scratch/weekly-recap` from the repository root. The default window is the last seven UTC dates, inclusive. Override with `--days N` or both `--since YYYY-MM-DD --until YYYY-MM-DD`. Defaults for the owner, bot author logins, theme and named palette live in `config.json`; edit that file or override the identities using `--account LOGIN` and repeatable `--author LOGIN_OR_EMAIL_OR_NAME`. Authentication uses the existing read-only `gh api` login or an already-set `GITHUB_TOKEN` passed through by `gh`. The code never reads, logs or prints credentials. `--stats-input path.json` accepts a pre-fetched dump without network access.

The collector searches opened PRs by `user:<owner> is:pr created:START..END` and merged PRs by `user:<owner> is:pr is:merged merged:START..END`. It walks owned repositories and their branches and counts distinct commits authored by the configured identities within the window; forks compare against the parent default branch to exclude upstream commits. Default-branch authored commits are counted separately. Repository descriptions use a meaningful README paragraph or the repository description; merged PR titles identify what landed. A repository with no merged PR says so rather than inventing work. Oversized search results, fork comparisons or histories fail closed instead of returning partial counts.

## Picture

The default 1600×900 PNG uses the neutral preset in `config.json`: calm greys with muted slate, sage and clay accents. The optional `flockmate` preset retains its original accent colors. Accents are sparse thin markers or strokes, never large saturated blocks or heavy dark boxes. Geist Sans uses weight for hierarchy, falling back to Geist, Helvetica Neue and the system sans-serif if unavailable. Layout: header, four headline numbers, repository lines, How line, optional outlined note, counting footnote. `--theme light|dark`, `--palette neutral|flockmate|okabe-ito-reduced`, `--config path.json` and `--note TEXT` customize drafts. The reduced Okabe-Ito palette is non-default and excludes yellow and blue. Library default colors are never used. The renderer requires `rsvg-convert` (librsvg).

The phrase lint rejects vague language. An optional gitignored `banned.local.json` list adds local phrases to reject. Inspect each line for accuracy before sharing.

## Replaceable interfaces

`stats.json` has `schema: "weekly-build-recap.v1"`, `account`, ISO `since` and `until`, `counts: {commits, default_commits, prs_opened, prs_merged, repos}` (nonnegative integers), `repos: [{name, url, description, landed: [merged PR title], commits, default_commits, prs_opened, prs_merged}]`, and a plain `method` string. `highlights.json` has `schema: "weekly-build-recap.highlights.v1"` and `lines: [string]`, one per repo in stats order. `--stats-input` and `--highlights-input` replace collection and highlights generation. The default `render.py` consumes those two files plus `render.json` (`schema: "weekly-build-recap.render.v1"`, `note`, resolved `palette`, `theme`) and produces `recap.png`. `--renderer none` skips image generation so another renderer can consume the versioned files and produce a 1600×900 PNG. Verify replacement image dimensions, non-empty content and that the expected text came from the same data. The standard path does this without OCR through schema/line checks, render-from-data and PNG checks. `x.txt` has at most 280 Unicode code points; platform URL/emoji weighting may differ. `linkedin.txt` is longer. Keep output in a gitignored directory; never commit account-specific drafts.

Offline tests: `python3 -m unittest discover -s skills/weekly-build-recap -p 'test_*.py'`. Fixture tests never use a live network.
