---
name: blast-radius-pi
description: Investigate what an approved change could break beyond its diff, find the one or two safety facts and verify them against real code when authorized. Use explicitly for blast-radius reviews.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Blast radius for Pi

Read `../how/WORKFLOW_BOUNDARIES.md` first. Adapted from Lauren Tan's pstack `blast-radius` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). The separate name avoids collision with the unchanged upstream skill installed for inspection. The earlier adaptation is retired as a skill; package registration of `blast-radius-pi` still does not prove actual Pi session loading.

1. Identify the exact base, head and changed behavior. For dirty files, record their content identity; do not imply HEAD includes them. Read the diff and relevant existing `how`/`why` evidence only when those methods are loaded and authorized.
2. Confirm the Pi `asgrep` code-search tool is loaded in this session, then use it to trace callers and downstream effects and read the source. If unavailable, report the loading gap; use only other authorized code navigation and do not claim a complete caller trace. Look beyond direct references: pinned library versions/patches, wire formats, stored data, another language/process, feature flags, teardown, scheduling and concurrency. A symbol search alone is not the blast radius.
3. State the **one or two facts** on which safety depends and the reachable failure path if each is false. A convincing narrative or reviewer agreement is not proof. For each risk give an evidence-grounded qualitative likelihood and consequence; distinguish confirmed risks from checked-and-cleared ones without invented numbers.
4. Mark each fact's evidence level: unsupported assertion; exact source citation; traced exclusion of the bad case; real-code test; or reproduction at the running app. Say where proof stopped. Cite an actual file/line or library source, not an invented API.
5. Choose the cheapest real-code check that would fail on the bad case. Reuse an existing authorized behavior test or fixture first. New harnesses require prior-art inspection and scoped version-controlled paths. Capture the observed result rather than promising a test. A test, script, profiler or app drive runs **only** within the task's effect, runtime and data grants; no proof-by-execution follows from loading this skill.
6. If package or live-app evidence needs a new permission, mark the safety claim `unproven`, identify the exact missing route and propose the smallest check. For wide uncertain changes, `interrogate` or `arena` may supply additional perspectives **only** when their reviewed Pi ports, configured roles and budgets are separately approved; no automatic fan-out or fallback.

Hand back: changed behavior; each safety fact and observed evidence level; confirmed risk with source path, likelihood/consequence and check; cleared risks with reasons; and the cheapest authorized next proof before an owner-held merge. A missing runtime check stays missing. A public writeup needs its own approval and privacy review.

- **Positive BDD:** Given an approved exact change and a safe real-code check, when Pi follows this method, then at least one load-bearing safety fact is tested beyond the diff, the observed result is cited, and confirmed/cleared/unproven risks are separate.
- **Refusal BDD:** Given missing runtime grant, reviewer route or safe fixture, when a proposed proof would cross that boundary, then the check remains `blocked`/`unrun`, its fact stays `unproven`, and there is no hidden arena, executable or app launch.

This skill is a draft method, not evidence that the running app or the current Pi session has been checked.
