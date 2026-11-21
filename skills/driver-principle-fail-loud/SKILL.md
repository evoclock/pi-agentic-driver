---
name: driver-principle-fail-loud
description: Use when a driver input, boundary check, or required result is missing or fails.
---

# Fail loud

Use this skill when required evidence is missing, failed or uncertain. Never convert an unknown result into a pass.

## Steps

1. List each required input and check, including missing ones.
2. Classify each as passed, failed, skipped or unknown using observed evidence.
3. Stop the affected action on a failed or unknown required result, and report the exact blocker. In a short status, finish with `Action: blocked` and the reason; never say only that work is not passed.

Check: each required check is passed, failed, skipped or unknown; no unknown result is a pass.

## Limits

This is guidance, not a runtime guard. Code-enforced checks, if present, are separate from this skill.
