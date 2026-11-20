# G7: spec-first worker gate

Cam: please review this contract before implementation lands. This is a draft extension of the existing runner, not a scheduler or an authority source.

## Dispatch boundary

Every workflow containing a worker step needs a `pad-workflow-spec-ref.v1` reference: a normalized repository-relative `.json` manifest path and its SHA-256 at the workflow's frozen revision. Workflows without worker steps retain their current behavior. The reference is part of the workflow contract digest.

Before any act or dispatch, G7 must obtain passing, binding-matched host evidence. Missing references park `spec-missing`; unchecked references park `spec-unchecked`. Only a passing spec at the current manifest digest opens dispatch. Private `_spec` observations are runner-issued, consume a unique evidence ID once, and bind task, epoch, writer, contract digest and manifest digest. Public `spec` host work runs outside the writer lock; replay returns the original answer without rerunning host work. Cancellation and ownership fences still apply.

## Pinned bundle

The manifest schema is [pad-design-spec.v1](schemas/pad-design-spec.v1.schema.json). All pinned bytes come from `git show <revision>:<path>`, never the working tree or a worker commit. Paths must be normalized, repository-relative and traversal-free. Each file is at most 256 KiB. SHA-256 mismatches park `spec-digest-mismatch`. The bundle pins the TLA+ module, view, dependencies, safe config and at least one unsafe config. Limits are 16 invariants, eight unsafe configs and 32 declared checks.

Each declared invariant must be an operator in the module and appear in the safe config's INVARIANTS. Each unsafe guard must be a declared constant set TRUE in the safe config and FALSE in its unsafe config, and mustViolate must name a declared invariant. Failures park `spec-fidelity`; absent controls park `spec-no-controls`.

An optional committed chart is a human-review artifact. A declared but absent chart parks `spec-chart-missing`; mismatched bytes park `spec-chart-unconfirmed`. No chart key is valid. The chart is not regenerated and is not a proof.

## Installed-only checker

Resolve `statechart-pi` through `config/skill-sources.v1.json`, not a hardcoded install path. Invoke `node <RESOLVED_SKILL>/scripts/run-tlc.mjs --check`, then `--spec <STAGED_MODULE> --config <STAGED_CFG> --out <NEW_OUTPUT_DIR>` for each config. Stage all pinned model dependencies under `<WORKTREE>/.scratch/workflow-runner/spec/<EVIDENCE_ID>/`. Every output directory must be new. The adapter emits only `result.json` and `tlc.out`; there is no `--view`, generated chart or report requirement.

Use the caller's PATH containing Java and TLA2TOOLS_JAR pointing to an already-installed jar. Never install Java, download a jar, run mise, invoke the upstream scripts/statechart CLI, generate TLA+ in PAD, or substitute lib/model-fidelity. Missing skill, jar, Java or a blocked availability check parks `spec-checker-unavailable`. Per-check timeout is 120 seconds; the total budget is 300 seconds.

Safe requires adapter exit 0, status `checked-no-errors` and checkerExit 0. A safe counterexample parks `spec-counterexample`. Every unsafe requires exit 1, status `failed`, and a named invariant violation of its mustViolate in tlc.out. Passing or wrong-rule controls park `spec-guard-not-load-bearing`. Blocked, timed-out, truncated or incomplete runs park `spec-check-incomplete`. Only the complete bundle can derive a stack. Scratch keeps raw evidence; journals retain bounded digests, verdicts and counts.

## Stack and policy

Sources are ordered package or pad-vendored entries. First source containing a skill wins; resolved content is SHA-256 pinned. Derivation applies always-on skills, matching rules in order, then stack.extra; deduplicate and sort deterministically. Output `pad-derived-stack.v1` contains pinned skills, playbook, harness and specDigest; derivedDigest hashes canonical output. Unknown extra skills park `spec-stack-unknown`; unresolved required skills park `spec-stack-unresolved`.

Dispatch copies only the checked derived stack into durable intent and into the worker prompt, ignoring caller-supplied stacks. A harness not served by the driver parks `harness-unavailable` before spawn. G7 supplies no harness driver itself. See [harness drivers](harness-drivers.md) for caller-bound Codex dispatch; Claude remains unavailable.

The shared `loadUserConfig({ readFile, env })` reads PAD_USER_CONFIG, otherwise XDG_CONFIG_HOME/pad/user.v1.json, otherwise the platform config-home's pad/user.v1.json. Missing files use built-in defaults; invalid configuration fails closed. Closed `pad-user.v1` validation allows check-runner selection, secret-store names only, progress and attempt ceilings, and model policy. Engine backstops are 20, 1000 and 100; defaults are 3, 50 and 2. Model policy is subscription, local or local-fallback; routes come only from configuration. Examples contain placeholders, never personal values or secrets.

## Early invariants and exclusions

Invariant tests remain mandatory downstream in G8. `checks.invariantWhen` defaults to `g8`; `both` additionally runs invariant-test argv commands at the pinned revision before dispatch, parking `spec-invariants-failed` on failure. There is no g7-only mode. G7 does not implement G8 completion, gaps or retries. Ralph, loop-until-done, G6 and releases are unchanged.

## Model action map and limits

[Gap7SpecGate.tla](Gap7SpecGate.tla) models RunSkill as observeSpec plus private admission, Confirm as the human-confirmed pin, EarlyPass as required early test success, Dispatch as the guarded dispatch claim, and Edit as a changed pinned bundle/contract. GateGuard is the pre-act guard; CompleteGuard requires complete safe/unsafe evidence; DigestGuard enforces revision hashes; DeriveGuard binds dispatch to the checked stack; ConfirmGuard and ChartGuard bind optional chart confirmation; EarlyCheckGuard enforces both-mode tests.

The original model comments mention the older upstream invocation and generated chart; the approved model bytes are retained unchanged. Runtime follows the installed Pi adapter contract above. Abstract confirmation represents the reviewed bundle pin, including a chart only when declared. The bounded model proves neither filesystem atomicity, actual TLC subprocess behavior, source resolution, arbitrary models nor worker effects. Runtime tests and mutation controls must establish those separately.
