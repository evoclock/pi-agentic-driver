# Package checks

This public tree does not ship a repository `Makefile` or a `make gate` target.
Buildkite on this repository packs the npm tarball, installs it into a temporary
consumer, and loads every shipped extension (see `.buildkite/pack-smoke.mjs`).

After a local change, run the same check:

```sh
sfw npm ci --ignore-scripts --no-audit --no-fund
node .buildkite/pack-smoke.mjs
```

`npm test` in this package is an alias for that smoke check. It does not run
the private source-tree gate, test-gate runner, or content-scan scripts.

If you are working in the private source repository, use the gate documentation
and runners that live there. Those files are not part of this package.
