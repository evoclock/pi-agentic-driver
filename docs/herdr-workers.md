# Herdr workers

Use the guarded tools to start and talk to worker roles. No raw Herdr terminal commands are required.

## Start and communicate

`agentic_herdr_spawn_worker` checks the canonical repository, configured owner, model roster, workspace, pane and worktree lease. It starts one labelled tab. A partial start reports the observed state and is not retried or cleaned up automatically. It never splits the coordinator pane.

`agentic_herdr_communication` supports `list`, `get`, `prompt`, `submit`, `delivery`, `wait` and `read` for exactly Pi, Claude Code (`claude`), and Codex (`codex`) panes. An unnamed agent must resolve through a unique labeled tab and matching live pane, with the same trusted-repository check as a named Pi agent. A prompt returns a non-authorizing receipt immediately: delivered means the Herdr terminal queue accepted it, not that a model answered. `read` publishes only a validated marked report; an unmarked Claude/Codex terminal tail is not a report. `delivery` attributes a marked answer only to its own correlation line and handoff boundary; without that marker it stays delivered or unattributed, never answered. Claude/Codex terminal echo and report styles have not been verified live: their replies may stay `delivered` even after a response, pending verification on a real terminal. Unknown or unattributed results do not cause an automatic resend. The coordinator role cannot be targeted. Fixed arguments and `shell: false` keep the route narrow.

## Stop a stuck turn

`abort` targets only a validated non-coordinator Pi role's current turn. Use the Pi `turnId` from `get`'s `observation.abortTarget` and/or an active `toolCallId`, plus a bounded `reason`. A delivered receipt means the request was written, not that cancellation finished. Observe `get` or `read` later.

Workers need a fresh in-process listener capability. Installed workers without it fail closed with `abort_capability_unavailable`; this source change does not update those workers. `allowPiQueueRestore` defaults false: a pending Pi-internal queue refuses cancellation unless restoring it to the editor is explicitly allowed. PAD delivery records and the lease are unchanged. Non-yielding native work cannot be preempted by any JavaScript listener, including Escape.

See the [abort design and statechart](state-machines/worker-abort/README.md) for the file channel, refusal codes, audit and verification scope.

## Worker code search

New Pi worker tabs use cancellable asgrep CLI Code Mode when an executable is available. `ASGREP_BIN` alone does not select that backend: the spawn also sets `ASGREP_CODEMODE_BACKEND=cli` and `ASGREP_TIMEOUT_MS=30000`. These values go through Herdr's tab `--env` arguments so the pane shell and its Pi process inherit them, not just the Herdr client. The coordinator's environment is unchanged.

PAD uses the installed `ast-sgrep` launcher's platform and checksum resolver, looking beside the active profile's `pi-ast-sgrep` installation and then beside PAD. It adds no dependency and contains no machine-specific binary path. An explicit binary override must be an executable file. Missing or unusable binaries leave today's backend behavior unchanged and add `asgrep_binary_unavailable` to the spawn result's `warnings`.

Before returning a spawn receipt, PAD tries `asgrep index <worker-root>` on the exact validated repository or leased worktree. This asynchronous child overlaps tab startup and Pi readiness, keeping index work off the coordinator's event loop. The receipt waits for completion before a caller can deliver its brief. A cold index can therefore add up to the configured index deadline to spawn latency; hosts that need immediate spawning can disable prewarming separately. The default deadline is 120000ms. At the deadline, the child receives `SIGKILL`; output is bounded. Failure or timeout adds `asgrep_index_failed` or `asgrep_index_timeout` but does not fail an otherwise valid spawn. This does not add an abort action or change an already-running worker.

Host configuration is read at each spawn. Set these environment variables on the process running PAD:

| Variable | Default | Effect |
| --- | --- | --- |
| `PAD_WORKER_ASGREP` | on | `off`, `false`, or `0` disables all injected settings and prewarming. |
| `PAD_WORKER_ASGREP_BIN` | installed platform binary | Override executable; inherited `ASGREP_BIN` is also accepted. |
| `PAD_WORKER_ASGREP_BACKEND` | cli | `napi` explicitly restores the in-process backend. |
| `PAD_WORKER_ASGREP_TIMEOUT_MS` | 30000 | Worker call deadline; inherited `ASGREP_TIMEOUT_MS` is also accepted. |
| `PAD_WORKER_ASGREP_PREWARM` | on | `off`, `false`, or `0` skips indexing only. |
| `PAD_WORKER_ASGREP_INDEX_TIMEOUT_MS` | 120000 | Index child deadline. |

Timeouts must be integer milliseconds from 1 through 300000; invalid values use the defaults, never an unbounded wait. Trusted hosts can pass `options.asgrep=false`, or an object with `enabled`, `binary`, `backend`, `timeoutMs`, `prewarm`, and `indexTimeoutMs`. Object fields override their environment equivalents. These are host options, not additional model-authored tool parameters. The same settings apply to the attended host spawn boundary.

## Close a finished tab

Call `agentic_herdr_close_tab` with `tabId` and a short, non-sensitive `reason`. It closes one single-pane tab with the caller's observed role label, or whose Pi agent is observed `done` or `idle`. Conflicting pane roles are refused.

Close supports only this machine's default Herdr 0.9.1 server. It matches the trusted CLI's socket/session/version/protocol observations with the local socket listener's ownership, process start and trusted executable image. Inherited routing and configuration overrides are ignored. Named sessions, remote machines, attached clients, forwarded sockets and uncertain identities are refused.

The caller tab, coordinator tabs, workspaces labelled `protected`, `protected-*`, `coordinator` or `coordinator-*`, and the last tab of **any** workspace are refused. Repeated safety observations precede one exact `tab close <scoped-id>` call. There are no server commands, pane-close fallback or retries. Success checks tab disappearance and the unchanged local server.

Attempts append one record, at most 4096 bytes, to `$PI_HOME/agentic-driver-herdr/close-attempts.jsonl`: caller role, tab/pane, host/server identity, reason, ISO time and `closed`, `refused:<code>` or `failed:<code>`. Early identity fields can be null. Prompts, environment and diagnostics are not copied. An unavailable audit sink refuses before close; `audit_write_failed` reports whether close was dispatched.

**Limit:** Herdr has no atomic conditional close. Concurrent external changes can invalidate the last-tab check before close. This draft is fixture-verified, not live-close certified. The listener check requires the trusted real binary followed by `server`.

### Close behavior evidence

Read-only inspection of [Herdr v0.9.1](https://github.com/herdrdev/herdr/tree/v0.9.1), not live experiments:

- [`src/cli/tab.rs`](https://github.com/herdrdev/herdr/blob/v0.9.1/src/cli/tab.rs) accepts exactly `tab close <tab_id>`; `src/cli/runtime.rs` sends `tab.close`.
- [`src/app/api/tabs.rs`](https://github.com/herdrdev/herdr/blob/v0.9.1/src/app/api/tabs.rs) closes the entire workspace when its last tab closes. This is a wider effect than removing one tab; it does not by itself prove the reported server shutdown's cause.
- [`src/session.rs`](https://github.com/herdrdev/herdr/blob/v0.9.1/src/session.rs) and `src/server/socket_paths.rs` show socket/session environment routing. `src/cli/target.rs` can route API commands through an SSH machine bridge.
- [`src/cli/status.rs`](https://github.com/herdrdev/herdr/blob/v0.9.1/src/cli/status.rs) reports socket, session, version and protocol, but no authenticated host/PID. Local socket-listener verification supplements that observation; a socket pathname alone is not locality evidence.

## Bounded dispatch

`agentic_worker_dispatch` has `pulse` for worker liveness, `dispatch` for a bounded session-task journey, and `journeys` for read-only journey records. A dispatch runs one exchange per task, at most `maxSteps` (default 50, cap 200). Continuous mode is the default; turn-by-turn stops after each exchange. It does not claim or complete board cards. A stuck worker ends the journey; replacement starts through the guarded lifecycle route, without resending the stuck exchange.

`/loop-until-done <steps> <goal> :: <exit check>` gives an already-authorized session task a bounded allowance. The default is 200 attempts or 30 minutes, whichever comes first. Every attempt consumes one step before dispatch. Each wake checks the original exit condition. One session's allowance cannot be restarted or extended. Board cards stay with Board Pulse.

See [durable persistence](durable-persistence.md) for checkpoints and recovery. A report is evidence, not approval or completion.
