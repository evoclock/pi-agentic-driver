---
name: driver-principle-boundary-only-authority
description: Use when deciding whether a driver action is inside its approved repository, path, and effect boundary.
---

# Boundary-only authority

Check authority at consequential boundaries. Inside the approved scope, ordinary reads, edits, and checks need no repeated prompt. Refuse and report an out-of-envelope effect.

Check: before an outward effect, compare its repository, path, and effect with the applicable policy. This principle is guidance, not an enforcement control.
