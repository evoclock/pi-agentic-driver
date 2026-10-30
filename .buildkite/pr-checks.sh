#!/usr/bin/env bash
set -euo pipefail
mode="${1:?Choose wording or review}"
pr="${BUILDKITE_PULL_REQUEST:-false}"
if [[ "$pr" == false || -z "$pr" ]]; then
  echo "NOTICE: $mode is PR-only; skipping this non-PR build"
  exit 0
fi
[[ "$pr" =~ ^[0-9]+$ ]] || { echo 'Invalid PR number' >&2; exit 1; }
if [[ -z "${GH_TOKEN:-}" ]]; then
  GH_TOKEN="$(buildkite-agent secret get GH_TOKEN)" || {
    echo "ERROR: Buildkite GH_TOKEN is unavailable for $mode" >&2
    exit 1
  }
  [[ -n "$GH_TOKEN" ]] || { echo 'ERROR: Buildkite GH_TOKEN is empty' >&2; exit 1; }
  export GH_TOKEN
fi
repo=evoclock/pi-agentic-driver
scratch="$PWD/.ci-buildkite/${BUILDKITE_BUILD_ID:-local}-${mode}"
test ! -e "$scratch"
mkdir -p "$scratch"
gh api "repos/$repo/pulls/$pr" > "$scratch/pr.json"
base_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"]["sha"])' "$scratch/pr.json")"
git fetch --quiet origin "$base_sha"
case "$mode" in
  wording)
    base=skills/public-pr-wording
    if ! git cat-file -e "$base_sha:$base/pr_wording_lint.py" 2>/dev/null; then
      echo 'NOTICE: PR wording tool is absent on the PR base; bootstrap check skipped'
      exit 0
    fi
    mkdir -p "$scratch/pr-wording"
    for name in pr_wording_lint.py pr_wording_rules.json; do
      git show "$base_sha:$base/$name" > "$scratch/pr-wording/$name"
    done
    python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); json.dump({"pull_request":{"title":p["title"],"body":p["body"]}},open(sys.argv[2],"w"))' "$scratch/pr.json" "$scratch/event.json"
    args=(--event "$scratch/event.json")
    if git cat-file -e "$base_sha:.github/pr-wording.json" 2>/dev/null; then
      git show "$base_sha:.github/pr-wording.json" > "$scratch/pr-wording.json"
      args+=(--config "$scratch/pr-wording.json")
    fi
    python3 "$scratch/pr-wording/pr_wording_lint.py" "${args[@]}"
    ;;
  review)
    if ! git cat-file -e "$base_sha:scripts/enforcement/pr_review_gate.js" 2>/dev/null; then
      echo 'NOTICE: PR review gate is absent on the PR base; bootstrap check skipped'
      exit 0
    fi
    git show "$base_sha:scripts/enforcement/pr_review_gate.js" > "$scratch/pr_review_gate.js"
    node "$scratch/pr_review_gate.js" --repo "$repo" --pr "$pr"
    ;;
  *) echo "Unknown check: $mode" >&2; exit 2 ;;
esac
