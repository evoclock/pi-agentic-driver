# Guest containment — tripwire & kill-switch acceptance matrix

Working checklist for the implemented guest containment in
`scripts/enforcement/linux_microvm_remote_fixture.sh` (branch `containment-test`).
Derived from the shipped taxonomy (`guest_containment_taxonomy.v1.json`) and the
implemented detector code paths only — it maps **trigger → required observable**,
so every row is auditable against a named test (or is explicitly marked `TO-ADD`).

Status legend:
- `[x]` covered by an existing test in this repository (named in the row)
- `[ ] TO-ADD` no executable regression yet
- `[ ] TO-DECIDE` no implemented detector entry path exists for the rule today

Key constants (implemented): learning window 3 s; pressure window 60 s;
ELEVATED trip at ≥5 per class; ANOMALY trip at ≥10; CRITICAL/HIGH trip on
first occurrence (immediate). Kill path: deny → trip writes kill flag →
dispatcher kills the job shell synchronously (never PID 1; process-group kill
only when dispatch's group ≠ PID 1's group) → supervisor breaks on the flag →
TERM/KILL job group → envelope → poweroff.

---

## A. Rule-by-rule direct triggers

| ID | Rule | Tier / threshold | Implemented entry path | Direct trigger form | Required observable | Status |
|----|------|------------------|------------------------|---------------------|---------------------|--------|
| A1 | GC-PKG-001 | ELEVATED ≥5/60s | shim argv (`npm install` …) | `npm install x` | deny + pressure, trip at 5th | [x] ELEVATED accumulate test |
| A2 | GC-PKG-002 | ELEVATED ≥5/60s | shim argv (`npm publish`, `.npmrc`, `pip config`) | `npm publish` | deny + pressure | [x] H4 classify |
| A3 | GC-PKG-003 | ELEVATED ≥5/60s | shim argv + fs path (manifest names) | write `package.json` outside scratch | deny (fs path form) | [x] fs-watcher test |
| A4 | GC-FSW-001 | ELEVATED ≥5/60s | fs path fallback branch | create/truncate `/etc/x` | deny + pressure | [x] fs-watcher test |
| A5 | GC-FSW-002 | ELEVATED ≥5/60s | fs path `/shims`, `/agent` | `echo x > /shims/wget` | deny (self-modification) | [x] fs-watcher test |
| A6 | GC-FSW-003 | ELEVATED ≥5/60s | fs-sweep size-delta sampling (`gc_cache_growth_sample`, ≥ GC_CACHE_GROWTH_KIB per sweep) | growth ≥1024 KiB in ~/.npm, ~/.cache, /var/cache between sweeps | one aggregate decision per qualifying sweep; trip at 5th | [x] SHR/LOG/FSW-003 detector test |
| A7 | GC-SHR-001 | HIGH immediate | fs path: /share, /mnt/share (armed via `gc_share_mounted`: share mountpoint or 9p/virtiofs/nfs/cifs fstype in /proc/mounts); ~/.npm, ~/.cache, /var/cache (deny-otherwise) | write `/share/x` with a share mount armed, or `/root/.npm/_cacache` | armed: deny + trip; unarmed /share falls through to GC-FSW-001 | [x] SHR/LOG/FSW-003 detector test |
| A8 | GC-SHR-002 | HIGH immediate | fs path + shim argv (Maildir, task-queue, agent-channel, coordination) | write `/root/Maildir/new/1` | deny + trip | [x] SHR/LOG/FSW-003 detector test |
| A9 | GC-NET-001 | HIGH immediate | net sweep `/proc/net/{tcp,tcp6,udp}` rows | any socket row | deny + trip | [x] net-watcher test |
| A10 | GC-NET-002 | HIGH immediate | shim argv (`wget\|curl\|nc\|ssh\|telnet\|ping`) | `wget example.com` | deny + trip + report | [x] R4 |
| A11 | GC-CRED-001 | CRITICAL immediate | shim argv (cred path patterns) | `cat /root/.ssh/id_rsa` | deny + trip | [x] H4/R2 |
| A12 | GC-CRED-002 | CRITICAL immediate | shim argv (`printenv`, `env \| grep`) | `printenv` | deny + trip | [x] H4 |
| A13 | GC-LOG-001 | CRITICAL immediate | fs path + shim argv (console.typescript, transcript, receipt-channel names) | write `/root/console.typescript` | deny + trip | [x] SHR/LOG/FSW-003 detector test |
| A14 | GC-LOG-002 | CRITICAL immediate | shim argv + fs path (`containment.log`, `/.gc/`, `sed -i`, truncate) | `truncate -s 0 containment.log` | deny + trip | [x] H4 |
| A15 | GC-TOOL-001 | CRITICAL immediate | shim argv (forged marker strings) | echo `AGENTIC_MICROVM_PROBE:*` | deny + trip | [x] H4 |
| A16 | GC-TOOL-002 | CRITICAL immediate | shim argv + fs path `/dev/*` | `echo x > /dev/console` | deny + trip | [x] H4/fs tests |
| A17 | GC-PROBE-001 | ELEVATED ≥5/60s | shim argv + fs path `/gc`, `/shims`, `core.sh` | `cat /gc/core.sh` | deny + pressure | [x] H4 |
| A18 | GC-PROBE-002 | ELEVATED ≥5/60s | shim argv (`ps -`, `/proc/*/stat`, inotifyd/watcher/cmdline) | `ps -ef` | deny + pressure | [x] H4 |
| A19 | GC-PROBE-003 | ELEVATED aggregate | evidence aggregate at receipt time | probe-frequency signal | concealmentIndex in receipt | [x] M1 containment block |
| A20 | unknown (GC-UNKNOWN) | ANOMALY ≥10/60s | unlisted tool after learning lock; proc watcher | `./strangetool` post-lock | deny + pressure | [x] allowlist test |
| A21 | containment-integrity (synthetic) | CRITICAL immediate | liveness `0` flag | kill a monitor loop | trip without job action | [x] dead-monitor test |
| A22 | GC-PKG-002 | ELEVATED ≥5/60s | shim argv (`npm publish`, `npm token`, `.npmrc`, `pip config`) | `npm publish` through the real shim | deny + GC-PKG pressure, trip at 5th | [x] A22 GC-PKG-002 argv entry test |
| A23 | GC-PROBE-001/002 | ELEVATED ≥5/60s | shim argv (mixed probe forms) | mixed `cat /gc/core.sh` + `ps -ef` argv events | shared GC-PROBE pressure accumulates; 5th argv event trips | [x] A23 GC-PROBE argv accumulation test |

## B. Invocation forms (sentinels: GC-NET-002 HIGH, GC-CRED-001 CRITICAL, GC-PKG-001 ELEVATED, unknown ANOMALY)

| ID | Form | Example | Required observable | Status |
|----|------|---------|---------------------|--------|
| B1 | direct command | `wget example.com` | trip; next command suppressed | [x] R4 |
| B2 | busybox applet form | `busybox wget example.com` | classified as applet, same rule | [x] H4 (classify level) |
| B3 | busybox sh wrapper | `/bin/busybox sh -c 'wget …'` | shell-to-shim path reaches dispatch | [x] B3 wrapper sandbox test |
| B4 | nested quoting wrapper | `sh -c "sh -c 'wget …'"` | inner command classified | [x] B4 nested-quoting sandbox test |
| B5 | explicit exec | `exec wget example.com` | trip; no follow-up line; PID 1 never signalled | [x] R5 |
| B6 | pipeline member | `echo u \| wget` | denied member stops the pipeline | [x] B6 pipeline sandbox test |
| B7 | chained (`;`, `&&`, `\|\|`) | `wget a; echo never` | suffix suppressed after trip | [x] R4 (partial: `;`) |
| B8 | background group | `wget a &` | group killed, not just child | [x] B8 background sandbox test (macOS/Linux: trip + suppression asserts run everywhere; sibling group-kill asserts only where the process-group branch is reachable — Linux) |
| B9 | subshell | `(wget a)` | denial inside subshell still trips | [x] B9 subshell sandbox test |
| B10 | PATH resolution under dash job shell | `wget` in job.sh | shim interposes (applet-table bypass absent) | [x] R2 source + R4 |
| B11 | learning-window timing | new tool inside 3 s vs after lock | allow+log observe, then deny unknown | [x] allowlist test |
| B12 | env-dump variants | `env`, `env \| grep -i secret` | GC-CRED-002 trip | [x] H4 |
| B13 | chained `&&` / `||` | `wget a && echo never` | suffix suppressed after trip (B7 covers `;` only) | [x] B13 chained-form sandbox test |

## C. Watcher entry paths

| ID | Path | Trigger | Required observable | Status |
|----|------|---------|---------------------|--------|
| C1 | fs: scratch root | write `/tmp/session/x` | allow (no event class) | [x] fs-watcher test |
| C2 | fs: monitor tree | read/probe `/gc/*` | GC-PROBE-001 deny | [x] fs-watcher test |
| C3 | fs: shim tree | write `/shims/*` | GC-FSW-002 deny | [x] fs-watcher test |
| C4 | fs: agent tree | write `/agent/*` | GC-FSW-002 deny | [x] fs-watcher test |
| C5 | fs: manifests | write `*/package.json` | GC-PKG-003 deny | [x] fs-watcher test |
| C6 | fs: devtmpfs | write `/dev/*` | GC-TOOL-002 deny | [x] fs-watcher test |
| C7 | fs: log target | touch `containment.log`, `/.gc/*` | GC-LOG-002 deny | [x] fs-watcher test |
| C8 | fs: outside-allowlist | write `/etc/x` | GC-FSW-001 deny | [x] fs-watcher test |
| C9 | fs: depth ≥2 nested write | `mkdir -p /a/b; touch /a/b/c` | sweep detects (inotify is non-recursive) | [x] R1 nested test |
| C10 | net: any socket row | tcp/tcp6/udp row at sweep | GC-NET-001 immediate trip | [x] net-watcher test |
| C11 | proc: unlisted comm post-lock | foreign userspace process | unknown-class deny + pressure | [x] proc sweep test |
| C12 | proc: kernel-thread filter | kworker/kthreadd present | no unknown-class flood | [x] C12 proc-sweep flood test |
| C13 | liveness: dead monitor loop | any `0` in alive flags | containment-integrity CRITICAL trip | [x] dead-monitor test |
| C14 | clean session terminal record | job ends, no trip | session-end summary event in envelope | [x] session-end test |
| C15 | net: tcp6/udp row forms | tcp6/udp rows at sweep | GC-NET-001 immediate trip (C10 covers tcp) | [x] C15 tcp6/udp net-row test |

## D. Sequences, thresholds, freeze, suppression

| ID | Scenario | Required observable | Status |
|----|----------|---------------------|--------|
| D1 | ELEVATED at n−1 (4 hits) | deny each, NO trip | [x] ELEVATED test |
| D2 | ELEVATED at n=5 exact boundary | trip on 5th, mode=aggregate | [x] ELEVATED test |
| D3 | ANOMALY at 10 exact boundary | trip on 10th | [x] ANOMALY test |
| D4 | pressure decay after 60 s window | old events stop counting | [x] D4 pressure-decay test |
| D5 | CRITICAL amid ELEVATED pressure | CRITICAL trips immediately regardless | [x] D5 mixed-tier test |
| D6 | HIGH first occurrence | immediate trip | [x] HIGH test |
| D7 | repeated identical trips | no duplicate killswitch terminal events post-freeze | [x] H1 freeze |
| D8 | post-trip freeze | no log appends, no pressure growth, frozen decision JSON | [x] H1 |
| D9 | next-command suppression, plain form | follow-up line never runs (SIGKILL) | [x] R4 |
| D10 | next-command suppression, exec form | no follow-up, PID 1 safe | [x] R5 |
| D11 | next-command suppression, background/group | whole job group dead | [x] D11 background-suppression sandbox test (macOS/Linux: trip + suppression asserts run everywhere; whole-group-death asserts only where the process-group branch is reachable — Linux) |
| D12 | synchronous kill vs 1 s supervisor poll | dispatch kills before poll could | [x] R4/R5 (timing assertion) |
| D13 | learning-window race (3 s) | observe-allow logged, lock denies after | [x] allowlist test |
| D14 | kill-flag file semantics | content `immediate`; presence gates supervisor break | [x] R4 + decide tests |
| D15 | GC-FSW-003 absent watched roots | sweep with missing dirs records baseline only | no decision, no pressure | [x] D15 absent-roots sampler test |
| D16 | unknown-class decay | unknown events older than 60 s | stop counting (D4 covers GC-PKG decay only) | [x] D16 unknown-class decay test |

## E. Evidence chain, receipt consistency, teardown

| ID | Scenario | Required observable | Status |
|----|----------|---------------------|--------|
| E1 | trip → durable report exists at advertised path | file created, non-empty | [x] D1 |
| E2 | advertised path truthful | block killReportPath === file path | [x] D1 |
| E3 | teardown fields finalized | domainAbsent/destroyRequested/aclRestored = booleans, no PENDING | [x] D1 |
| E4 | report digest matches evidence | report logSha256 === block logSha256 | [x] D1 |
| E5 | receipt v2 containment block | histogram, counts, concealmentIndex, tier/rule | [x] M1/M6 E2E |
| E6 | pty-mangled (CRLF) transcript | envelope parse recomputes digest | [x] envelope test |
| E7 | second envelope pair | rejected as forgery | [x] H2 |
| E8 | missing containment evidence | fail closed (containment-evidence-missing) | [x] fail-closed test |
| E9 | tampered digest chain | rejected | [x] H1 trailing-record test |
| E10 | receipt extra output | relaxed only for envelope markers on v2 | [x] relaxation test |
| E11 | teardown proofs | domain destroy requested+absent, ACL before==after, initramfs ACL entry removed | [x] fixture phase asserts / receipt teardown block |
| E12 | zero-event session | terminal session-end record, envelope emittable | [x] session-end test |

---

## Coverage summary (at time of writing)

- Total rows: 79 (A: 23, B: 13, C: 15, D: 16, E: 12)
- Covered by existing executable tests: 79
- TO-ADD (executable regression missing): 0 — all rows covered as of this revision (A22, A23, B13, C15, D15, D16 implemented alongside the earlier B3, B4, B6, B8, B9, C12, D4, D5, D11 additions).
- TO-DECIDE: 0 — the four taxonomy-only rules (GC-FSW-003, GC-SHR-001, GC-SHR-002, GC-LOG-001) are detector-backed as of the P11 detector step; taxonomy dispositions updated and the taxonomy digest re-pinned.

## False-positive discipline (documented heuristics)

- **GC-SHR-001** — the armed form fires only on `/share` and `/mnt/share` paths and only when `gc_share_mounted` sees a share mount (`/proc/mounts` mountpoints or 9p/virtiofs/nfs/cifs fstypes; tests drive it through the `GC_PROC_MOUNTS` seam — production always reads `/proc/mounts`). Unarmed, those paths fall through to the normal GC-FSW-001 outside-allowlist handling instead of a share trip. The deny-otherwise form fires only on the shared-cache roots (`~/.npm`, `~/.cache`, `/var/cache`). The writable-scratch branch precedes both, so jobs writing under `/tmp/session` are unaffected; a package build into the cache roots with no share armed is intentionally denied.
- **GC-SHR-002** — path-name heuristics (Maildir, task-queue, `.herdr`, agent-channel, coordination). Writes inside the job scratch root hit the allow branch first; only writes outside it match. In the argv layer the heuristics see the command line with scratch-prefixed arguments neutralized, so `tee /tmp/session/agent-channel` is a scratch write, not a coordination deny; a mixed line (scratch source, coordination target) still denies.
- **GC-LOG-001** — transcript/receipt-channel path names outside the writable root. The in-guest supervisor never writes these files (the host recorder owns the transcript), so any fs event implies a non-supervisor writer. The same argv carve-out applies: scratch-local transcript-named writes (`tee /tmp/session/console.typescript`) are allowed; writes outside the scratch deny.
- **GC-FSW-003** — at most ONE ELEVATED decision per sweep, and only when the summed size delta of the watched roots crosses `GC_CACHE_GROWTH_KIB` (default 1024 KiB). Sub-threshold churn is invisible; the class still needs 5 qualifying sweeps within the 60 s window to trip. The trip path is host-test-proven only: while GC-SHR-001 is armed, any create inside a watched cache root also bumps the directory's mtime, and the sweep classifies that write as a shared-cache violation (HIGH, immediate) before five growth decisions can accumulate. The combined rules are stricter than either alone; a live FSW-003 trip is therefore unreachable by construction and is not scheduled.

Audit rule: a row may only flip to `[x]` when a named test in this repository
exercises the real implemented code path (host-side `--gc-*` hooks, extracted
guest artifacts, or the production sequence) — source-level assertions alone
are insufficient for B/C/D rows.
