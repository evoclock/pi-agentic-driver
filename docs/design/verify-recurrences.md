# Reusable review verification

## Scope and status

This first series adds a repository preflight, vocabulary rules, negative-control inventory, isolated required-TLC helper, boundary tables and review guidance. Pipeline wiring remains a proposal. Twelve append-only focused mutation contracts follow the reviewed `skills/test-gate/SKILL.md` workflow step 3, as explicitly clarified in the follow-up coordinator steer. The initial mutation-entry exclusion is superseded only for this PR's own new keys; inherited entries, caps and rationales remain unchanged. This is not a claim that every historical defect is fixed.

Run `make preflight` with working `JAVA` and `TLA2TOOLS_JAR` (or `TLA2TOOLS`). The preflight fetches main, requires its ancestry, checks added committed lines, calls the native gate's `preserve_test_tokens`, executes registered safe and negative configurations, and runs focused tests. It does not acquire or alter the official gate lock. PR title/body checking is explicit: `node scripts/owner_terms_lint.mjs --base origin/main --title "$TITLE" --body-file "$BODY"`.

Before every push, acquire the shared test-gate lock through its normal mechanism and run `python3 scripts/test_gate_runner.py --phase check`; do not push past a BLOCKED result.

The token adapter is intentionally conservative: it checks all inherited test tokens using the native implementation. A valid test-runner refactor can therefore be blocked too. No custom relaxation is substituted.

## Decision record

Options were required isolated checking with the native token check, copied token-check logic, permissive missing-tool skips, and hold. `review-preflight/ReviewPreflight.tla` models those choices with optional checker availability and token preservation. Three guarded invariants require a checker, the native route, and preserved frozen tokens before success. Hold never passes verification. The selected option is the required checker plus native adapter; copied logic and skips fail the corresponding negative configuration.

The installed `statechart-pi` adapter checked the safe model in scratch. The shared TLC runner checked the safe configuration and all three unsafe controls. The model abstracts checker presence and token preservation as Booleans; it does not prove that Python tokenization, Git, the adapter, or arbitrary code is correct. Tests exercise those boundaries separately. No generated diagram is claimed.

Legacy `test_skill_shape.mjs` still has its existing TLC runner. Its migration is held rather than removing inherited test tokens under a purported read-only check. The new preflight always runs the required shared helper first, supplies both jar aliases, then runs the unchanged legacy assertions. Standalone legacy execution can still skip; this is an explicit remaining limitation, not completed migration.

## Verification evidence

Initial baseline: generic scan reported zero violations; skill shape had two passes and one explicit TLC skip before configuring the requested environment.

Tests were authored before implementation. Each initial suite failed through an explicit feature-presence assertion, not an import crash:

| Suite | Initial assertion failures | Local log |
|---|---:|---|
| Owner terms | 2 | `.scratch/owner-terms-red.log` |
| Required TLC helper | 2 | `.scratch/tlc-helper-red.log` |
| Model inventory | 3 | `.scratch/model-controls-red.log` |
| Boundary classes | 2 | `.scratch/boundary-red.log` |
| Preflight | 2 | `.scratch/preflight-red.log` |
| Review guidance | 1 | `.scratch/review-ready-red.log` |
| Monotonic allowlist | 1 | `.scratch/allowlist-monotonic-red.log` |

Later table extensions exercise the actual user-config numeric validator and file reader. FIFO tests run in bounded children. The 80 directive/whitespace combinations exercise the new inventory parser, not the separate workflow spec parser. New negative controls must produce the named invariant violation with exit 12, or a registered temporal-property violation with exit 13. Listing an invariant in a configuration is not coverage.

Local logs are ignored observations, not official gate evidence. `.scratch/verify-recurrences-green.log` records the focused test run. `.scratch/negative-controls-tlc.jsonlog` contains complete TLC output. `review-preflight/tlc-results.v1.json` is a sanitized summary, not a substitute for rerunning TLC. All model runs use one worker, a fresh scratch copy and an explicit metadata directory. Repository status is compared before and after execution; an already dirty checkout is allowed, newly created source artifacts are not.

Reproduce model results with `JAVA` and the jar configured, then `TLC_REQUIRED=1 node scripts/model_negative_controls.mjs --run`. The invocation is `"$JAVA" -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers 1 -metadir "$SCRATCH/meta" -config "$CFG" "$MODEL"`, inside a fresh model-directory copy. Each configuration has its own fresh copy. The statechart adapter separately reported `checked-no-errors` for the safe decision model.

## Fresh-lease decision

`review-preflight/LeaseBaseline.tla` compares fresh-lease rebaseline with hold. The invariant `LockCoversCheckedConfiguration` requires the checked configuration to match its recorded lock. The installed statechart adapter checked the safe config without errors; the unsafe config exited 12 on that invariant (8 generated, 7 distinct states). The selected route preserves earlier locked evidence and installs final contracts before the native baseline in a fresh Treehouse lease. Hold does not execute checks. The model abstracts configuration identity; it is not proof of the host implementation or authority.

The required helper mutant uses the native `scriptEnv` route because its target is a test helper, not production-classified code. The direct token-adapter test exercises its subprocess; checking the native function alone would not kill an adapter that omits the call. Readiness checking now runs before baseline and in review preflight, using native configuration loading, production-path classification and suite validation.

## Historical follow-up observations (superseded by the latest verification below)

An official local check returned exit 3: `changed production code has only inherited entries; add a focused mutation contract for this change`. The subsequent clarified scope permits append-only focused entries through workflow step 3. Existing entries, caps and rationales remain unchanged. The original block is not a passing test gate.

The local full gate also exposed a real packaging defect: review-ready referenced an unbundled statechart skill without an absent-tool fallback. The unchanged dependency test failed before the fix (`.scratch/230-dependency-red.log`). Guidance now uses the existing decision-gate manual-model fallback while keeping TLC mandatory. Preflight runs that dependency test too. That earlier focused follow-up run had 24 passes with no failures or skips (`.scratch/230-fix-focused.log`); preflight is OK (`.scratch/230-fix-preflight.log`).

Those earlier full-gate runs failed because of missing tools and the inherited-only mutation block. Build #587 subsequently passed at head `110b66d`; its local native check also passed. These historical failures are not the current verification result.

## Latest vocabulary-boundary verification

The recurrence conformance was proven red through the native baseline against `6846c1a` before removing exclusions: both new tests failed with zero errors. The official baseline and complete native check then passed all 111 contracts against main `98009d0`; all 110 earlier entries remained unchanged. The tests-path bypass mutant was killed by an assertion failure with zero errors. Full local `make gate` passed without environment exceptions.

The owner-term lint reports zero hits over the complete `git diff origin/main...HEAD` added-line set, including fixtures. A direct AST/runtime comparison confirms the original three negative spellings, four allowed values and Pi naming value are byte-identical. Sanitized evidence: `review-preflight/terms-boundary-verification.v1.json`. Logs: `.scratch/terms-native-red.log`, `.scratch/terms-main-native-check.log`, `.scratch/terms-full-gate.log`, `.scratch/terms-all-added-lines.log`, `.scratch/terms-runtime-equivalence.log`.

## Owner-vocabulary recurrence follow-up

Review found that exempting the owner-lint test file let added fixture source violate the same wording boundary previously found in #227. Both rules now have empty exclusion lists: tests, fixtures and config lines receive the same enforcement. Independent checks prove the current patterns do not match their raw config source, so a config self-exclusion is unnecessary and none remains.

The original forbidden negative-case runtime strings and detection assertions remain unchanged; source code constructs those values from fragments. The old assertion permitting a genuine violation at the config path is strengthened to require detection because that exemption is removed. A new conformance suite passes literal runtime fixture lines through the real added-line parser using the formerly excluded test path and a tests/fixtures path. Native fail-first against `6846c1a` proves the exclusion bug before the rule change.

The full owner-term check must scan all added lines from `origin/main...HEAD`, not only the latest delta. A new append-only native mutation verifies that adding a tests-path skip is detected by the conformance suite. No exception or negative-case deletion substitutes for enforcement.

## Verification at 6846c1a (historical)

All five original Low findings are addressed. The complete native test gate passed all 110 mutation contracts against main `98009d0`; the full local gate passed without missing-tool exceptions. The two new parser controls were killed by assertion failures with zero errors, while all 108 earlier contracts remained unchanged and passed. Sanitized fail-first and mutation results: `review-preflight/parser-verification.v1.json`.

Native red evidence against the previously green parser: `.scratch/parser-native-red.log`. Official baseline/check and full gate: `.scratch/parser-main-baseline.log`, `.scratch/parser-main-native-check.log`, `.scratch/parser-full-gate.log`. Earlier verification sections below describe earlier heads, not the current result.

## Parser boundary and comment follow-up

Directive recognition now uses whole identifier tokens instead of splitting at keyword substrings. The exact regressions preserve `MaxINITLen` and `NoVIEWLeak`, including the later `B` obligation. Joined identifiers such as `SafeCONSTRAINT` are names, not directives. The 80-form table retains all whitespace cases and now explicitly checks the 16 no-separator cases as joined identifiers.

Before token recognition, a small scanner removes line and block comments, including multiline and nested blocks, without interpreting comment bytes inside quoted values. Unterminated block comments fail closed. New regressions were proven red through the native baseline against the previously green `a5ca1e3` before implementation, not merely through a missing module. Tests and final append-only controls were in place before that lock was taken.

## Zero-gap verification at a5ca1e3 (historical)

The follow-up native baseline and complete test gate passed against main `98009d0`: all 108 contracts ran, including three new controls for missing tools, property identity and preserving the primary error. The full local `make gate` also passed, including Janus types/tests, hash-allowances and no-hidden-installs. No missing-tool exception was used. The native Buildkite-only precommit check remains CI-owned, not a missing local tool.

Dependencies were installed exactly with `sfw npm ci --ignore-scripts --no-audit --no-fund` and the same command with `--prefix janus`. Both dependency directories are real local installs. Neither manifest nor lockfile changed in this follow-up. Logs: `.scratch/zero-gap-baseline.log`, `.scratch/zero-gap-native-check.log`, `.scratch/zero-gap-full-gate.log`. Sanitized outcomes: `review-preflight/zero-gap-verification.v1.json`.

Temporal controls now require the expected named property diagnostic plus exit 13; an unlabelled temporal failure is rejected rather than attributed speculatively. No temporal property control is currently registered. Repository-status cleanup preserves the original error and aggregates any additional status failure with that error as its cause. The subsequent parser follow-up also fixes the remaining directive-boundary and block-comment items; all five original Low findings are now addressed.

## Native contract verification at 110b66d (historical)

After merging current main with `--no-ff`, the final configuration was recorded by a fresh native baseline against `343bf68`. The complete native check passed: all 105 contracts ran, including the six new keys. Every new mutant produced assertion failures with zero errors, and its unmutated suite passed. Sanitized counts are in `review-preflight/native-mutations.v1.json`; original host evidence and older locks remain unchanged in their verification checkouts. No refresh or lock edit was used.

The `110b66d` local full-gate run still lacked Janus tools, despite green Buildkite #587. That result did not meet the clarified zero-gap local bar. The current follow-up uses real root and Janus installs via Socket Firewall, without changing either manifest or lockfile, and requires every local gate check to pass. `scripts/review_gate_tools.mjs` now rejects missing local gate executables and local Buildkite-host tools before expensive checks. Provisioned Linux-only observability tools are checked on their own CI host, not represented as local installations.

## Finding map

| Finding | Check or explicit remaining work |
|---|---|
| F1 | `tests/test_boundary_classes.mjs` replays absent, empty and whitespace credential values with injected file fallback. CredentialLookup model remains deferred. |
| F2 | Partial credential-store names remain covered by inherited user-config tests; exhaustive credential vectors remain deferred with M1. |
| F3 | `scripts/model_negative_controls.mjs` enforces named model controls, not arbitrary production mutations. Five production guard mutants still need audited contract proposals. |
| F4 | Explicit-file versus broken-config precedence is covered by inherited #229 code/tests. Exhaustive M1 conformance remains deferred. |
| F5 | Absolute executable selection is covered by inherited #229 code/tests. Exhaustive M1 conformance remains deferred. |
| F6 | Opt-in local platform check only; no live credential-store access performed. |
| F7 | Inherited documentation coverage; scheduler/migration documentation is outside this series. |
| F8 | Numeric table drives actual user-config attempts validation/clamping and rejects reversed progress limits. |
| F9 | Both prerequisite PRs have merged; Gap7Claim liveness and reducer conformance remain deferred under the bounded first-series scope. |
| F10 | Seven inherited Gap7SpecGate model controls now run with named outcomes. Production guard mutations remain separate audited proposals. |
| F11 | Bounded child table tests reject FIFO, symlink, directory, device and oversized JSON configuration paths. |
| F12 | Numeric table exists; application to invariant-check timeouts remains deferred with parser/claim conformance work. |
| F13 | Eighty combinations test the inventory parser. Its prerequisite has merged; applying the harness to the workflow spec parser remains deferred under the first-series scope. |
| F14 | `tests/helpers/boundary_classes.mjs` creates its scratch parent itself. |
| F15 | `scripts/owner_terms_lint.mjs` checks the prohibited before-spawn shorthand in added lines and supplied PR text. |
| F16 | Existing decision-gate registration assertion remains unchanged; review-ready honestly uses behavior kind. |
| F17 | Terms rule rejects the incorrect Pi skill spelling; review-ready requires `statechart-pi`. |
| F18 | `tests/helpers/tlc.mjs` uses fresh scratch copies and metadata directories; negative-control execution checks repository status unchanged. |
| F19 | DecisionGate's three behavioral invariants have individually executed negative configurations. TypeOK remains an explicit historical exception. |
| F20 | Per-rule exclusions and exact-token tests live in owner terms config and tests. |
| F21 | Review-ready requires observed logs. A deterministic PR claim lint remains deferred; prose guidance is not enforcement. |
| F22 | `scripts/review_test_tokens.py` calls the native preservation function; preflight reports BLOCKED rather than altering locked inputs. |
| F23 | Preflight fetches main and rejects stale ancestry before running expensive checks. A real scratch-repository test covers the stale branch. |

## Root causes and proposals

- RC1: Missing behavioral models remain visible: M1 and M2 are not silently represented as complete.
- RC2: Named model-control metadata is executable; exhaustive model-to-production conformance is deferred.
- RC3: Required TLC fails on missing Java/jar. Safe runs and named negative results are both required for registered controls.
- RC4: Shared string, numeric and filesystem tables replace scattered ad hoc fixture creation.
- RC5: Two approved vocabulary rules have dated references and explicit per-rule exclusions.
- RC6: Stale-main rejection happens before model and test execution. Main was merged with `--no-ff` during this series after that check correctly blocked.

The historical allowlist enumerates missing obligations, not blanket passing coverage. New models fail unless covered. Once this initial inventory is merged, the allowlist may only shrink relative to main; covered obligations cannot stay listed. Existing unsafe files without individually attributed results are not guessed to cover every invariant.

Proposals requiring separate review: run preflight first in Buildkite; add audited production guard mutation contracts for F3/F10; migrate the legacy TLC test through the sanctioned gate mechanism; enforce PR-body evidence claims with a separately tested lint. No pipeline, gate-rule or frozen output files are changed by this series relative to main; mutation registration only adds twelve reviewed keys without altering inherited entries, caps or rationales.

CredentialLookup is independent of the open claim/parser work but is not cheap: it needs an exhaustive vector generator and exposes existing source-order and executable-resolution discrepancies. It is deferred rather than adding a second model and production behavior change to this bounded series. Both prerequisites are now merged; Gap7Claim remains deferred under this PR's explicitly bounded first-series scope.
