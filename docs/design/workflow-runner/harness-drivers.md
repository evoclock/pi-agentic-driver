# Workflow harness drivers

Cam review note: dispatch selects the adapter only from the durable issued
`stack.harness.kind`. It never selects a harness from prompt text. Pi retains
its guarded nested-tool path. Claude is not served.

## Codex caller binding

The configured host caller supplies `harnessBinding` in the options passed to
`dispatchWorkflow`, separate from the workflow and public event. It contains
`kind: 'codex'`, an explicit `account`, and `authority: { ledgerId }`.
No default account, generated approval, credential lookup or environment-based
binding is provided. Existing CLI and tool callers without that configuration
hold rather than dispatch Codex.

`padHarnessDriver` returns `pad-worker-kind-adapter.v1` for a supported binding.
Missing fields return a named `codex-binding-missing` HOLD; a conflicting kind
returns `harness-kind-mismatch`. Missing helpers or unsupported kinds return
`harness-unavailable`. Dispatch records `harness-unavailable` and returns the
specific factory reason as `harnessHold`, without spawning or submitting.

The Codex adapter calls the existing `executeHerdrSpawnWorker` boundary, which
wraps `codex_spawn_pi.js` launch and process checks. It passes the caller's
account and approval binding unchanged. It does not implement another launcher,
set a second account home, pass credential environment variables or weaken
`validateSpawnParams`. Existing guarded submit/delivery boundaries remain
responsible for transport eligibility. A guard denial parks; partial or unknown
effects retain the existing no-replay behavior. This change does not certify
live Codex readiness or authorize live execution.

## Decision and verification

The owner-relayed decision is explicit caller binding, never inferred binding.
Options are guarded dispatch, hold, owner-only configuration and unsafe bypass.
[HarnessChoice.tla](HarnessChoice.tla) models the three binding predicates as
booleans: guarded dispatch serves only when all are present; every absent
combination holds. The unsafe bypass must violate `ScopedSpawn`. A separate
bad-type control tests `TypeOK`; both are registered in the model inventory.

The finite model excludes credential storage, ledger validity, subprocesses,
filesystem races and transport readiness. Those remain the existing boundaries'
responsibility. Fake-only conformance tests exercise exact parameter forwarding,
missing fields, mismatches, helper absence, denied guards, Pi compatibility and
issued-kind selection. No live Codex run is part of verification.

## Fresh configuration baseline

The caller-binding tests and their two focused mutation contracts are committed
before implementation on a fresh review branch. The earlier branch, fail-first
lock and evidence are retained; no pushed history is rewritten. The new baseline
proves assertion failures against base production with the final gate configuration.

[RebaselineChoice.tla](RebaselineChoice.tla) compares fresh-branch rebaseline
with owner-wait. It checks FailFirstProven, NoLockRewrittenOrDeleted,
NoPushedHistoryRewritten, ConfigBeforeLock and bounded Progress. Every
nonterminal phase has a forward transition; the hold terminal state fails
Progress. Weak fairness excludes infinite prefix stutter. This finite encoding
does not prove completion of external tools or eventual human approval. Each
checked obligation has a registered named negative control.
