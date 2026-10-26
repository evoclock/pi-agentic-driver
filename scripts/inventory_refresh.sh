#!/usr/bin/env bash
# inventory_refresh.sh — refresh the repo-local inventory after a Write/Edit
# of recognized code or TASKS.md/HANDOVER.md.
#
# Claude Code PostToolUse passes a JSON object on stdin
# (tool_input.file_path or tool_input.path). Pi passes the edited path as
# the first argument so this script does not read stdin.
#
# The generator is the sibling scripts/codebase_inventory.py. Refresh runs
# against the git toplevel of the edited file. Skip and soft failure are
# silent. A generator crash still prints. Stdin and the refresh are bounded
# so a missing payload or a hung git/python cannot block the caller forever.

set -euo pipefail

target=""
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  target="$1"
else
  # Bound the read. A closed empty pipe returns immediately; a producer
  # that never closes stdin cannot stall the hook past this deadline.
  target="$(python3 -c '
import json, os, select, sys, time
deadline = time.monotonic() + 2.0
chunks = []
while time.monotonic() < deadline:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        break
    ready, _, _ = select.select([sys.stdin], [], [], remaining)
    if not ready:
        break
    chunk = os.read(sys.stdin.fileno(), 65536)
    if not chunk:
        break
    chunks.append(chunk)
raw = b"".join(chunks).decode("utf-8", "replace").strip()
if not raw:
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    raise SystemExit(0)
tool_input = data.get("tool_input") if isinstance(data, dict) else None
if not isinstance(tool_input, dict):
    tool_input = {}
path = tool_input.get("file_path") or tool_input.get("path") or ""
if not isinstance(path, str):
    raise SystemExit(0)
sys.stdout.write(path)
' 2>/dev/null || true)"
fi

[[ -z "$target" ]] && exit 0

# Match on the basename so dots in directory names (2021.12/..., ~/.claude)
# do not count as an extension. The suffix list mirrors EXTENSIONS in
# codebase_inventory.py, plus TASKS.md and HANDOVER.md.
base="${target##*/}"
case "$base" in
  TASKS.md|HANDOVER.md)
    ;;
  *.py|*.sh|*.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts)
    ;;
  *.*)
    exit 0
    ;;
  *)
    first="$(head -n 1 -- "$target" 2>/dev/null || true)"
    first="${first%$'\r'}"
    first_lc="$(printf '%s' "$first" | tr '[:upper:]' '[:lower:]')"
    case "$first_lc" in
      '#!'*python*) ;;
      '#!'*sh*) ;;
      *) exit 0 ;;
    esac
    ;;
esac

parent="$(dirname -- "$target")"
repo="$(git -C "$parent" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -z "$repo" ]] && exit 0

generator="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codebase_inventory.py"
limit="${INVENTORY_REFRESH_TIMEOUT_SECONDS:-60}"
if command -v timeout >/dev/null 2>&1; then
  set +e
  timeout "$limit" python3 "$generator" --source-root "$repo" >/dev/null
  status=$?
  set -e
  # timeout(1) exits 124 when the refresh exceeds the cap. That is a soft
  # failure: stay silent and do not block the caller.
  if [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
    exit 0
  fi
  exit "$status"
fi

python3 "$generator" --source-root "$repo" >/dev/null
exit 0
