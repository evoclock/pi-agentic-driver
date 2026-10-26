---
name: driver-principle-dependency-policy
description: Use when proposing or changing a project dependency or its install process.
---

# Dependency policy

Prefer first-party code. Accept a third-party dependency only for the platform, critical infrastructure, or pinned development-only tooling. Do not add unpinned ranges or unread install scripts; run installs through Socket Firewall.

Check: each new dependency has a recorded allowed reason and exact lockfile pin before it ships.
