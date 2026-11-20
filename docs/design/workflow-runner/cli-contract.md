# External bot ↔ PAD workflow runner contract

Status: **target contract**, not a claim that every command/tool is registered. External bot means bots on the Mac mini invoking Pi + PAD; it is **not** a separate host repository. This draft core branch registers five Pi tools and provides a one-event `run --workflow FILE --run-id ID --event FILE --store DIR` CLI and private core library. Neither surface implements the full command set below. Activation must fail visibly for unsupported operations until each surface has the same semantics. No PAD package version is hard-coded.

## One core, three surfaces

| Surface | Target entry | Current status |
| --- | --- | --- |
| CLI | `pad-runner run --workflow <file> --repo <trusted-root> --task <id> --state-dir <dir> --json`; `status`, `tick`, `cancel`, `resume`, `handbrake on|off` share `--repo --task --state-dir --json`. | Draft one-event `run` only; no aliases that pretend absent operations exist. |
| Pi tools | `agentic_workflow_run`, `_status`, `_tick`, `_cancel`, `_handbrake`; params mirror the CLI flags. Tool registration lives in PAD, with no raw Herdr CLI. | Registered in this draft; owner-confirmed cancel/hold, read-only status and bounded tick, but no worker dispatch or recovery adapter. |
| Library | Export `decide(snapshot, verifiedEvent)` and a durable transition service from PAD's workflow core. All three surfaces call the **same** validation and persistence. | Draft core PR #198 has private `decide`, `transition`, `run`; no stable public entry exists here. `scripts/enforcement/durable_driver_pi.js:43` `openDurableDriver({directory})` and `agentic-driver.run.v1` provide useful transactions/flight tracking but are Pi/pi-durable-coupled and do **not** provide step receipts or this CLI contract. Adapt them only if their store and fencing fit; they are not the harness-neutral core. |

`skills/workflow-runner/SKILL.md` explains the draft recipe and point bots to these exact operations. Until the Pi tools, skill and CLI are packaged and proven on a fresh installed process, External bot must report `capability-unavailable` rather than emulate it by shell calls or opaque prompts.

## Closed operations

- `run` validates approved task scope, canonical root, exact skill refs, frozen workflow digest, bounded attempts and a task-specific TLC proof, then creates exclusive durable state. It **does not** execute a tool or infer approval from a task card. Return one decision `act|advance|wait|settled` and a stable `runId`.
- `status` is read-only. Return the committed snapshot plus bounded references to `receipts.jsonl`, `transitions.jsonl` and `summary.json`; no automatic wake or writes.
- `tick` consumes **one** independently verified event and commits at most one move. Repeating the same event ID and bytes returns the original result; changed bytes under the ID fail with `event-conflict`.
- `cancel` commits a new epoch and fences every late result; `resume` checks that the task remains eligible and reconciles uncertain intent before any act. It is not a replay or budget reset.
- `handbrake on` commits a hold/new epoch. `handbrake off` requires the same trusted actor/scope and a fresh observation, never a model-generated "yes". While held, no effect or graph advance occurs.

No command reads interactive stdin, asks an approval question, merges, grants authority, installs software or spins a timer loop. Output is one bounded JSON object and an exit code. The target exit mapping is `0` = durable usable result (including parked/held), `2` = invalid/conflicting input, `3` = capability/store/verification unavailable, `4` = uncertain effect requiring reconciliation. **The draft CLI does not implement exit codes 3 or 4: every error exits 2.** A returned parked/uncertain result is not permission to retry an effect; exact target CLI parsing and exit mapping remain unimplemented.

## Event and receipt JSON-lines

Persist each accepted event once in `transitions.jsonl`, and only checked step receipts in `receipts.jsonl`. Both are append-only. Event IDs are unique per task across all runs, revisions and epochs; an exact replay returns its **original** decision. Attempts are keyed by task and step, independent of epoch. `summary.json` is a rebuildable snapshot; journal fsync precedes a returned decision. No bot-controlled path may select or escape the configured private state root outside the worktree. The demo may explicitly use `~/.local/share/pad-runner-demo/<run-id>/` when that root is trusted and configured; today's draft core instead requires `<repo>/.local/workflow-runner/`.

```json
{"schema":"pad-workflow-event.v1","eventId":"evt-1","runId":"task-1","workflowDigest":"<sha256>","stepId":"docs","epoch":0,"actor":"<trusted observed actor>","writerId":"<fenced writer id>","kind":"commit|pr-state|worker-report|tick|cancel|hold|resume","sourceRef":"<trusted adapter reference>","observedAt":"<ISO-8601>"}
```

```json
{"schema":"pad-skill-receipt.v1","eventId":"evt-1","runId":"task-1","stepId":"docs","dispatchId":"<persisted effect id>","dispatchEpoch":0,"dispatchWriter":"<fenced writer id>","branch":"<frozen branch>","epoch":0,"skill":{"pack":"<name>","version":"<installed version>","path":"<repo-relative>","contentSha256":"<sha256>","procedureStepIds":["check"]},"stepBaseHead":"<40-hex SHA at dispatch>","artifactCommit":"<40-hex SHA>","observedCheck":"<trusted check id>","evidenceRef":"<bounded readback id>","procedureVerified":false}
```

A `delivered` prompt, checked file digest or worker report alone is not a proven procedure. The receipt verifier binds the dispatch ID, dispatch-time epoch/writer, frozen branch, dispatch-time `stepBaseHead` and exact descendant commit to the persisted effect and independently observed check/readback. Event `actor` and `writerId` must come from trusted observations and match the fenced writer; caller-supplied strings alone grant no authority. A result stamped with current receive-time epoch/writer after transfer or hold is not attributable to the old dispatch. `procedureVerified` stays false until a trusted task-bound verifier proves execution of the declared steps; unsupported proof leaves the step unresolved. A task graph must record its own statechart-pi `.tla`/`.cfg`, bounds, TLC no-error output, checker version and SHA; an unvalidated or edited graph cannot activate. A generic two-step lifecycle model is not proof of a specific task graph. A poteto-mode step references the installed skill pack/version/content and procedure-step IDs; never auto-select unpinned skill bytes.

## G7 spec host event

Worker workflows now require a pinned `spec` reference and a passing host gate before the first act. CLI run accepts `{ "id": "<EVENT_ID>", "type": "spec" }` only when cwd equals workflow.repo. Pi `agentic_workflow_gate` accepts only that public event and runs the same observer in the trusted checkout. Both reject caller-issued `_spec`; private host observations bind task, epoch, writer, contract and manifest digests. Duplicate completed gate events replay their stored answer without running the checker again. An interrupted claimed check parks rather than silently retrying.

The source registry resolves the installed statechart-pi adapter. The caller supplies PATH containing Java and TLA2TOOLS_JAR selecting an existing jar. PAD stages pinned Git bytes under `<WORKTREE>/.scratch/workflow-runner/spec/<EVIDENCE_ID>/`, invokes `node <RESOLVED_SKILL>/scripts/run-tlc.mjs --check`, then `--spec <MODULE> --config <CFG> --out <NEW_OUTPUT_DIR>`. No path to Java, jar or installed skill is hardcoded. No installation, upstream CLI or alternate TLC implementation is used. A chart is optional and integrity-checked only when declared. See [spec-gate.md](spec-gate.md) for the manifest, reason codes, limits and model correspondence.

Model policy comes from local `pad-user.v1` configuration. Conservative local-fallback selects localRoute only after a check before spawn proves the configured route is unavailable, before the effect claim. Spawn attempts, refusals without verified no-effect evidence, partial outcomes and lost replies never cause fallback. This remains an open design point for review. G8 completion checks and additional harness drivers are not implemented here.

## Library-only logical ownership

The private core accepts `release-ownership`, `transfer-ownership` and `reconcile-old` only through trusted host adapters. Caller assertions cannot approve controls or terminal readback. These events remain unavailable on CLI/Pi. See [the adapter contract, model and limits](ownership-model-evidence.md). Ownership release is distinct from handbrake-off; the per-event filesystem lock is unchanged.

## Wake and crash recovery

External bot subscribes to **verified** commit, PR state and attributable worker-report changes and submits exactly one event/tick for a new transition ID. Looks are counted separately from action attempts. If no new evidence arrives, `wait` parks; a usage-limit pause does not spend a try. Reopen reconstructs from the durable journal, fences old writer epochs and reconciles an uncertain dispatch by exact readback; an unknown readback parks and cannot spend another attempt. A present effect with lost acknowledgement resumes its wait without resending. After owner release or writer transfer, only a trusted terminal readback of the old effect permits a fresh dispatch under the new epoch/writer within the remaining budget; otherwise it stays parked. **These are target behaviours, not current CLI/Pi capabilities:** neither draft surface has a trusted ack or readback adapter, so an interrupted dispatch cannot get a second attempt through either surface; CLI/Pi Release, Transfer and ReconcileOld are not implemented. No automatic resend. Cancellation and handbrake supersede pending wake/result admission. On a missing event subscription, report `wake-unavailable`; a manual timer may observe status but must not manufacture evidence.

## External bot hookup (pending D2 findings)

External bot on the Mac mini uses `$PI_HOME/pi` and the normal floating npm source. Once a reviewed runner is **released** and a normal `pi update` has picked it up, an external bot loads `skills/workflow-runner/SKILL.md`, calls PAD's Pi `agentic_workflow_run`, then `_tick` on verified transitions and `_status` for readback; cancellation/hold use their named tools. No pin is requested. If only the CLI is present, `pad-runner run ... --json` is the explicit non-interactive alternative, not an invisible Pi prompt. D2 must confirm the installed package, grant scope and quiet-host window before a mini demo; this document does not start that demo.

## Deferred

PAD MCP server for other driver clients. A later conformance kit and rich outbox are not prerequisites for documenting this boundary.

## Changelog

- First published follow-up after draft core PR: specifies the unified CLI/Pi-tool/library contract; labels unregistered commands and installed-host work as pending, without changing the package version.
