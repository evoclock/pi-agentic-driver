# pi-agentic-driver

Evidence-oriented extensions for [Pi](https://github.com/earendil-works/pi-coding-agent):
advisory code review and bounded role communication for agentic workflows.

## Extensions

### code-phage

Advisory code-bloat and scope-alignment review. Prior art means existing
**code** abstractions and conventions (symbols, signatures, dependencies) —
never word matches on the goal text. When a reusable abstraction exists,
code-phage directs the implementation to reuse or extend it instead of
forking a parallel version, and requires source/version/license credit for
any concept or code taken. It measures diagnostic complexity signals
(cognitive complexity, cyclomatic complexity, line count, duplication),
compares candidate scope with the stated goal, and never mutates or blocks
work.

Concept credit: Matty Stratton, "Cognitive Complexity" (2024-09-20, concept
only, no code copied); `flake8-cognitive-complexity` 0.1.0, MIT (concept
only, not a runtime dependency).

### herdr-communication

`agentic_herdr_communication`: bounded, non-authorizing communication with
configured worker roles through [Herdr](https://github.com/herdr) 0.7.5.
Fixed argv, `shell: false`, trusted-repository allowlist, exact report
markers, one prompt with no retry, fail-closed everywhere. It cannot control
panes, start agents, run shells, or grant authority.

## Install

```sh
pi install <tarball-or-npm-package>
```

Both extensions load standalone; neither requires the other.

## License

AGPL-3.0-or-later with author-attribution additional terms (Section 7(b));
see [LICENSE](LICENSE). A commercial licence is available on request.
