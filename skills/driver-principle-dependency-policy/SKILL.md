---
name: driver-principle-dependency-policy
description: Use when proposing or changing a project dependency or its install process.
---

# Dependency policy

Use this skill before adding a dependency or changing how it is installed. Prefer first-party code.

## Steps

1. Explain why the platform, critical infrastructure or pinned development-only tooling needs a third-party package rather than existing code.
2. Read its install scripts and record the exact package version and lockfile pin. When declining an unpinned proposal, explicitly require both the exact version and lockfile pin in the response. Reject unpinned ranges and unread scripts.
3. Name the trusted guard in the response: Socket Firewall if installed, or the project's named install guard. Do not substitute an unspecified "guarded install" for this check. If no trusted guard is available, report that and do not install.
4. Verify that the locked version and justification are in the change before shipping.

Check: a dependency has an allowed reason and exact pin before it ships.

## Limits

These steps are guidance. The project's install guard, if present, enforces installation policy; this skill itself does not.
