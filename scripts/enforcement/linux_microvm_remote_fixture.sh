#!/usr/bin/env bash
set -euo pipefail

# --- guest containment core (taxonomy, structured log, killswitch decision) ---
# Design: /Users/julen/pi-dev-env/evidence/GUEST_CONTAINMENT_DESIGN.md sections
# 2 (taxonomy), 2.0 (severity tiers), 4 (log format), 5 (killswitch semantics).
# Watchers and shims arrive in a later step; this core is callable and testable
# through the --gc-decide / --gc-log / --gc-taxonomy-sha hooks below.
GC_TAXONOMY_VERSION="guest-containment-taxonomy.v1"
GC_LOG_SCHEMA="agentic-driver.guest-containment.log.v1"
GC_KILLSWITCH_SCHEMA="agentic-driver.guest-containment.killswitch.v1"
GC_TAXONOMY_SHA256="2d3f781c1594a5cefb77560419faff1619bc90012fc20b339a79110dbaa847c9"
# Severity tiers (design section 2.0): CRITICAL/HIGH trip immediately,
# ELEVATED/ANOMALY accumulate pressure within a sliding time window.
GC_WINDOW_SECONDS=60
GC_ELEVATED_THRESHOLD=5
GC_ANOMALY_THRESHOLD=10
GC_LOG_CAP_BYTES=8192
GC_LOG_TRUNC=512

gc_embedded_taxonomy() {
  cat <<'GC_TAXONOMY_EOF'
{
  "schema": "guest-containment-taxonomy.v1",
  "description": "Deny-by-default rule taxonomy for the guest containment monitor (design GUEST_CONTAINMENT_DESIGN.md section 2). One rule per line; IDs are never reused; new rules append. disposition records whether a live detector exists in the fixture (design sections 1.3, 3) or the rule is armed by the taxonomy only.",
  "rules": [
    {"id":"GC-PKG-001","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"package-manager-install: invocation of npm install, npm ci, pip install, yarn add, pnpm add, gem install, cargo install, apk add, apt install","evidence":"METR autonomous-replication evaluation work (arXiv:2403.13793); HF incident dependency-install persistence step","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-PKG-002","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"registry-write-command: npm publish, npm token, .npmrc writes, pip config, keyring writes","evidence":"HF incident: agent attempted package publication","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-PKG-003","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"package-metadata-tamper: writes to package.json, package-lock.json, pyproject.toml, requirements*.txt outside the job scratch space","evidence":"METR evaluation logs: dependency-manifest tampering as persistence step","since":"v1","disposition":"detector:fs-path+shim-argv"},
    {"id":"GC-FSW-001","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"write-outside-allowlist: create/append/truncate on any path outside /tmp/session, detected by inotifyd or find -newer sweeps","evidence":"METR evaluation logs: out-of-bounds file writes during evaluation runs","since":"v1","disposition":"detector:fs-watcher"},
    {"id":"GC-FSW-002","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"self-code-modification: writes under the agent job install/execution directories including the shim tree /shims/","evidence":"HF incident: agent rewrote the repository it was working in; monitor self-rewrite defense","since":"v1","disposition":"detector:fs-watcher"},
    {"id":"GC-FSW-003","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"file-growth-anomaly: unexpected growth in cache/package directories (~/.npm, ~/.cache/pip, /var/cache/*) beyond the size-delta threshold","evidence":"METR evaluation logs: bulk cache staging of payloads","since":"v1","disposition":"taxonomy-only-until-detector: needs cache size-delta sampling in the sweep (later step)"},
    {"id":"GC-SHR-001","class":"GC-SHR","severity":"HIGH","action":"deny","match":"shared-cache-write: writes to paths shared with other agents or the coordinator; with host-share absent any such attempt is a deny","evidence":"receipt proves host-share=absent; writes would indicate boundary violation","since":"v1","disposition":"taxonomy-only-until-detector: host share absent in this fixture; auto-arm when a share mount exists"},
    {"id":"GC-SHR-002","class":"GC-SHR","severity":"HIGH","action":"deny","match":"cross-agent-channel: creation of or writes to inter-agent coordination paths (maildirs, task-queue files, agent state files)","evidence":"HF incident multi-agent escalation; METR coordination/sabotage threat model","since":"v1","disposition":"taxonomy-only-until-detector: coordination-path heuristics deferred to avoid false positives"},
    {"id":"GC-NET-001","class":"GC-NET","severity":"HIGH","action":"deny","match":"socket-open: any entry in /proc/net/tcp, /proc/net/tcp6, /proc/net/udp at any sweep","evidence":"fixture boots with no network device; any socket is exfiltration-capable","since":"v1","disposition":"detector:net-proc-sweep"},
    {"id":"GC-NET-002","class":"GC-NET","severity":"HIGH","action":"deny","match":"network-tool-invocation: shim-detects wget, curl, nc, ssh, telnet, ping regardless of arguments","evidence":"METR self-replication exfiltration patterns; HF incident remote control","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-CRED-001","class":"GC-CRED","severity":"CRITICAL","action":"deny","match":"credential-path-read: opens of ~/.ssh/, ~/.aws/, ~/.netrc, ~/.git-credentials, token files","evidence":"credential theft is step one in every reported agent-escape chain","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-CRED-002","class":"GC-CRED","severity":"CRITICAL","action":"deny","match":"env-secret-probing: attempts to dump or scan the environment for secret-shaped keys","evidence":"METR evaluation logs; HF incident postmortem credential harvest attempts","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-LOG-001","class":"GC-LOG","severity":"CRITICAL","action":"deny","match":"transcript-write: writes to the console transcript, the monitor log, or the receipt channel by any path other than the supervisor","evidence":"log is opened append-only by the supervisor; other writers are evidence tampering","since":"v1","disposition":"taxonomy-only-until-detector: console transcript attribution requires supervisor fd discipline"},
    {"id":"GC-LOG-002","class":"GC-LOG","severity":"CRITICAL","action":"deny","match":"log-truncate-or-rename: >, rm, mv, truncate, sed -i targeting monitor/agent logs","evidence":"METR report: models attempting to edit their own logs","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-TOOL-001","class":"GC-TOOL","severity":"CRITICAL","action":"deny","match":"receipt-forgery: job printing AGENTIC_MICROVM_PROBE:* or AGENTIC_MICROVM_RECEIPT:* lines","evidence":"host closed-receipt parsing rejects forged output; guest-side denial closes the loop","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-TOOL-002","class":"GC-TOOL","severity":"CRITICAL","action":"deny","match":"marker-injection: writes to /dev/console, /dev/ttyS0, or other devtmpfs write targets that could inject marker text","evidence":"METR tool-call spoofing family; serial stream integrity","since":"v1","disposition":"detector:shim-argv+fs-path; known gap: char-device writes may not update mtime for the sweep"}
  ],
  "residual": {"class":"unknown","tier":"ANOMALY","action":"deny","note":"everything not allowlisted and not classified above; accumulates toward the ANOMALY threshold"}
}
GC_TAXONOMY_EOF
}

gc_iso8601() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Redaction per design section 4: strip control characters, replace
# secret-shaped assignments with [REDACTED].
gc_redact() {
  tr -d '\000-\010\013\014\016-\037' | sed -E 's/[A-Za-z0-9_-]*([Tt]oken|TOKEN|[Ss]ecret|SECRET|[Pp]ass[A-Za-z]*|PASS[A-Za-z]*|[Cc]redential|CREDENTIAL|[Aa]pi[_-]?[Kk]ey|API[_-]?KEY|[Pp]rivate[_-]?[Kk]ey|PRIVATE[_-]?KEY)[A-Za-z0-9_-]*[=:][^ ",;&]+/[REDACTED]/g'
}

# Extract a string field from the rule object whose "id" matches rule_id.
gc_rule_field() { # taxonomy_file rule_id field
  sed -n "s/.*\"id\": *\"$2\"[^}]*\"$3\": *\"\([A-Za-z-]*\)\".*/\1/p" "$1" | head -n 1
}

gc_log_event() { # state_dir source class subject_type subject_value [action]
  local state_dir=$1 source=$2 class=$3 stype=$4 svalue=$5 action=${6:-deny}
  # Log freeze (design section 5): once a killswitch trip is recorded the log
  # is frozen; appends after the trip would break the terminal digest chain.
  if [ -f "$state_dir/kill" ]; then return 0; fi
  mkdir -p "$state_dir"
  local log="$state_dir/containment.log.jsonl"
  local tax="$state_dir/taxonomy.json"
  if [ ! -f "$tax" ]; then gc_embedded_taxonomy >"$tax" || return 2; fi
  local tsha
  tsha=$(sha256sum "$tax" | awk '{print $1}') || return 2
  local seq=1
  if [ -f "$state_dir/seq" ]; then seq=$(( $(cat "$state_dir/seq") + 1 )); fi
  printf '%s\n' "$seq" >"$state_dir/seq"
  svalue=${svalue//\\/}
  svalue=${svalue//\"/}
  svalue=$(printf '%s' "$svalue" | gc_redact | cut -c1-"$GC_LOG_TRUNC")
  local ts record
  ts=$(gc_iso8601)
  # Summary-only degradation on flood (design section 4): context dropped,
  # events never silently discarded.
  if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt "$GC_LOG_CAP_BYTES" ]; then
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"%s","summary":true}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class" "$action")
  else
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"%s","subject":{"type":"%s","value":"%s"}}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class" "$action" "$stype" "$svalue")
  fi
  printf '%s\n' "$record" >>"$log"
  printf '%s\n' "$record"
}

gc_killswitch_trip() { # state_dir rule_id class tier mode pressure threshold
  local state_dir=$1 rule_id=$2 class=$3 tier=$4 mode=$5 pressure=${6:-null} threshold=${7:-null}
  local log="$state_dir/containment.log.jsonl"
  local ks event log_sha
  event=$(printf '{"schema":"%s","session":"%s","trigger":{"rule":"%s","class":"%s","tier":"%s","mode":"%s","pressure":%s,"threshold":%s},"final":true}' \
    "$GC_KILLSWITCH_SCHEMA" "$(basename "$state_dir")" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold")
  printf '%s\n' "$event" >>"$log"
  log_sha=$(sha256sum "$log" | awk '{print $1}') || return 2
  # Terminal killswitch event with log digest (design section 5, step 1).
  ks=$(printf '{"schema":"%s","session":"%s","trigger":{"rule":"%s","class":"%s","tier":"%s","mode":"%s","pressure":%s,"threshold":%s},"logSha256":"%s","final":true}' \
    "$GC_KILLSWITCH_SCHEMA" "$(basename "$state_dir")" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold" "$log_sha")
  printf '%s\n' "$ks" >>"$log"
  # Kill flag: the guest supervisor polls this and executes the kill path
  # (kill process group, sync, poweroff -f); host-side hooks ignore it.
  printf '%s\n' "$mode" >"$state_dir/kill" 2>/dev/null || true
  printf '%s\n' "$ks"
}

gc_window_pressure() { # pressure_file
  local now cutoff
  now=$(date +%s)
  cutoff=$((now - GC_WINDOW_SECONDS))
  if [ ! -f "$1" ]; then printf '0\n'; return 0; fi
  awk -v cutoff="$cutoff" '$1 > cutoff {n++} END {print n + 0}' "$1"
}

# Killswitch decision function (design sections 2.0 and 5): given a rule hit,
# CRITICAL/HIGH trip immediately; ELEVATED/ANOMALY increment per-class pressure
# within the sliding window and trip on threshold. Returns a decision JSON on
# stdout; a trip also appends the terminal killswitch event to the log.
gc_decide() { # state_dir rule_id [subject_value]
  local state_dir=$1 rule_id=$2 svalue=${3:-}
  mkdir -p "$state_dir" || return 2
  local tax="$state_dir/taxonomy.json"
  if [ ! -f "$tax" ]; then gc_embedded_taxonomy >"$tax" || return 2; fi
  local severity class tier mode=immediate pressure=null threshold=null tripped=false
  severity=$(gc_rule_field "$tax" "$rule_id" severity)
  if [ -z "$severity" ]; then
    # Residual deny-by-default class (design section 2, GC-UNKNOWN).
    severity=ANOMALY
    class=unknown
  else
    class=$(gc_rule_field "$tax" "$rule_id" class)
  fi
  case "$severity" in
    CRITICAL|HIGH)
      tier=$severity
      tripped=true
      mode=immediate
      ;;
    ELEVATED|ANOMALY)
      tier=$severity
      mode=aggregate
      local pfile="$state_dir/pressure.$class"
      printf '%s\n' "$(date +%s)" >>"$pfile"
      pressure=$(gc_window_pressure "$pfile")
      if [ "$severity" = ELEVATED ]; then threshold=$GC_ELEVATED_THRESHOLD; else threshold=$GC_ANOMALY_THRESHOLD; fi
      if [ "$pressure" -ge "$threshold" ]; then tripped=true; fi
      ;;
    *)
      return 2
      ;;
  esac
  gc_log_event "$state_dir" "shim" "$class" "exec" "$svalue" >/dev/null || return 2
  if [ "$tripped" = true ]; then
    gc_killswitch_trip "$state_dir" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold" >/dev/null || return 2
  fi
  printf '{"rule":"%s","class":"%s","severity":"%s","tier":"%s","tripped":%s,"mode":"%s","pressure":%s,"threshold":%s}\n' \
    "$rule_id" "$class" "$severity" "$tier" "$tripped" "$mode" "$pressure" "$threshold"
}

# --- detection (design section 1.3, 3): shim classification, allowlist,
# fs/net/proc detection, supervisor liveness. Callable from the guest
# (sourced by /init and the shim dispatcher) and from the host test hooks.
GC_LEARNING_WINDOW_SECONDS=${GC_LEARNING_WINDOW_SECONDS:-3}
GC_WRITABLE_ROOT="/tmp/session"

# Shim classification: map a command line to a taxonomy rule id (empty means
# unclassified; unclassified executables go through the observed-first-use
# allowlist, design section 3).
gc_shim_classify() { # tool args...
  local tool=$1; shift
  # busybox <applet> shim bypass (design section 9.1): classify the effective
  # applet line instead of trusting the tool name.
  if [ "$tool" = "busybox" ] && [ "$#" -ge 1 ]; then
    gc_shim_classify "$1" "${@:2}"
    return
  fi
  local line="$tool $*"
  case "$tool" in
    wget|curl|nc|ssh|telnet|ping) printf 'GC-NET-002\n'; return 0 ;;
    printenv) printf 'GC-CRED-002\n'; return 0 ;;
  esac
  case "$line" in
    *"npm install"*|*"npm ci"*|*"pip install"*|*"yarn add"*|*"pnpm add"*|*"gem install"*|*"cargo install"*|*"apk add"*|*"apt install"*)
      printf 'GC-PKG-001\n' ;;
    *"npm publish"*|*"npm token"*|*".npmrc"*|*"pip config"*)
      printf 'GC-PKG-002\n' ;;
    *".ssh/"*|*".aws/"*|*".netrc"*|*".git-credentials"*)
      printf 'GC-CRED-001\n' ;;
    *"env | grep"*|*"env | grep -i"*)
      printf 'GC-CRED-002\n' ;;
    *"package.json"*|*"package-lock.json"*|*"pyproject.toml"*|*"requirements"*.txt*)
      printf 'GC-PKG-003\n' ;;
    *"AGENTIC_MICROVM_PROBE"*|*"AGENTIC_MICROVM_RECEIPT"*|*"AGENTIC_CONTAINMENT_BEGIN"*|*"AGENTIC_CONTAINMENT_END"*)
      printf 'GC-TOOL-001\n' ;;
    *"/dev/console"*|*"/dev/ttyS"*|*"/dev/tty0"*)
      printf 'GC-TOOL-002\n' ;;
    *"containment.log"*|*"/.gc/"*|*"> /var/log"*|*"truncate -s 0"*|*"sed -i"*)
      printf 'GC-LOG-002\n' ;;
    *) return 0 ;;
  esac
}

# Observed-first-use allowlist with a short learning window (design section 3):
# during the window unlisted executables are logged and allowed; after lock
# they are denied with the redacted command line.
gc_shim_allow() { # state_dir tool args... -> decision JSON on stdout
  local state_dir=$1 tool=$2; shift 2
  mkdir -p "$state_dir" || return 2
  local rule
  rule=$(gc_shim_classify "$tool" "$@")
  if [ -n "$rule" ]; then
    gc_decide "$state_dir" "$rule" "$tool $*" >/dev/null || return 2
    printf '{"decision":"deny","rule":"%s","tool":"%s"}\n' "$rule" "$tool"
    return 0
  fi
  local allow="$state_dir/allowlist" lock="$state_dir/allowlist.lock" start="$state_dir/learning_start"
  if [ ! -f "$start" ]; then printf '%s\n' "$(date +%s)" >"$start"; fi
  if [ ! -f "$lock" ] && [ $(( $(date +%s) - $(cat "$start") )) -ge "$GC_LEARNING_WINDOW_SECONDS" ]; then
    printf '%s\n' "$(date +%s)" >"$lock"
  fi
  if [ -f "$lock" ]; then
    if grep -F -x -- "$tool" "$allow" >/dev/null 2>&1; then
      printf '{"decision":"allow","tool":"%s","learned":false}\n' "$tool"
    else
      gc_decide "$state_dir" "unknown" "$tool $*" >/dev/null || return 2
      printf '{"decision":"deny","rule":"unknown","tool":"%s"}\n' "$tool"
    fi
  else
    if ! grep -F -x -- "$tool" "$allow" >/dev/null 2>&1; then
      printf '%s\n' "$tool" >>"$allow"
    fi
    # Learning-window observations are logged (design section 3): allowed, but
    # recorded as events so the learning window is auditable.
    gc_log_event "$state_dir" "shim" "unknown" "exec" "$tool $*" "observe" >/dev/null 2>&1 || true
    printf '{"decision":"allow","tool":"%s","learned":true}\n' "$tool"
  fi
}

# fs-watcher detection: only the job scratch root is writable; writes to the
# shim/agent trees are self-code-modification, everything else is
# write-outside-allowlist.
gc_fs_detect() { # state_dir path -> decision JSON
  local state_dir=$1 path=$2
  case "$path" in
    "$GC_WRITABLE_ROOT"|"$GC_WRITABLE_ROOT"/*)
      printf '{"decision":"allow","path":"%s"}\n' "$path" ;;
    /shims|/shims/*|/agent|/agent/*)
      gc_decide "$state_dir" GC-FSW-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-FSW-002","path":"%s"}\n' "$path" ;;
    */package.json|*/package-lock.json|*/pyproject.toml|*/requirements*.txt|/package.json|/pyproject.toml)
      gc_decide "$state_dir" GC-PKG-003 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-PKG-003","path":"%s"}\n' "$path" ;;
    /dev/*|/dev)
      # Write targets on devtmpfs could inject marker text (GC-TOOL-002).
      gc_decide "$state_dir" GC-TOOL-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-TOOL-002","path":"%s"}\n' "$path" ;;
    *"containment.log"*|*/.gc/*)
      gc_decide "$state_dir" GC-LOG-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-LOG-002","path":"%s"}\n' "$path" ;;
    *)
      gc_decide "$state_dir" GC-FSW-001 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-FSW-001","path":"%s"}\n' "$path" ;;
  esac
}

# find -newer sweep fallback for the fs-watcher: detect every path handed in.
gc_fs_sweep() { # state_dir path...
  local state_dir=$1; shift
  local path
  for path in "$@"; do gc_fs_detect "$state_dir" "$path"; done
}

# net-watcher detection: any socket row is a violation (GC-NET-001).
gc_net_detect() { # state_dir socket_entry
  local state_dir=$1 entry=$2
  [ -n "$entry" ] || return 0
  gc_decide "$state_dir" GC-NET-001 "$entry" >/dev/null || return 2
  printf '{"decision":"deny","rule":"GC-NET-001"}\n'
}

# proc-watcher detection: a process outside the job tree is an anomaly.
gc_proc_detect() { # state_dir process_identity
  local state_dir=$1 identity=$2
  gc_decide "$state_dir" unknown "proc $identity" >/dev/null || return 2
  printf '{"decision":"deny","rule":"unknown"}\n'
}

# Supervisor liveness (design section 1.3): a dead monitor loop is a
# containment failure and trips the killswitch immediately.
gc_liveness() { # state_dir alive_flags ("1 1 1"; any 0 is a dead loop)
  local state_dir=$1 flags=$2
  case " $flags " in
    *" 0 "*)
      gc_log_event "$state_dir" "watcher:proc" containment-integrity proc "monitor loop dead" >/dev/null || return 2
      gc_killswitch_trip "$state_dir" containment-integrity containment-integrity CRITICAL immediate null null >/dev/null || return 2
      printf '{"decision":"deny","rule":"containment-integrity","tier":"CRITICAL","mode":"immediate"}\n' ;;
    *) printf '{"decision":"allow"}\n' ;;
  esac
}

# B1: the one real receipt printf. The containment segment is passed as a %s
# argument (never interpolated into the format string, where it would stay
# literal under single quotes); an empty segment yields the v1 receipt shape.
gc_receipt_json() { # schema remote_host fixture_id domain marker marker_sha script_hash initramfs_sha containment_segment domain destroy_requested absent acl_before acl_after fs_ctx_sha net_ctx_sha
  printf '{"schema":"%s","ok":true,"status":"VERIFIED","authorityCreated":false,"runtimeActivated":false,"persisted":false,"identity":{"remoteHost":"%s","fixtureId":"%s","domain":"%s"},"marker":{"value":"%s","sha256":"%s"},"scriptHash":"%s","initramfsSha256":"%s"%s,"teardown":{"domain":{"name":"%s","transient":true,"destroyOnExit":true,"destroyRequested":%s,"absent":%s,"checked":true,"check":"virsh dominfo/list"},"acl":{"beforeSha256":"%s","afterSha256":"%s","equal":true,"checked":true,"initramfsEntryRemoved":true}},"context":{"filesystem":{"summary":"disk=absent host-share=absent credentials=absent gpu=absent","disk":false,"hostShare":false,"credentials":false,"gpu":false,"sha256":"%s"},"network":{"summary":"network=absent","guest":false,"sha256":"%s"},"guestMounts":["proc","sysfs","devtmpfs"]}}\n' "$@"
}

# Terminal event for a session that ends without a killswitch trip: the
# envelope then carries only log lines plus this session-end record
# (design section 5: a session with neither is containment-evidence-missing).
gc_session_end() { # state_dir
  local state_dir=$1 log="$state_dir/containment.log.jsonl"
  local seq=1
  if [ -f "$state_dir/seq" ]; then seq=$(( $(cat "$state_dir/seq") + 1 )); fi
  printf '%s\n' "$seq" >"$state_dir/seq"
  local tsha
  tsha=$(sha256sum "$state_dir/taxonomy.json" | awk '{print $1}') || return 2
  printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"supervisor","class":"session-end","action":"complete","summary":true}}\n' \
    "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$(gc_iso8601)" "$seq" >>"$log"
}

# Host-side containment evidence (design section 5): extract the framed base64
# envelope from the console transcript, decode it pty-safe, recompute the log
# digest per the stated normalization, and cross-check the terminal killswitch
# event's embedded digest against the full payload.
gc_containment_evidence() { # transcript fixture_id -> containment block JSON on stdout
  local transcript=$1 fid=$2
  local begin="AGENTIC_CONTAINMENT_BEGIN:$fid" end="AGENTIC_CONTAINMENT_END:$fid"
  local b64 tmp log_sha events denials ks_line ks_rule tripped rule_json
  tmp="$transcript.containment.$$"
  trap 'rm -f "$tmp" "$tmp.b64" "$tmp.head"' RETURN
  # H2: exactly one envelope pair may exist; more than one is a forgery or a
  # replay attempt and fails closed.
  # Count with index() so pty CR suffixes do not defeat the anchor.
  begins=$(awk -v b="$begin" 'index($0, b) == 1 { n++ } END { print n + 0 }' "$transcript")
  ends=$(awk -v e="$end" 'index($0, e) == 1 { n++ } END { print n + 0 }' "$transcript")
  if [ "$begins" -ne 1 ] || [ "$ends" -ne 1 ]; then
    return 1
  fi
  if ! awk -v b="$begin" -v e="$end" 'index($0, b) == 1 { inside = 1; next } index($0, e) == 1 { inside = 0; next } inside' "$transcript" | tr -d '\r' >"$tmp.b64"; then
    return 1
  fi
  if ! [ -s "$tmp.b64" ]; then return 1; fi
  if ! { base64 -d <"$tmp.b64" >"$tmp" 2>/dev/null || base64 -D <"$tmp.b64" >"$tmp" 2>/dev/null; }; then return 1; fi
  if ! grep -q '"schema":"' "$tmp"; then return 1; fi
  ks_line=$(grep '"final":true' "$tmp" | tail -n 1)
  ks_num=$(grep -n '"final":true' "$tmp" | tail -n 1 | cut -d: -f1)
  if [ -n "$ks_line" ]; then
    # Digest chain (H1): verified at the killswitch line's position — the
    # digest covers the log up to and including the trigger event but
    # excluding the killswitch line itself; anything after it is post-trip
    # noise the guest's log freeze should have prevented, and is ignored for
    # the digest rather than silently trusted.
    ks_sha=$(printf '%s\n' "$ks_line" | sed -n 's/.*"logSha256":"\([0-9a-f]*\)".*/\1/p')
    sed -n "1,$((ks_num - 1))p" "$tmp" >"$tmp.head" 2>/dev/null || return 1
    chained_sha=$(sha256sum "$tmp.head" | awk '{print $1}') || return 1
    if [ -z "$ks_sha" ] || [ "$ks_sha" != "$chained_sha" ]; then return 2; fi
    tripped=true
    log_sha=$ks_sha
    ks_rule=$(printf '%s\n' "$ks_line" | sed -n 's/.*"trigger":{"rule":"\([A-Za-z0-9_-]*\)".*/\1/p')
    ks_class=$(printf '%s\n' "$ks_line" | sed -n 's/.*"trigger":{"rule":"[A-Za-z0-9_-]*","class":"\([A-Za-z0-9_-]*\)".*/\1/p')
    ks_tier=$(printf '%s\n' "$ks_line" | sed -n 's/.*"tier":"\([A-Za-z]*\)".*/\1/p')
    rule_json="\"$ks_rule\""
    class_json="\"$ks_class\""
    tier_json="\"$ks_tier\""
    counted=$((ks_num - 1))
  else
    # Fail-closed: without a killswitch record the session must end with the
    # clean session-end terminal event.
    grep -q '"class":"session-end"' "$tmp" || return 1
    tripped=false
    rule_json=null
    class_json=null
    tier_json=null
    log_sha=$(sha256sum "$tmp" | awk '{print $1}') || return 1
    counted=$(grep -c '"schema":"' "$tmp")
  fi
  events=$counted
  denials=$(grep -c '"action":"deny"' "$tmp")
  # M1: compact histogram (design section 4; open question 4 decided) — the
  # coordinator consumes aggregates from the receipt without extra tooling.
  # Terminal killswitch records are echoes, not events; exclude them.
  histogram=$(awk '{
    if ($0 !~ /guest-containment.killswitch.v1/ && match($0, /"class":"[^"]*"/)) {
      c = substr($0, RSTART + 9, RLENGTH - 10); n[c]++
    }
  } END { first = 1; printf "{"; for (k in n) { if (!first) printf ","; printf "\"%s\":%d", k, n[k]; first = 0 } printf "}" }' "$tmp")
  rm -f "$tmp" "$tmp.b64" "$tmp.head"
  printf '{"schema":"%s","taxonomySha256":"%s","logSha256":"%s","events":%s,"denials":%s,"histogram":%s,"killswitch":{"tripped":%s,"rule":%s,"class":%s,"tier":%s,"guestPoweroff":true,"final":true}}' \
    "$GC_LOG_SCHEMA" "$GC_TAXONOMY_SHA256" "$log_sha" "$events" "$denials" "$histogram" "$tripped" "$rule_json" "$class_json" "$tier_json"
}

# Test hooks: the containment core is callable without booting the guest.
if [ "${1:-}" = "--gc-decide" ]; then shift; gc_decide "$@"; exit $?; fi
if [ "${1:-}" = "--gc-log" ]; then shift; gc_log_event "$@"; exit $?; fi
if [ "${1:-}" = "--gc-shim" ]; then shift; gc_shim_allow "$@"; exit $?; fi
if [ "${1:-}" = "--gc-fs-detect" ]; then shift; gc_fs_detect "$@"; exit $?; fi
if [ "${1:-}" = "--gc-fs-sweep" ]; then shift; gc_fs_sweep "$@"; exit $?; fi
if [ "${1:-}" = "--gc-net-detect" ]; then shift; gc_net_detect "$@"; exit $?; fi
if [ "${1:-}" = "--gc-proc-detect" ]; then shift; gc_proc_detect "$@"; exit $?; fi
if [ "${1:-}" = "--gc-liveness" ]; then shift; gc_liveness "$@"; exit $?; fi
if [ "${1:-}" = "--gc-core-embed" ]; then
  shift
  # Test/regression hook: writes the embedded guest core exactly as the build
  # phase does. Works through the streamed-stdin path (`bash -s`), where $0
  # is "bash" and there is no script file to read back.
  cat >"$1" <<'GC_CORE_EOF'
# --- guest containment core (taxonomy, structured log, killswitch decision) ---
# Design: /Users/julen/pi-dev-env/evidence/GUEST_CONTAINMENT_DESIGN.md sections
# 2 (taxonomy), 2.0 (severity tiers), 4 (log format), 5 (killswitch semantics).
# Watchers and shims arrive in a later step; this core is callable and testable
# through the --gc-decide / --gc-log / --gc-taxonomy-sha hooks below.
GC_TAXONOMY_VERSION="guest-containment-taxonomy.v1"
GC_LOG_SCHEMA="agentic-driver.guest-containment.log.v1"
GC_KILLSWITCH_SCHEMA="agentic-driver.guest-containment.killswitch.v1"
GC_TAXONOMY_SHA256="2d3f781c1594a5cefb77560419faff1619bc90012fc20b339a79110dbaa847c9"
# Severity tiers (design section 2.0): CRITICAL/HIGH trip immediately,
# ELEVATED/ANOMALY accumulate pressure within a sliding time window.
GC_WINDOW_SECONDS=60
GC_ELEVATED_THRESHOLD=5
GC_ANOMALY_THRESHOLD=10
GC_LOG_CAP_BYTES=8192
GC_LOG_TRUNC=512

gc_embedded_taxonomy() {
  cat <<'GC_TAXONOMY_EOF'
{
  "schema": "guest-containment-taxonomy.v1",
  "description": "Deny-by-default rule taxonomy for the guest containment monitor (design GUEST_CONTAINMENT_DESIGN.md section 2). One rule per line; IDs are never reused; new rules append. disposition records whether a live detector exists in the fixture (design sections 1.3, 3) or the rule is armed by the taxonomy only.",
  "rules": [
    {"id":"GC-PKG-001","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"package-manager-install: invocation of npm install, npm ci, pip install, yarn add, pnpm add, gem install, cargo install, apk add, apt install","evidence":"METR autonomous-replication evaluation work (arXiv:2403.13793); HF incident dependency-install persistence step","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-PKG-002","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"registry-write-command: npm publish, npm token, .npmrc writes, pip config, keyring writes","evidence":"HF incident: agent attempted package publication","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-PKG-003","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"package-metadata-tamper: writes to package.json, package-lock.json, pyproject.toml, requirements*.txt outside the job scratch space","evidence":"METR evaluation logs: dependency-manifest tampering as persistence step","since":"v1","disposition":"detector:fs-path+shim-argv"},
    {"id":"GC-FSW-001","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"write-outside-allowlist: create/append/truncate on any path outside /tmp/session, detected by inotifyd or find -newer sweeps","evidence":"METR evaluation logs: out-of-bounds file writes during evaluation runs","since":"v1","disposition":"detector:fs-watcher"},
    {"id":"GC-FSW-002","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"self-code-modification: writes under the agent job install/execution directories including the shim tree /shims/","evidence":"HF incident: agent rewrote the repository it was working in; monitor self-rewrite defense","since":"v1","disposition":"detector:fs-watcher"},
    {"id":"GC-FSW-003","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"file-growth-anomaly: unexpected growth in cache/package directories (~/.npm, ~/.cache/pip, /var/cache/*) beyond the size-delta threshold","evidence":"METR evaluation logs: bulk cache staging of payloads","since":"v1","disposition":"taxonomy-only-until-detector: needs cache size-delta sampling in the sweep (later step)"},
    {"id":"GC-SHR-001","class":"GC-SHR","severity":"HIGH","action":"deny","match":"shared-cache-write: writes to paths shared with other agents or the coordinator; with host-share absent any such attempt is a deny","evidence":"receipt proves host-share=absent; writes would indicate boundary violation","since":"v1","disposition":"taxonomy-only-until-detector: host share absent in this fixture; auto-arm when a share mount exists"},
    {"id":"GC-SHR-002","class":"GC-SHR","severity":"HIGH","action":"deny","match":"cross-agent-channel: creation of or writes to inter-agent coordination paths (maildirs, task-queue files, agent state files)","evidence":"HF incident multi-agent escalation; METR coordination/sabotage threat model","since":"v1","disposition":"taxonomy-only-until-detector: coordination-path heuristics deferred to avoid false positives"},
    {"id":"GC-NET-001","class":"GC-NET","severity":"HIGH","action":"deny","match":"socket-open: any entry in /proc/net/tcp, /proc/net/tcp6, /proc/net/udp at any sweep","evidence":"fixture boots with no network device; any socket is exfiltration-capable","since":"v1","disposition":"detector:net-proc-sweep"},
    {"id":"GC-NET-002","class":"GC-NET","severity":"HIGH","action":"deny","match":"network-tool-invocation: shim-detects wget, curl, nc, ssh, telnet, ping regardless of arguments","evidence":"METR self-replication exfiltration patterns; HF incident remote control","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-CRED-001","class":"GC-CRED","severity":"CRITICAL","action":"deny","match":"credential-path-read: opens of ~/.ssh/, ~/.aws/, ~/.netrc, ~/.git-credentials, token files","evidence":"credential theft is step one in every reported agent-escape chain","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-CRED-002","class":"GC-CRED","severity":"CRITICAL","action":"deny","match":"env-secret-probing: attempts to dump or scan the environment for secret-shaped keys","evidence":"METR evaluation logs; HF incident postmortem credential harvest attempts","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-LOG-001","class":"GC-LOG","severity":"CRITICAL","action":"deny","match":"transcript-write: writes to the console transcript, the monitor log, or the receipt channel by any path other than the supervisor","evidence":"log is opened append-only by the supervisor; other writers are evidence tampering","since":"v1","disposition":"taxonomy-only-until-detector: console transcript attribution requires supervisor fd discipline"},
    {"id":"GC-LOG-002","class":"GC-LOG","severity":"CRITICAL","action":"deny","match":"log-truncate-or-rename: >, rm, mv, truncate, sed -i targeting monitor/agent logs","evidence":"METR report: models attempting to edit their own logs","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-TOOL-001","class":"GC-TOOL","severity":"CRITICAL","action":"deny","match":"receipt-forgery: job printing AGENTIC_MICROVM_PROBE:* or AGENTIC_MICROVM_RECEIPT:* lines","evidence":"host closed-receipt parsing rejects forged output; guest-side denial closes the loop","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-TOOL-002","class":"GC-TOOL","severity":"CRITICAL","action":"deny","match":"marker-injection: writes to /dev/console, /dev/ttyS0, or other devtmpfs write targets that could inject marker text","evidence":"METR tool-call spoofing family; serial stream integrity","since":"v1","disposition":"detector:shim-argv+fs-path; known gap: char-device writes may not update mtime for the sweep"}
  ],
  "residual": {"class":"unknown","tier":"ANOMALY","action":"deny","note":"everything not allowlisted and not classified above; accumulates toward the ANOMALY threshold"}
}
GC_TAXONOMY_EOF
}

gc_iso8601() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Redaction per design section 4: strip control characters, replace
# secret-shaped assignments with [REDACTED].
gc_redact() {
  tr -d '\000-\010\013\014\016-\037' | sed -E 's/[A-Za-z0-9_-]*([Tt]oken|TOKEN|[Ss]ecret|SECRET|[Pp]ass[A-Za-z]*|PASS[A-Za-z]*|[Cc]redential|CREDENTIAL|[Aa]pi[_-]?[Kk]ey|API[_-]?KEY|[Pp]rivate[_-]?[Kk]ey|PRIVATE[_-]?KEY)[A-Za-z0-9_-]*[=:][^ ",;&]+/[REDACTED]/g'
}

# Extract a string field from the rule object whose "id" matches rule_id.
gc_rule_field() { # taxonomy_file rule_id field
  sed -n "s/.*\"id\": *\"$2\"[^}]*\"$3\": *\"\([A-Za-z-]*\)\".*/\1/p" "$1" | head -n 1
}

gc_log_event() { # state_dir source class subject_type subject_value [action]
  local state_dir=$1 source=$2 class=$3 stype=$4 svalue=$5 action=${6:-deny}
  # Log freeze (design section 5): once a killswitch trip is recorded the log
  # is frozen; appends after the trip would break the terminal digest chain.
  if [ -f "$state_dir/kill" ]; then return 0; fi
  mkdir -p "$state_dir"
  local log="$state_dir/containment.log.jsonl"
  local tax="$state_dir/taxonomy.json"
  if [ ! -f "$tax" ]; then gc_embedded_taxonomy >"$tax" || return 2; fi
  local tsha
  tsha=$(sha256sum "$tax" | awk '{print $1}') || return 2
  local seq=1
  if [ -f "$state_dir/seq" ]; then seq=$(( $(cat "$state_dir/seq") + 1 )); fi
  printf '%s\n' "$seq" >"$state_dir/seq"
  svalue=${svalue//\\/}
  svalue=${svalue//\"/}
  svalue=$(printf '%s' "$svalue" | gc_redact | cut -c1-"$GC_LOG_TRUNC")
  local ts record
  ts=$(gc_iso8601)
  # Summary-only degradation on flood (design section 4): context dropped,
  # events never silently discarded.
  if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt "$GC_LOG_CAP_BYTES" ]; then
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"%s","summary":true}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class" "$action")
  else
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"%s","subject":{"type":"%s","value":"%s"}}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class" "$action" "$stype" "$svalue")
  fi
  printf '%s\n' "$record" >>"$log"
  printf '%s\n' "$record"
}

gc_killswitch_trip() { # state_dir rule_id class tier mode pressure threshold
  local state_dir=$1 rule_id=$2 class=$3 tier=$4 mode=$5 pressure=${6:-null} threshold=${7:-null}
  local log="$state_dir/containment.log.jsonl"
  local ks event log_sha
  event=$(printf '{"schema":"%s","session":"%s","trigger":{"rule":"%s","class":"%s","tier":"%s","mode":"%s","pressure":%s,"threshold":%s},"final":true}' \
    "$GC_KILLSWITCH_SCHEMA" "$(basename "$state_dir")" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold")
  printf '%s\n' "$event" >>"$log"
  log_sha=$(sha256sum "$log" | awk '{print $1}') || return 2
  # Terminal killswitch event with log digest (design section 5, step 1).
  ks=$(printf '{"schema":"%s","session":"%s","trigger":{"rule":"%s","class":"%s","tier":"%s","mode":"%s","pressure":%s,"threshold":%s},"logSha256":"%s","final":true}' \
    "$GC_KILLSWITCH_SCHEMA" "$(basename "$state_dir")" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold" "$log_sha")
  printf '%s\n' "$ks" >>"$log"
  # Kill flag: the guest supervisor polls this and executes the kill path
  # (kill process group, sync, poweroff -f); host-side hooks ignore it.
  printf '%s\n' "$mode" >"$state_dir/kill" 2>/dev/null || true
  printf '%s\n' "$ks"
}

gc_window_pressure() { # pressure_file
  local now cutoff
  now=$(date +%s)
  cutoff=$((now - GC_WINDOW_SECONDS))
  if [ ! -f "$1" ]; then printf '0\n'; return 0; fi
  awk -v cutoff="$cutoff" '$1 > cutoff {n++} END {print n + 0}' "$1"
}

# Killswitch decision function (design sections 2.0 and 5): given a rule hit,
# CRITICAL/HIGH trip immediately; ELEVATED/ANOMALY increment per-class pressure
# within the sliding window and trip on threshold. Returns a decision JSON on
# stdout; a trip also appends the terminal killswitch event to the log.
gc_decide() { # state_dir rule_id [subject_value]
  local state_dir=$1 rule_id=$2 svalue=${3:-}
  mkdir -p "$state_dir" || return 2
  local tax="$state_dir/taxonomy.json"
  if [ ! -f "$tax" ]; then gc_embedded_taxonomy >"$tax" || return 2; fi
  local severity class tier mode=immediate pressure=null threshold=null tripped=false
  severity=$(gc_rule_field "$tax" "$rule_id" severity)
  if [ -z "$severity" ]; then
    # Residual deny-by-default class (design section 2, GC-UNKNOWN).
    severity=ANOMALY
    class=unknown
  else
    class=$(gc_rule_field "$tax" "$rule_id" class)
  fi
  case "$severity" in
    CRITICAL|HIGH)
      tier=$severity
      tripped=true
      mode=immediate
      ;;
    ELEVATED|ANOMALY)
      tier=$severity
      mode=aggregate
      local pfile="$state_dir/pressure.$class"
      printf '%s\n' "$(date +%s)" >>"$pfile"
      pressure=$(gc_window_pressure "$pfile")
      if [ "$severity" = ELEVATED ]; then threshold=$GC_ELEVATED_THRESHOLD; else threshold=$GC_ANOMALY_THRESHOLD; fi
      if [ "$pressure" -ge "$threshold" ]; then tripped=true; fi
      ;;
    *)
      return 2
      ;;
  esac
  gc_log_event "$state_dir" "shim" "$class" "exec" "$svalue" >/dev/null || return 2
  if [ "$tripped" = true ]; then
    gc_killswitch_trip "$state_dir" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold" >/dev/null || return 2
  fi
  printf '{"rule":"%s","class":"%s","severity":"%s","tier":"%s","tripped":%s,"mode":"%s","pressure":%s,"threshold":%s}\n' \
    "$rule_id" "$class" "$severity" "$tier" "$tripped" "$mode" "$pressure" "$threshold"
}

# --- detection (design section 1.3, 3): shim classification, allowlist,
# fs/net/proc detection, supervisor liveness. Callable from the guest
# (sourced by /init and the shim dispatcher) and from the host test hooks.
GC_LEARNING_WINDOW_SECONDS=${GC_LEARNING_WINDOW_SECONDS:-3}
GC_WRITABLE_ROOT="/tmp/session"

# Shim classification: map a command line to a taxonomy rule id (empty means
# unclassified; unclassified executables go through the observed-first-use
# allowlist, design section 3).
gc_shim_classify() { # tool args...
  local tool=$1; shift
  # busybox <applet> shim bypass (design section 9.1): classify the effective
  # applet line instead of trusting the tool name.
  if [ "$tool" = "busybox" ] && [ "$#" -ge 1 ]; then
    gc_shim_classify "$1" "${@:2}"
    return
  fi
  local line="$tool $*"
  case "$tool" in
    wget|curl|nc|ssh|telnet|ping) printf 'GC-NET-002\n'; return 0 ;;
    printenv) printf 'GC-CRED-002\n'; return 0 ;;
  esac
  case "$line" in
    *"npm install"*|*"npm ci"*|*"pip install"*|*"yarn add"*|*"pnpm add"*|*"gem install"*|*"cargo install"*|*"apk add"*|*"apt install"*)
      printf 'GC-PKG-001\n' ;;
    *"npm publish"*|*"npm token"*|*".npmrc"*|*"pip config"*)
      printf 'GC-PKG-002\n' ;;
    *".ssh/"*|*".aws/"*|*".netrc"*|*".git-credentials"*)
      printf 'GC-CRED-001\n' ;;
    *"env | grep"*|*"env | grep -i"*)
      printf 'GC-CRED-002\n' ;;
    *"package.json"*|*"package-lock.json"*|*"pyproject.toml"*|*"requirements"*.txt*)
      printf 'GC-PKG-003\n' ;;
    *"AGENTIC_MICROVM_PROBE"*|*"AGENTIC_MICROVM_RECEIPT"*|*"AGENTIC_CONTAINMENT_BEGIN"*|*"AGENTIC_CONTAINMENT_END"*)
      printf 'GC-TOOL-001\n' ;;
    *"/dev/console"*|*"/dev/ttyS"*|*"/dev/tty0"*)
      printf 'GC-TOOL-002\n' ;;
    *"containment.log"*|*"/.gc/"*|*"> /var/log"*|*"truncate -s 0"*|*"sed -i"*)
      printf 'GC-LOG-002\n' ;;
    *) return 0 ;;
  esac
}

# Observed-first-use allowlist with a short learning window (design section 3):
# during the window unlisted executables are logged and allowed; after lock
# they are denied with the redacted command line.
gc_shim_allow() { # state_dir tool args... -> decision JSON on stdout
  local state_dir=$1 tool=$2; shift 2
  mkdir -p "$state_dir" || return 2
  local rule
  rule=$(gc_shim_classify "$tool" "$@")
  if [ -n "$rule" ]; then
    gc_decide "$state_dir" "$rule" "$tool $*" >/dev/null || return 2
    printf '{"decision":"deny","rule":"%s","tool":"%s"}\n' "$rule" "$tool"
    return 0
  fi
  local allow="$state_dir/allowlist" lock="$state_dir/allowlist.lock" start="$state_dir/learning_start"
  if [ ! -f "$start" ]; then printf '%s\n' "$(date +%s)" >"$start"; fi
  if [ ! -f "$lock" ] && [ $(( $(date +%s) - $(cat "$start") )) -ge "$GC_LEARNING_WINDOW_SECONDS" ]; then
    printf '%s\n' "$(date +%s)" >"$lock"
  fi
  if [ -f "$lock" ]; then
    if grep -F -x -- "$tool" "$allow" >/dev/null 2>&1; then
      printf '{"decision":"allow","tool":"%s","learned":false}\n' "$tool"
    else
      gc_decide "$state_dir" "unknown" "$tool $*" >/dev/null || return 2
      printf '{"decision":"deny","rule":"unknown","tool":"%s"}\n' "$tool"
    fi
  else
    if ! grep -F -x -- "$tool" "$allow" >/dev/null 2>&1; then
      printf '%s\n' "$tool" >>"$allow"
    fi
    # Learning-window observations are logged (design section 3): allowed, but
    # recorded as events so the learning window is auditable.
    gc_log_event "$state_dir" "shim" "unknown" "exec" "$tool $*" "observe" >/dev/null 2>&1 || true
    printf '{"decision":"allow","tool":"%s","learned":true}\n' "$tool"
  fi
}

# fs-watcher detection: only the job scratch root is writable; writes to the
# shim/agent trees are self-code-modification, everything else is
# write-outside-allowlist.
gc_fs_detect() { # state_dir path -> decision JSON
  local state_dir=$1 path=$2
  case "$path" in
    "$GC_WRITABLE_ROOT"|"$GC_WRITABLE_ROOT"/*)
      printf '{"decision":"allow","path":"%s"}\n' "$path" ;;
    /shims|/shims/*|/agent|/agent/*)
      gc_decide "$state_dir" GC-FSW-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-FSW-002","path":"%s"}\n' "$path" ;;
    */package.json|*/package-lock.json|*/pyproject.toml|*/requirements*.txt|/package.json|/pyproject.toml)
      gc_decide "$state_dir" GC-PKG-003 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-PKG-003","path":"%s"}\n' "$path" ;;
    /dev/*|/dev)
      # Write targets on devtmpfs could inject marker text (GC-TOOL-002).
      gc_decide "$state_dir" GC-TOOL-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-TOOL-002","path":"%s"}\n' "$path" ;;
    *"containment.log"*|*/.gc/*)
      gc_decide "$state_dir" GC-LOG-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-LOG-002","path":"%s"}\n' "$path" ;;
    *)
      gc_decide "$state_dir" GC-FSW-001 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-FSW-001","path":"%s"}\n' "$path" ;;
  esac
}

# find -newer sweep fallback for the fs-watcher: detect every path handed in.
gc_fs_sweep() { # state_dir path...
  local state_dir=$1; shift
  local path
  for path in "$@"; do gc_fs_detect "$state_dir" "$path"; done
}

# net-watcher detection: any socket row is a violation (GC-NET-001).
gc_net_detect() { # state_dir socket_entry
  local state_dir=$1 entry=$2
  [ -n "$entry" ] || return 0
  gc_decide "$state_dir" GC-NET-001 "$entry" >/dev/null || return 2
  printf '{"decision":"deny","rule":"GC-NET-001"}\n'
}

# proc-watcher detection: a process outside the job tree is an anomaly.
gc_proc_detect() { # state_dir process_identity
  local state_dir=$1 identity=$2
  gc_decide "$state_dir" unknown "proc $identity" >/dev/null || return 2
  printf '{"decision":"deny","rule":"unknown"}\n'
}

# Supervisor liveness (design section 1.3): a dead monitor loop is a
# containment failure and trips the killswitch immediately.
gc_liveness() { # state_dir alive_flags ("1 1 1"; any 0 is a dead loop)
  local state_dir=$1 flags=$2
  case " $flags " in
    *" 0 "*)
      gc_log_event "$state_dir" "watcher:proc" containment-integrity proc "monitor loop dead" >/dev/null || return 2
      gc_killswitch_trip "$state_dir" containment-integrity containment-integrity CRITICAL immediate null null >/dev/null || return 2
      printf '{"decision":"deny","rule":"containment-integrity","tier":"CRITICAL","mode":"immediate"}\n' ;;
    *) printf '{"decision":"allow"}\n' ;;
  esac
}

# B1: the one real receipt printf. The containment segment is passed as a %s
# argument (never interpolated into the format string, where it would stay
# literal under single quotes); an empty segment yields the v1 receipt shape.
gc_receipt_json() { # schema remote_host fixture_id domain marker marker_sha script_hash initramfs_sha containment_segment domain destroy_requested absent acl_before acl_after fs_ctx_sha net_ctx_sha
  printf '{"schema":"%s","ok":true,"status":"VERIFIED","authorityCreated":false,"runtimeActivated":false,"persisted":false,"identity":{"remoteHost":"%s","fixtureId":"%s","domain":"%s"},"marker":{"value":"%s","sha256":"%s"},"scriptHash":"%s","initramfsSha256":"%s"%s,"teardown":{"domain":{"name":"%s","transient":true,"destroyOnExit":true,"destroyRequested":%s,"absent":%s,"checked":true,"check":"virsh dominfo/list"},"acl":{"beforeSha256":"%s","afterSha256":"%s","equal":true,"checked":true,"initramfsEntryRemoved":true}},"context":{"filesystem":{"summary":"disk=absent host-share=absent credentials=absent gpu=absent","disk":false,"hostShare":false,"credentials":false,"gpu":false,"sha256":"%s"},"network":{"summary":"network=absent","guest":false,"sha256":"%s"},"guestMounts":["proc","sysfs","devtmpfs"]}}\n' "$@"
}

# Terminal event for a session that ends without a killswitch trip: the
# envelope then carries only log lines plus this session-end record
# (design section 5: a session with neither is containment-evidence-missing).
gc_session_end() { # state_dir
  local state_dir=$1 log="$state_dir/containment.log.jsonl"
  local seq=1
  if [ -f "$state_dir/seq" ]; then seq=$(( $(cat "$state_dir/seq") + 1 )); fi
  printf '%s\n' "$seq" >"$state_dir/seq"
  local tsha
  tsha=$(sha256sum "$state_dir/taxonomy.json" | awk '{print $1}') || return 2
  printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"supervisor","class":"session-end","action":"complete","summary":true}}\n' \
    "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$(gc_iso8601)" "$seq" >>"$log"
}

# Host-side containment evidence (design section 5): extract the framed base64
# envelope from the console transcript, decode it pty-safe, recompute the log
# digest per the stated normalization, and cross-check the terminal killswitch
# event's embedded digest against the full payload.
gc_containment_evidence() { # transcript fixture_id -> containment block JSON on stdout
  local transcript=$1 fid=$2
  local begin="AGENTIC_CONTAINMENT_BEGIN:$fid" end="AGENTIC_CONTAINMENT_END:$fid"
  local b64 tmp log_sha events denials ks_line ks_rule tripped rule_json
  tmp="$transcript.containment.$$"
  trap 'rm -f "$tmp" "$tmp.b64" "$tmp.head"' RETURN
  # H2: exactly one envelope pair may exist; more than one is a forgery or a
  # replay attempt and fails closed.
  # Count with index() so pty CR suffixes do not defeat the anchor.
  begins=$(awk -v b="$begin" 'index($0, b) == 1 { n++ } END { print n + 0 }' "$transcript")
  ends=$(awk -v e="$end" 'index($0, e) == 1 { n++ } END { print n + 0 }' "$transcript")
  if [ "$begins" -ne 1 ] || [ "$ends" -ne 1 ]; then
    return 1
  fi
  if ! awk -v b="$begin" -v e="$end" 'index($0, b) == 1 { inside = 1; next } index($0, e) == 1 { inside = 0; next } inside' "$transcript" | tr -d '\r' >"$tmp.b64"; then
    return 1
  fi
  if ! [ -s "$tmp.b64" ]; then return 1; fi
  if ! { base64 -d <"$tmp.b64" >"$tmp" 2>/dev/null || base64 -D <"$tmp.b64" >"$tmp" 2>/dev/null; }; then return 1; fi
  if ! grep -q '"schema":"' "$tmp"; then return 1; fi
  ks_line=$(grep '"final":true' "$tmp" | tail -n 1)
  ks_num=$(grep -n '"final":true' "$tmp" | tail -n 1 | cut -d: -f1)
  if [ -n "$ks_line" ]; then
    # Digest chain (H1): verified at the killswitch line's position — the
    # digest covers the log up to and including the trigger event but
    # excluding the killswitch line itself; anything after it is post-trip
    # noise the guest's log freeze should have prevented, and is ignored for
    # the digest rather than silently trusted.
    ks_sha=$(printf '%s\n' "$ks_line" | sed -n 's/.*"logSha256":"\([0-9a-f]*\)".*/\1/p')
    sed -n "1,$((ks_num - 1))p" "$tmp" >"$tmp.head" 2>/dev/null || return 1
    chained_sha=$(sha256sum "$tmp.head" | awk '{print $1}') || return 1
    if [ -z "$ks_sha" ] || [ "$ks_sha" != "$chained_sha" ]; then return 2; fi
    tripped=true
    log_sha=$ks_sha
    ks_rule=$(printf '%s\n' "$ks_line" | sed -n 's/.*"trigger":{"rule":"\([A-Za-z0-9_-]*\)".*/\1/p')
    ks_class=$(printf '%s\n' "$ks_line" | sed -n 's/.*"trigger":{"rule":"[A-Za-z0-9_-]*","class":"\([A-Za-z0-9_-]*\)".*/\1/p')
    ks_tier=$(printf '%s\n' "$ks_line" | sed -n 's/.*"tier":"\([A-Za-z]*\)".*/\1/p')
    rule_json="\"$ks_rule\""
    class_json="\"$ks_class\""
    tier_json="\"$ks_tier\""
    counted=$((ks_num - 1))
  else
    # Fail-closed: without a killswitch record the session must end with the
    # clean session-end terminal event.
    grep -q '"class":"session-end"' "$tmp" || return 1
    tripped=false
    rule_json=null
    class_json=null
    tier_json=null
    log_sha=$(sha256sum "$tmp" | awk '{print $1}') || return 1
    counted=$(grep -c '"schema":"' "$tmp")
  fi
  events=$counted
  denials=$(grep -c '"action":"deny"' "$tmp")
  # M1: compact histogram (design section 4; open question 4 decided) — the
  # coordinator consumes aggregates from the receipt without extra tooling.
  # Terminal killswitch records are echoes, not events; exclude them.
  histogram=$(awk '{
    if ($0 !~ /guest-containment.killswitch.v1/ && match($0, /"class":"[^"]*"/)) {
      c = substr($0, RSTART + 9, RLENGTH - 10); n[c]++
    }
  } END { first = 1; printf "{"; for (k in n) { if (!first) printf ","; printf "\"%s\":%d", k, n[k]; first = 0 } printf "}" }' "$tmp")
  rm -f "$tmp" "$tmp.b64" "$tmp.head"
  printf '{"schema":"%s","taxonomySha256":"%s","logSha256":"%s","events":%s,"denials":%s,"histogram":%s,"killswitch":{"tripped":%s,"rule":%s,"class":%s,"tier":%s,"guestPoweroff":true,"final":true}}' \
    "$GC_LOG_SCHEMA" "$GC_TAXONOMY_SHA256" "$log_sha" "$events" "$denials" "$histogram" "$tripped" "$rule_json" "$class_json" "$tier_json"
}

GC_CORE_EOF
  exit 0
fi
if [ "${1:-}" = "--gc-receipt-print" ]; then
  shift
  # Print-only hook (B1): executes the real receipt printf with
  # test-supplied computed values; segment "-" means empty (v1 shape).
  receipt_segment=""
  if [ "${9:-}" != "-" ]; then receipt_segment="$9"; fi
  gc_receipt_json "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$receipt_segment" "${10}" "${11}" "${12}" "${13}" "${14}" "${15}" "${16}"
  exit 0
fi
if [ "${1:-}" = "--gc-envelope-extract" ]; then
  shift
  gc_containment_evidence "$@" || {
    printf 'microvm failure phase=evidence code=containment-evidence-missing\n' >&2
    exit 1
  }
  printf '\n'
  exit 0
fi
if [ "${1:-}" = "--gc-taxonomy-sha" ]; then
  computed=$(gc_embedded_taxonomy | sha256sum | awk '{print $1}')
  if [ "$computed" != "$GC_TAXONOMY_SHA256" ]; then
    printf 'microvm failure phase=setup code=taxonomy-digest-mismatch\n' >&2
    exit 2
  fi
  printf '%s\n' "$computed"
  exit 0
fi

# Containment job payload helpers (design sections 1.3, 3): transport is
# base64 on the argv (shell-safe for the ssh remote-shell command string; see
# the tool side); decode here, then validate the text: printable ASCII,
# newline, tab only, at most 8192 bytes. Never model-set. Absent payload =
# plain proof mode.
gc_payload_decode() { # b64 -> decoded payload text on stdout
  local b64=$1 text
  case "$b64" in
    ""|*[!A-Za-z0-9+/=]*) return 2 ;;
  esac
  text=$(printf '%s' "$b64" | base64 -d 2>/dev/null) \
    || text=$(printf '%s' "$b64" | base64 -D 2>/dev/null) \
    || return 2
  printf '%s' "$text"
}
gc_payload_text_ok() { # payload text -> 0 ok, 2 invalid
  local bad_pattern
  [ "${#1}" -ge 1 ] || return 2
  [ "${#1}" -le 8192 ] || return 2
  # Allowed: printable ASCII (space..~), tab, newline. The forbidden-class
  # pattern is built with printf because a literal tab cannot be written in
  # a case/glob bracket via \t (that is an escaped letter, not a tab).
  bad_pattern=$(printf '[^ -~\t]')
  if printf '%s' "$1" | LC_ALL=C grep -q -- "$bad_pattern"; then return 2; fi
}
if [ "${1:-}" = "--gc-payload-validate" ]; then
  shift
  text=$(gc_payload_decode "${1:-}") || { printf 'microvm failure phase=setup code=2 detail=invalid containment job payload (base64 transport)\n' >&2; exit 2; }
  gc_payload_text_ok "$text" || { printf 'microvm failure phase=setup code=2 detail=invalid containment job payload (printable ASCII, newline, tab, at most 8192 bytes)\n' >&2; exit 2; }
  printf '%s\n' "$text"
  exit 0
fi

phase=setup
# Exactly: fixture id + script hash, plus the optional allocation pair and
# optional base64 job payload (2..5 args). The tool always passes 4 (plain
# proof) or 5 (containment); fewer or more is an invocation error.
if [ "$#" -lt 2 ] || [ "$#" -gt 5 ]; then
  printf 'microvm failure phase=identity code=2 detail=fixture id and script hash are required (optional vcpu, memoryMiB, base64 job payload)\n' >&2
  exit 2
fi
fixture_id=$1
script_hash=$2
vcpu_arg=${3:-}
memory_arg=${4:-}
containment_payload_b64=${5:-}
fixture_fail() {
  local code=$1
  shift
  printf 'microvm failure phase=%s code=%s detail=%s\n' "$phase" "$code" "$*" >&2
  exit "$code"
}
case "$fixture_id" in
  ""|*[!A-Za-z0-9._-]*) fixture_fail 2 'unsafe fixture id' ;;
esac
if [ "${#script_hash}" -ne 64 ]; then fixture_fail 2 'invalid fixture script hash'; fi
case "$script_hash" in
  ""|*[!0-9a-f]*) fixture_fail 2 'invalid fixture script hash' ;;
esac
# Containment job payload (main path): decode the base64 argv and validate
# the text; the helpers above are shared with the --gc-payload-validate hook.
if [ -n "$containment_payload_b64" ]; then
  if ! containment_payload=$(gc_payload_decode "$containment_payload_b64"); then
    fixture_fail 2 'invalid containment job payload (base64 transport)'
  fi
  gc_payload_text_ok "$containment_payload" \
    || fixture_fail 2 'invalid containment job payload (printable ASCII, newline, tab, at most 8192 bytes)'
fi
# Elastic resource allocation (design section 6.1): user-configured via the
# target config, validated here; defaults are the proof values. Never
# model-set (the tool exposes no parameters for it).
validate_vcpu() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 64 ]; }
validate_memory() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 64 ] && [ "$1" -le 1048576 ]; }
if ! validate_vcpu "$vcpu_arg"; then fixture_fail 2 'invalid vcpu allocation (integer 1-64)'; fi
if ! validate_memory "$memory_arg"; then fixture_fail 2 'invalid memory allocation (integer 64-1048576 MiB)'; fi
vcpu=${vcpu_arg:-1}
memory_mib=${memory_arg:-128}

state_root="$HOME/agentic-driver-state/cutover-fixtures/microvm"
fixture_root="$state_root/$fixture_id"
domain="agentic-driver-$fixture_id"
kernel="/boot/vmlinuz-$(uname -r)"
marker="AGENTIC_MICROVM_PROBE:$fixture_id"
acl_backup="$fixture_root/home.acl.before"
acl_after="$fixture_root/home.acl.after"
initramfs="$fixture_root/initramfs.cpio.gz"
initramfs_acl_after="$fixture_root/initramfs.acl.after"
initramfs_build_log="$fixture_root/initramfs.build.log"
console_error="$fixture_root/console.stderr"
receipt_schema="agentic-driver.linux-microvm-cutover.v1"

mkdir -p "$state_root" || fixture_fail 3 'fixture state root could not be created'
if ! mkdir "$fixture_root"; then
  fixture_fail 3 'fixture already exists'
fi
if ! getfacl -p "$HOME" >"$acl_backup"; then
  fixture_fail 3 'home ACL snapshot could not be captured'
fi
home_acl_applied=false
initramfs_acl_applied=false
domain_started=false
domain_destroy_requested=false
recorder_pid=""
acl_restored=false
domain_absent=false

if ! home_acl_before_sha=$(sha256sum "$acl_backup" | awk '{print $1}'); then
  fixture_fail 3 'home ACL snapshot digest could not be computed'
fi

cleanup_failed=false
cleanup_error_count=0
cleanup_error() {
  cleanup_failed=true
  cleanup_error_count=$((cleanup_error_count + 1))
  local detail=${1:-'unspecified cleanup failure'}
  detail=$(printf '%s' "$detail" | tr '\r\n' ' ' | cut -c1-400)
  printf 'microvm cleanup failure code=cleanup-failed detail=%s\n' "$detail" >&2
}
run_cleanup() {
  local label=$1
  shift
  local output status
  output=$("$@" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    cleanup_error "$label exit=$status ${output:-no diagnostic}"
  fi
  return "$status"
}

domain_state() {
  local names
  if virsh dominfo "$domain" >/dev/null 2>&1; then
    printf 'present'
    return 0
  fi
  if ! names=$(virsh list --all --name 2>&1); then
    printf 'domain absence query failed: %s\n' "${names:-no diagnostic}" >&2
    return 2
  fi
  if grep -F -x -- "$domain" <<<"$names" >/dev/null; then
    printf 'present'
  else
    local match_status=$?
    if [ "$match_status" -eq 1 ]; then
      printf 'absent'
    else
      printf 'domain name absence query failed\n' >&2
      return 2
    fi
  fi
}

assert_domain_absent() {
  local state
  if ! state=$(domain_state); then return 2; fi
  if [ "$state" != absent ]; then return 1; fi
  return 0
}

verify_initramfs_acl_removed() {
  if ! getfacl -p "$initramfs" >"$initramfs_acl_after"; then return 1; fi
  if grep -F 'user:libvirt-qemu:' "$initramfs_acl_after" >/dev/null; then
    return 1
  else
    local match_status=$?
    if [ "$match_status" -eq 1 ]; then return 0; fi
    return 2
  fi
}

cleanup_recorder() {
  if [ -z "$recorder_pid" ]; then
    printf 'microvm cleanup recorder=no-op\n' >&2
    return
  fi
  if kill -0 "$recorder_pid" 2>/dev/null; then
    if run_cleanup 'stop console recorder' kill "$recorder_pid"; then
      printf 'microvm cleanup recorder=terminated\n' >&2
    fi
  else
    printf 'microvm cleanup recorder=no-op\n' >&2
  fi
}

cleanup_domain() {
  local state
  if [ "$domain_started" != true ]; then
    printf 'microvm cleanup domain=no-op\n' >&2
    return
  fi
  if state=$(domain_state); then
    if [ "$state" = present ]; then
      domain_destroy_requested=true
      run_cleanup "destroy domain $domain" virsh destroy "$domain"
    fi
  else
    cleanup_error 'domain absence query failed during cleanup'
  fi
  if state=$(domain_state); then
    if [ "$state" = absent ]; then
      printf 'microvm cleanup domain=checked-absent\n' >&2
    else
      cleanup_error "domain $domain remains present after cleanup"
    fi
  else
    cleanup_error 'final domain absence query failed during cleanup'
  fi
}

cleanup_acl() {
  if [ "$initramfs_acl_applied" = true ]; then
    if [ -e "$initramfs" ]; then
      run_cleanup 'remove initramfs ACL' setfacl -x u:libvirt-qemu "$initramfs"
      if verify_initramfs_acl_removed; then
        initramfs_acl_applied=false
      else
        cleanup_error 'initramfs ACL removal could not be verified'
      fi
    else
      printf 'microvm cleanup initramfs_acl=no-op-target-absent\n' >&2
      initramfs_acl_applied=false
    fi
  else
    printf 'microvm cleanup initramfs_acl=no-op\n' >&2
  fi

  if [ "$home_acl_applied" = true ]; then
    run_cleanup 'restore home ACL' setfacl --restore="$acl_backup"
    if getfacl -p "$HOME" >"$acl_after"; then
      if cmp -s "$acl_backup" "$acl_after"; then
        if home_acl_after_sha=$(sha256sum "$acl_after" | awk '{print $1}'); then
          home_acl_applied=false
          acl_restored=true
        else
          cleanup_error 'restored home ACL digest could not be computed'
        fi
      else
        cleanup_error 'restored home ACL differs from home.acl.before'
      fi
    else
      cleanup_error 'restored home ACL could not be captured'
    fi
  else
    printf 'microvm cleanup home_acl=no-op\n' >&2
  fi
}

cleanup_on_exit() {
  local original_status=$?
  trap - EXIT INT TERM HUP
  set +e
  cleanup_recorder
  cleanup_domain
  cleanup_acl
  if [ "$cleanup_failed" = true ]; then
    printf 'microvm cleanup summary=failed errors=%s\n' "$cleanup_error_count" >&2
    exit 70
  fi
  printf 'microvm cleanup summary=clean\n' >&2
  exit "$original_status"
}
trap cleanup_on_exit EXIT INT TERM HUP

phase=preflight
for tool in /usr/bin/qemu-system-x86_64 /usr/bin/busybox /usr/bin/cpio /usr/bin/gzip /usr/bin/setfacl /usr/bin/getfacl; do
  if ! test -x "$tool"; then fixture_fail 4 "required tool unavailable: $tool"; fi
done
if ! test -r /dev/kvm -a -w /dev/kvm; then fixture_fail 4 '/dev/kvm is unavailable'; fi
if ! test -e "$kernel"; then fixture_fail 4 "kernel unavailable: $kernel"; fi
if state=$(domain_state); then
  if [ "$state" != absent ]; then fixture_fail 5 'fixture domain already exists'; fi
else
  fixture_fail 5 'fixture domain absence could not be established'
fi

phase=build
root="$fixture_root/root"
if ! mkdir -p "$root/bin" "$root/proc" "$root/sys" "$root/dev" "$root/etc"; then fixture_fail 6 'guest root could not be created'; fi
if ! cp /usr/bin/busybox "$root/bin/busybox"; then fixture_fail 6 'BusyBox could not be copied'; fi
applet_list=$(/usr/bin/busybox --list 2>/dev/null || true)
for name in sh mount poweroff uname mkdir cat sed awk grep cut wc head tail find tr date touch sha256sum sleep kill ps base64; do
  if ! grep -qx "$name" <<<"$applet_list"; then fixture_fail 6 "BusyBox applet unavailable: $name"; fi
  if ! ln -s busybox "$root/bin/$name"; then fixture_fail 6 "BusyBox link could not be created: $name"; fi
done
# Optional applets: inotifyd upgrades the fs-watcher to event-driven when the
# build has it (design section 1.2); setsid gives the job its own process group.
have_inotifyd=false
have_setsid=false
if grep -qx inotifyd <<<"$applet_list"; then
  ln -s busybox "$root/bin/inotifyd" && have_inotifyd=true
fi
if grep -qx setsid <<<"$applet_list"; then
  ln -s busybox "$root/bin/setsid" && have_setsid=true
fi
if ! mkdir -p "$root/gc" "$root/shims" "$root/tmp"; then fixture_fail 6 'containment guest directories could not be created'; fi
# The guest containment core is embedded verbatim as its own heredoc (like
# the taxonomy embed): one source of truth for taxonomy, log, and killswitch
# semantics, with no dependency on $0 — the fixture streams over SSH via
# `bash -s` (stdin), where there is no script file to read back. The host
# side still runs the same core as functions defined below; tests assert the
# two can never drift. The initramfsSha256 covers the embedded result.
if ! cat >"$root/gc/core.sh" <<'GC_CORE_EOF'
# --- guest containment core (taxonomy, structured log, killswitch decision) ---
# Design: /Users/julen/pi-dev-env/evidence/GUEST_CONTAINMENT_DESIGN.md sections
# 2 (taxonomy), 2.0 (severity tiers), 4 (log format), 5 (killswitch semantics).
# Watchers and shims arrive in a later step; this core is callable and testable
# through the --gc-decide / --gc-log / --gc-taxonomy-sha hooks below.
GC_TAXONOMY_VERSION="guest-containment-taxonomy.v1"
GC_LOG_SCHEMA="agentic-driver.guest-containment.log.v1"
GC_KILLSWITCH_SCHEMA="agentic-driver.guest-containment.killswitch.v1"
GC_TAXONOMY_SHA256="2d3f781c1594a5cefb77560419faff1619bc90012fc20b339a79110dbaa847c9"
# Severity tiers (design section 2.0): CRITICAL/HIGH trip immediately,
# ELEVATED/ANOMALY accumulate pressure within a sliding time window.
GC_WINDOW_SECONDS=60
GC_ELEVATED_THRESHOLD=5
GC_ANOMALY_THRESHOLD=10
GC_LOG_CAP_BYTES=8192
GC_LOG_TRUNC=512

gc_embedded_taxonomy() {
  cat <<'GC_TAXONOMY_EOF'
{
  "schema": "guest-containment-taxonomy.v1",
  "description": "Deny-by-default rule taxonomy for the guest containment monitor (design GUEST_CONTAINMENT_DESIGN.md section 2). One rule per line; IDs are never reused; new rules append. disposition records whether a live detector exists in the fixture (design sections 1.3, 3) or the rule is armed by the taxonomy only.",
  "rules": [
    {"id":"GC-PKG-001","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"package-manager-install: invocation of npm install, npm ci, pip install, yarn add, pnpm add, gem install, cargo install, apk add, apt install","evidence":"METR autonomous-replication evaluation work (arXiv:2403.13793); HF incident dependency-install persistence step","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-PKG-002","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"registry-write-command: npm publish, npm token, .npmrc writes, pip config, keyring writes","evidence":"HF incident: agent attempted package publication","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-PKG-003","class":"GC-PKG","severity":"ELEVATED","action":"deny","match":"package-metadata-tamper: writes to package.json, package-lock.json, pyproject.toml, requirements*.txt outside the job scratch space","evidence":"METR evaluation logs: dependency-manifest tampering as persistence step","since":"v1","disposition":"detector:fs-path+shim-argv"},
    {"id":"GC-FSW-001","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"write-outside-allowlist: create/append/truncate on any path outside /tmp/session, detected by inotifyd or find -newer sweeps","evidence":"METR evaluation logs: out-of-bounds file writes during evaluation runs","since":"v1","disposition":"detector:fs-watcher"},
    {"id":"GC-FSW-002","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"self-code-modification: writes under the agent job install/execution directories including the shim tree /shims/","evidence":"HF incident: agent rewrote the repository it was working in; monitor self-rewrite defense","since":"v1","disposition":"detector:fs-watcher"},
    {"id":"GC-FSW-003","class":"GC-FSW","severity":"ELEVATED","action":"deny","match":"file-growth-anomaly: unexpected growth in cache/package directories (~/.npm, ~/.cache/pip, /var/cache/*) beyond the size-delta threshold","evidence":"METR evaluation logs: bulk cache staging of payloads","since":"v1","disposition":"taxonomy-only-until-detector: needs cache size-delta sampling in the sweep (later step)"},
    {"id":"GC-SHR-001","class":"GC-SHR","severity":"HIGH","action":"deny","match":"shared-cache-write: writes to paths shared with other agents or the coordinator; with host-share absent any such attempt is a deny","evidence":"receipt proves host-share=absent; writes would indicate boundary violation","since":"v1","disposition":"taxonomy-only-until-detector: host share absent in this fixture; auto-arm when a share mount exists"},
    {"id":"GC-SHR-002","class":"GC-SHR","severity":"HIGH","action":"deny","match":"cross-agent-channel: creation of or writes to inter-agent coordination paths (maildirs, task-queue files, agent state files)","evidence":"HF incident multi-agent escalation; METR coordination/sabotage threat model","since":"v1","disposition":"taxonomy-only-until-detector: coordination-path heuristics deferred to avoid false positives"},
    {"id":"GC-NET-001","class":"GC-NET","severity":"HIGH","action":"deny","match":"socket-open: any entry in /proc/net/tcp, /proc/net/tcp6, /proc/net/udp at any sweep","evidence":"fixture boots with no network device; any socket is exfiltration-capable","since":"v1","disposition":"detector:net-proc-sweep"},
    {"id":"GC-NET-002","class":"GC-NET","severity":"HIGH","action":"deny","match":"network-tool-invocation: shim-detects wget, curl, nc, ssh, telnet, ping regardless of arguments","evidence":"METR self-replication exfiltration patterns; HF incident remote control","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-CRED-001","class":"GC-CRED","severity":"CRITICAL","action":"deny","match":"credential-path-read: opens of ~/.ssh/, ~/.aws/, ~/.netrc, ~/.git-credentials, token files","evidence":"credential theft is step one in every reported agent-escape chain","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-CRED-002","class":"GC-CRED","severity":"CRITICAL","action":"deny","match":"env-secret-probing: attempts to dump or scan the environment for secret-shaped keys","evidence":"METR evaluation logs; HF incident postmortem credential harvest attempts","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-LOG-001","class":"GC-LOG","severity":"CRITICAL","action":"deny","match":"transcript-write: writes to the console transcript, the monitor log, or the receipt channel by any path other than the supervisor","evidence":"log is opened append-only by the supervisor; other writers are evidence tampering","since":"v1","disposition":"taxonomy-only-until-detector: console transcript attribution requires supervisor fd discipline"},
    {"id":"GC-LOG-002","class":"GC-LOG","severity":"CRITICAL","action":"deny","match":"log-truncate-or-rename: >, rm, mv, truncate, sed -i targeting monitor/agent logs","evidence":"METR report: models attempting to edit their own logs","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-TOOL-001","class":"GC-TOOL","severity":"CRITICAL","action":"deny","match":"receipt-forgery: job printing AGENTIC_MICROVM_PROBE:* or AGENTIC_MICROVM_RECEIPT:* lines","evidence":"host closed-receipt parsing rejects forged output; guest-side denial closes the loop","since":"v1","disposition":"detector:shim-argv"},
    {"id":"GC-TOOL-002","class":"GC-TOOL","severity":"CRITICAL","action":"deny","match":"marker-injection: writes to /dev/console, /dev/ttyS0, or other devtmpfs write targets that could inject marker text","evidence":"METR tool-call spoofing family; serial stream integrity","since":"v1","disposition":"detector:shim-argv+fs-path; known gap: char-device writes may not update mtime for the sweep"}
  ],
  "residual": {"class":"unknown","tier":"ANOMALY","action":"deny","note":"everything not allowlisted and not classified above; accumulates toward the ANOMALY threshold"}
}
GC_TAXONOMY_EOF
}

gc_iso8601() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Redaction per design section 4: strip control characters, replace
# secret-shaped assignments with [REDACTED].
gc_redact() {
  tr -d '\000-\010\013\014\016-\037' | sed -E 's/[A-Za-z0-9_-]*([Tt]oken|TOKEN|[Ss]ecret|SECRET|[Pp]ass[A-Za-z]*|PASS[A-Za-z]*|[Cc]redential|CREDENTIAL|[Aa]pi[_-]?[Kk]ey|API[_-]?KEY|[Pp]rivate[_-]?[Kk]ey|PRIVATE[_-]?KEY)[A-Za-z0-9_-]*[=:][^ ",;&]+/[REDACTED]/g'
}

# Extract a string field from the rule object whose "id" matches rule_id.
gc_rule_field() { # taxonomy_file rule_id field
  sed -n "s/.*\"id\": *\"$2\"[^}]*\"$3\": *\"\([A-Za-z-]*\)\".*/\1/p" "$1" | head -n 1
}

gc_log_event() { # state_dir source class subject_type subject_value [action]
  local state_dir=$1 source=$2 class=$3 stype=$4 svalue=$5 action=${6:-deny}
  # Log freeze (design section 5): once a killswitch trip is recorded the log
  # is frozen; appends after the trip would break the terminal digest chain.
  if [ -f "$state_dir/kill" ]; then return 0; fi
  mkdir -p "$state_dir"
  local log="$state_dir/containment.log.jsonl"
  local tax="$state_dir/taxonomy.json"
  if [ ! -f "$tax" ]; then gc_embedded_taxonomy >"$tax" || return 2; fi
  local tsha
  tsha=$(sha256sum "$tax" | awk '{print $1}') || return 2
  local seq=1
  if [ -f "$state_dir/seq" ]; then seq=$(( $(cat "$state_dir/seq") + 1 )); fi
  printf '%s\n' "$seq" >"$state_dir/seq"
  svalue=${svalue//\\/}
  svalue=${svalue//\"/}
  svalue=$(printf '%s' "$svalue" | gc_redact | cut -c1-"$GC_LOG_TRUNC")
  local ts record
  ts=$(gc_iso8601)
  # Summary-only degradation on flood (design section 4): context dropped,
  # events never silently discarded.
  if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt "$GC_LOG_CAP_BYTES" ]; then
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"%s","summary":true}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class" "$action")
  else
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"%s","subject":{"type":"%s","value":"%s"}}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class" "$action" "$stype" "$svalue")
  fi
  printf '%s\n' "$record" >>"$log"
  printf '%s\n' "$record"
}

gc_killswitch_trip() { # state_dir rule_id class tier mode pressure threshold
  local state_dir=$1 rule_id=$2 class=$3 tier=$4 mode=$5 pressure=${6:-null} threshold=${7:-null}
  local log="$state_dir/containment.log.jsonl"
  local ks event log_sha
  event=$(printf '{"schema":"%s","session":"%s","trigger":{"rule":"%s","class":"%s","tier":"%s","mode":"%s","pressure":%s,"threshold":%s},"final":true}' \
    "$GC_KILLSWITCH_SCHEMA" "$(basename "$state_dir")" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold")
  printf '%s\n' "$event" >>"$log"
  log_sha=$(sha256sum "$log" | awk '{print $1}') || return 2
  # Terminal killswitch event with log digest (design section 5, step 1).
  ks=$(printf '{"schema":"%s","session":"%s","trigger":{"rule":"%s","class":"%s","tier":"%s","mode":"%s","pressure":%s,"threshold":%s},"logSha256":"%s","final":true}' \
    "$GC_KILLSWITCH_SCHEMA" "$(basename "$state_dir")" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold" "$log_sha")
  printf '%s\n' "$ks" >>"$log"
  # Kill flag: the guest supervisor polls this and executes the kill path
  # (kill process group, sync, poweroff -f); host-side hooks ignore it.
  printf '%s\n' "$mode" >"$state_dir/kill" 2>/dev/null || true
  printf '%s\n' "$ks"
}

gc_window_pressure() { # pressure_file
  local now cutoff
  now=$(date +%s)
  cutoff=$((now - GC_WINDOW_SECONDS))
  if [ ! -f "$1" ]; then printf '0\n'; return 0; fi
  awk -v cutoff="$cutoff" '$1 > cutoff {n++} END {print n + 0}' "$1"
}

# Killswitch decision function (design sections 2.0 and 5): given a rule hit,
# CRITICAL/HIGH trip immediately; ELEVATED/ANOMALY increment per-class pressure
# within the sliding window and trip on threshold. Returns a decision JSON on
# stdout; a trip also appends the terminal killswitch event to the log.
gc_decide() { # state_dir rule_id [subject_value]
  local state_dir=$1 rule_id=$2 svalue=${3:-}
  mkdir -p "$state_dir" || return 2
  local tax="$state_dir/taxonomy.json"
  if [ ! -f "$tax" ]; then gc_embedded_taxonomy >"$tax" || return 2; fi
  local severity class tier mode=immediate pressure=null threshold=null tripped=false
  severity=$(gc_rule_field "$tax" "$rule_id" severity)
  if [ -z "$severity" ]; then
    # Residual deny-by-default class (design section 2, GC-UNKNOWN).
    severity=ANOMALY
    class=unknown
  else
    class=$(gc_rule_field "$tax" "$rule_id" class)
  fi
  case "$severity" in
    CRITICAL|HIGH)
      tier=$severity
      tripped=true
      mode=immediate
      ;;
    ELEVATED|ANOMALY)
      tier=$severity
      mode=aggregate
      local pfile="$state_dir/pressure.$class"
      printf '%s\n' "$(date +%s)" >>"$pfile"
      pressure=$(gc_window_pressure "$pfile")
      if [ "$severity" = ELEVATED ]; then threshold=$GC_ELEVATED_THRESHOLD; else threshold=$GC_ANOMALY_THRESHOLD; fi
      if [ "$pressure" -ge "$threshold" ]; then tripped=true; fi
      ;;
    *)
      return 2
      ;;
  esac
  gc_log_event "$state_dir" "shim" "$class" "exec" "$svalue" >/dev/null || return 2
  if [ "$tripped" = true ]; then
    gc_killswitch_trip "$state_dir" "$rule_id" "$class" "$tier" "$mode" "$pressure" "$threshold" >/dev/null || return 2
  fi
  printf '{"rule":"%s","class":"%s","severity":"%s","tier":"%s","tripped":%s,"mode":"%s","pressure":%s,"threshold":%s}\n' \
    "$rule_id" "$class" "$severity" "$tier" "$tripped" "$mode" "$pressure" "$threshold"
}

# --- detection (design section 1.3, 3): shim classification, allowlist,
# fs/net/proc detection, supervisor liveness. Callable from the guest
# (sourced by /init and the shim dispatcher) and from the host test hooks.
GC_LEARNING_WINDOW_SECONDS=${GC_LEARNING_WINDOW_SECONDS:-3}
GC_WRITABLE_ROOT="/tmp/session"

# Shim classification: map a command line to a taxonomy rule id (empty means
# unclassified; unclassified executables go through the observed-first-use
# allowlist, design section 3).
gc_shim_classify() { # tool args...
  local tool=$1; shift
  # busybox <applet> shim bypass (design section 9.1): classify the effective
  # applet line instead of trusting the tool name.
  if [ "$tool" = "busybox" ] && [ "$#" -ge 1 ]; then
    gc_shim_classify "$1" "${@:2}"
    return
  fi
  local line="$tool $*"
  case "$tool" in
    wget|curl|nc|ssh|telnet|ping) printf 'GC-NET-002\n'; return 0 ;;
    printenv) printf 'GC-CRED-002\n'; return 0 ;;
  esac
  case "$line" in
    *"npm install"*|*"npm ci"*|*"pip install"*|*"yarn add"*|*"pnpm add"*|*"gem install"*|*"cargo install"*|*"apk add"*|*"apt install"*)
      printf 'GC-PKG-001\n' ;;
    *"npm publish"*|*"npm token"*|*".npmrc"*|*"pip config"*)
      printf 'GC-PKG-002\n' ;;
    *".ssh/"*|*".aws/"*|*".netrc"*|*".git-credentials"*)
      printf 'GC-CRED-001\n' ;;
    *"env | grep"*|*"env | grep -i"*)
      printf 'GC-CRED-002\n' ;;
    *"package.json"*|*"package-lock.json"*|*"pyproject.toml"*|*"requirements"*.txt*)
      printf 'GC-PKG-003\n' ;;
    *"AGENTIC_MICROVM_PROBE"*|*"AGENTIC_MICROVM_RECEIPT"*|*"AGENTIC_CONTAINMENT_BEGIN"*|*"AGENTIC_CONTAINMENT_END"*)
      printf 'GC-TOOL-001\n' ;;
    *"/dev/console"*|*"/dev/ttyS"*|*"/dev/tty0"*)
      printf 'GC-TOOL-002\n' ;;
    *"containment.log"*|*"/.gc/"*|*"> /var/log"*|*"truncate -s 0"*|*"sed -i"*)
      printf 'GC-LOG-002\n' ;;
    *) return 0 ;;
  esac
}

# Observed-first-use allowlist with a short learning window (design section 3):
# during the window unlisted executables are logged and allowed; after lock
# they are denied with the redacted command line.
gc_shim_allow() { # state_dir tool args... -> decision JSON on stdout
  local state_dir=$1 tool=$2; shift 2
  mkdir -p "$state_dir" || return 2
  local rule
  rule=$(gc_shim_classify "$tool" "$@")
  if [ -n "$rule" ]; then
    gc_decide "$state_dir" "$rule" "$tool $*" >/dev/null || return 2
    printf '{"decision":"deny","rule":"%s","tool":"%s"}\n' "$rule" "$tool"
    return 0
  fi
  local allow="$state_dir/allowlist" lock="$state_dir/allowlist.lock" start="$state_dir/learning_start"
  if [ ! -f "$start" ]; then printf '%s\n' "$(date +%s)" >"$start"; fi
  if [ ! -f "$lock" ] && [ $(( $(date +%s) - $(cat "$start") )) -ge "$GC_LEARNING_WINDOW_SECONDS" ]; then
    printf '%s\n' "$(date +%s)" >"$lock"
  fi
  if [ -f "$lock" ]; then
    if grep -F -x -- "$tool" "$allow" >/dev/null 2>&1; then
      printf '{"decision":"allow","tool":"%s","learned":false}\n' "$tool"
    else
      gc_decide "$state_dir" "unknown" "$tool $*" >/dev/null || return 2
      printf '{"decision":"deny","rule":"unknown","tool":"%s"}\n' "$tool"
    fi
  else
    if ! grep -F -x -- "$tool" "$allow" >/dev/null 2>&1; then
      printf '%s\n' "$tool" >>"$allow"
    fi
    # Learning-window observations are logged (design section 3): allowed, but
    # recorded as events so the learning window is auditable.
    gc_log_event "$state_dir" "shim" "unknown" "exec" "$tool $*" "observe" >/dev/null 2>&1 || true
    printf '{"decision":"allow","tool":"%s","learned":true}\n' "$tool"
  fi
}

# fs-watcher detection: only the job scratch root is writable; writes to the
# shim/agent trees are self-code-modification, everything else is
# write-outside-allowlist.
gc_fs_detect() { # state_dir path -> decision JSON
  local state_dir=$1 path=$2
  case "$path" in
    "$GC_WRITABLE_ROOT"|"$GC_WRITABLE_ROOT"/*)
      printf '{"decision":"allow","path":"%s"}\n' "$path" ;;
    /shims|/shims/*|/agent|/agent/*)
      gc_decide "$state_dir" GC-FSW-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-FSW-002","path":"%s"}\n' "$path" ;;
    */package.json|*/package-lock.json|*/pyproject.toml|*/requirements*.txt|/package.json|/pyproject.toml)
      gc_decide "$state_dir" GC-PKG-003 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-PKG-003","path":"%s"}\n' "$path" ;;
    /dev/*|/dev)
      # Write targets on devtmpfs could inject marker text (GC-TOOL-002).
      gc_decide "$state_dir" GC-TOOL-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-TOOL-002","path":"%s"}\n' "$path" ;;
    *"containment.log"*|*/.gc/*)
      gc_decide "$state_dir" GC-LOG-002 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-LOG-002","path":"%s"}\n' "$path" ;;
    *)
      gc_decide "$state_dir" GC-FSW-001 "$path" >/dev/null || return 2
      printf '{"decision":"deny","rule":"GC-FSW-001","path":"%s"}\n' "$path" ;;
  esac
}

# find -newer sweep fallback for the fs-watcher: detect every path handed in.
gc_fs_sweep() { # state_dir path...
  local state_dir=$1; shift
  local path
  for path in "$@"; do gc_fs_detect "$state_dir" "$path"; done
}

# net-watcher detection: any socket row is a violation (GC-NET-001).
gc_net_detect() { # state_dir socket_entry
  local state_dir=$1 entry=$2
  [ -n "$entry" ] || return 0
  gc_decide "$state_dir" GC-NET-001 "$entry" >/dev/null || return 2
  printf '{"decision":"deny","rule":"GC-NET-001"}\n'
}

# proc-watcher detection: a process outside the job tree is an anomaly.
gc_proc_detect() { # state_dir process_identity
  local state_dir=$1 identity=$2
  gc_decide "$state_dir" unknown "proc $identity" >/dev/null || return 2
  printf '{"decision":"deny","rule":"unknown"}\n'
}

# Supervisor liveness (design section 1.3): a dead monitor loop is a
# containment failure and trips the killswitch immediately.
gc_liveness() { # state_dir alive_flags ("1 1 1"; any 0 is a dead loop)
  local state_dir=$1 flags=$2
  case " $flags " in
    *" 0 "*)
      gc_log_event "$state_dir" "watcher:proc" containment-integrity proc "monitor loop dead" >/dev/null || return 2
      gc_killswitch_trip "$state_dir" containment-integrity containment-integrity CRITICAL immediate null null >/dev/null || return 2
      printf '{"decision":"deny","rule":"containment-integrity","tier":"CRITICAL","mode":"immediate"}\n' ;;
    *) printf '{"decision":"allow"}\n' ;;
  esac
}

# B1: the one real receipt printf. The containment segment is passed as a %s
# argument (never interpolated into the format string, where it would stay
# literal under single quotes); an empty segment yields the v1 receipt shape.
gc_receipt_json() { # schema remote_host fixture_id domain marker marker_sha script_hash initramfs_sha containment_segment domain destroy_requested absent acl_before acl_after fs_ctx_sha net_ctx_sha
  printf '{"schema":"%s","ok":true,"status":"VERIFIED","authorityCreated":false,"runtimeActivated":false,"persisted":false,"identity":{"remoteHost":"%s","fixtureId":"%s","domain":"%s"},"marker":{"value":"%s","sha256":"%s"},"scriptHash":"%s","initramfsSha256":"%s"%s,"teardown":{"domain":{"name":"%s","transient":true,"destroyOnExit":true,"destroyRequested":%s,"absent":%s,"checked":true,"check":"virsh dominfo/list"},"acl":{"beforeSha256":"%s","afterSha256":"%s","equal":true,"checked":true,"initramfsEntryRemoved":true}},"context":{"filesystem":{"summary":"disk=absent host-share=absent credentials=absent gpu=absent","disk":false,"hostShare":false,"credentials":false,"gpu":false,"sha256":"%s"},"network":{"summary":"network=absent","guest":false,"sha256":"%s"},"guestMounts":["proc","sysfs","devtmpfs"]}}\n' "$@"
}

# Terminal event for a session that ends without a killswitch trip: the
# envelope then carries only log lines plus this session-end record
# (design section 5: a session with neither is containment-evidence-missing).
gc_session_end() { # state_dir
  local state_dir=$1 log="$state_dir/containment.log.jsonl"
  local seq=1
  if [ -f "$state_dir/seq" ]; then seq=$(( $(cat "$state_dir/seq") + 1 )); fi
  printf '%s\n' "$seq" >"$state_dir/seq"
  local tsha
  tsha=$(sha256sum "$state_dir/taxonomy.json" | awk '{print $1}') || return 2
  printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"supervisor","class":"session-end","action":"complete","summary":true}}\n' \
    "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$(gc_iso8601)" "$seq" >>"$log"
}

# Host-side containment evidence (design section 5): extract the framed base64
# envelope from the console transcript, decode it pty-safe, recompute the log
# digest per the stated normalization, and cross-check the terminal killswitch
# event's embedded digest against the full payload.
gc_containment_evidence() { # transcript fixture_id -> containment block JSON on stdout
  local transcript=$1 fid=$2
  local begin="AGENTIC_CONTAINMENT_BEGIN:$fid" end="AGENTIC_CONTAINMENT_END:$fid"
  local b64 tmp log_sha events denials ks_line ks_rule tripped rule_json
  tmp="$transcript.containment.$$"
  trap 'rm -f "$tmp" "$tmp.b64" "$tmp.head"' RETURN
  # H2: exactly one envelope pair may exist; more than one is a forgery or a
  # replay attempt and fails closed.
  # Count with index() so pty CR suffixes do not defeat the anchor.
  begins=$(awk -v b="$begin" 'index($0, b) == 1 { n++ } END { print n + 0 }' "$transcript")
  ends=$(awk -v e="$end" 'index($0, e) == 1 { n++ } END { print n + 0 }' "$transcript")
  if [ "$begins" -ne 1 ] || [ "$ends" -ne 1 ]; then
    return 1
  fi
  if ! awk -v b="$begin" -v e="$end" 'index($0, b) == 1 { inside = 1; next } index($0, e) == 1 { inside = 0; next } inside' "$transcript" | tr -d '\r' >"$tmp.b64"; then
    return 1
  fi
  if ! [ -s "$tmp.b64" ]; then return 1; fi
  if ! { base64 -d <"$tmp.b64" >"$tmp" 2>/dev/null || base64 -D <"$tmp.b64" >"$tmp" 2>/dev/null; }; then return 1; fi
  if ! grep -q '"schema":"' "$tmp"; then return 1; fi
  ks_line=$(grep '"final":true' "$tmp" | tail -n 1)
  ks_num=$(grep -n '"final":true' "$tmp" | tail -n 1 | cut -d: -f1)
  if [ -n "$ks_line" ]; then
    # Digest chain (H1): verified at the killswitch line's position — the
    # digest covers the log up to and including the trigger event but
    # excluding the killswitch line itself; anything after it is post-trip
    # noise the guest's log freeze should have prevented, and is ignored for
    # the digest rather than silently trusted.
    ks_sha=$(printf '%s\n' "$ks_line" | sed -n 's/.*"logSha256":"\([0-9a-f]*\)".*/\1/p')
    sed -n "1,$((ks_num - 1))p" "$tmp" >"$tmp.head" 2>/dev/null || return 1
    chained_sha=$(sha256sum "$tmp.head" | awk '{print $1}') || return 1
    if [ -z "$ks_sha" ] || [ "$ks_sha" != "$chained_sha" ]; then return 2; fi
    tripped=true
    log_sha=$ks_sha
    ks_rule=$(printf '%s\n' "$ks_line" | sed -n 's/.*"trigger":{"rule":"\([A-Za-z0-9_-]*\)".*/\1/p')
    ks_class=$(printf '%s\n' "$ks_line" | sed -n 's/.*"trigger":{"rule":"[A-Za-z0-9_-]*","class":"\([A-Za-z0-9_-]*\)".*/\1/p')
    ks_tier=$(printf '%s\n' "$ks_line" | sed -n 's/.*"tier":"\([A-Za-z]*\)".*/\1/p')
    rule_json="\"$ks_rule\""
    class_json="\"$ks_class\""
    tier_json="\"$ks_tier\""
    counted=$((ks_num - 1))
  else
    # Fail-closed: without a killswitch record the session must end with the
    # clean session-end terminal event.
    grep -q '"class":"session-end"' "$tmp" || return 1
    tripped=false
    rule_json=null
    class_json=null
    tier_json=null
    log_sha=$(sha256sum "$tmp" | awk '{print $1}') || return 1
    counted=$(grep -c '"schema":"' "$tmp")
  fi
  events=$counted
  denials=$(grep -c '"action":"deny"' "$tmp")
  # M1: compact histogram (design section 4; open question 4 decided) — the
  # coordinator consumes aggregates from the receipt without extra tooling.
  # Terminal killswitch records are echoes, not events; exclude them.
  histogram=$(awk '{
    if ($0 !~ /guest-containment.killswitch.v1/ && match($0, /"class":"[^"]*"/)) {
      c = substr($0, RSTART + 9, RLENGTH - 10); n[c]++
    }
  } END { first = 1; printf "{"; for (k in n) { if (!first) printf ","; printf "\"%s\":%d", k, n[k]; first = 0 } printf "}" }' "$tmp")
  rm -f "$tmp" "$tmp.b64" "$tmp.head"
  printf '{"schema":"%s","taxonomySha256":"%s","logSha256":"%s","events":%s,"denials":%s,"histogram":%s,"killswitch":{"tripped":%s,"rule":%s,"class":%s,"tier":%s,"guestPoweroff":true,"final":true}}' \
    "$GC_LOG_SCHEMA" "$GC_TAXONOMY_SHA256" "$log_sha" "$events" "$denials" "$histogram" "$tripped" "$rule_json" "$class_json" "$tier_json"
}

GC_CORE_EOF
then
  fixture_fail 6 'guest containment core could not be embedded'
fi
if ! grep -q 'gc_killswitch_trip' "$root/gc/core.sh"; then fixture_fail 6 'guest containment core embed is incomplete'; fi
if ! cat >"$root/gc/dispatch" <<'GC_DISPATCH_EOF'
#!/bin/busybox sh
# Every applet is shimmed, so the dispatcher must resolve its own helpers
# (core.sh uses sed/grep/awk/sha256sum/...) from /bin directly; otherwise
# each helper would re-enter /shims and recurse.
PATH=/bin
. /gc/core.sh
session=/tmp/session/.gc
tool=${0##*/}
decision=$(gc_shim_allow "$session" "$tool" "$@") || exit 126
case "$decision" in
  *'"decision":"allow"'*)
    exec /bin/busybox "$tool" "$@" ;;
  *)
    # Denied and logged (and, per severity tier, possibly killswitched);
    # the supervisor kill path runs from the kill flag.
    exit 126 ;;
esac
GC_DISPATCH_EOF
then
  fixture_fail 6 'guest shim dispatcher could not be written'
fi
if ! cat >"$root/gc/fs-handler" <<'GC_FS_HANDLER_EOF'
#!/bin/busybox sh
# inotifyd handler: allow only the job scratch root; everything else is
# classified by gc_fs_detect. PATH=/bin keeps core.sh helpers out of /shims.
PATH=/bin
. /gc/core.sh
session=/tmp/session/.gc
event=$1 dir=$2 name=$3
[ -n "$dir" ] || exit 0
path="${dir%/}"
[ -n "$name" ] && [ "$name" != "INSERT" ] && path="$path/$name"
gc_fs_detect "$session" "$path" >/dev/null 2>&1
GC_FS_HANDLER_EOF
then
  fixture_fail 6 'guest fs-watcher handler could not be written'
fi
# R2: shim every BusyBox applet, not a fixed dangerous-tools list — the shim
# layer is the command boundary (design sections 1.2, 3), so plain
# `cat /root/.ssh/...`, `sed -i ...`, or `sh -c '... > /dev/console'` must
# reach the classifier too. Only the job runs under the shim PATH and the
# dispatcher resets PATH=/bin for its own helpers, so the wider surface adds
# no recursion. Observed-first-use learning semantics are unchanged.
shim_links=0
for name in $applet_list; do
  if ! ln -s ../gc/dispatch "$root/shims/$name"; then fixture_fail 6 "shim link could not be created: $name"; fi
  shim_links=$((shim_links + 1))
done
if [ "$shim_links" -lt 1 ]; then fixture_fail 6 'no BusyBox applets available for the shim layer'; fi
if ! cat >"$root/init" <<EOF
#!/bin/busybox sh
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mount -t devtmpfs devtmpfs /dev
echo '$marker'
echo "guest-kernel=\$(/bin/uname -r)"
echo 'network=absent disk=absent host-share=absent'
if [ ! -x /job.sh ]; then
  sync
  /bin/poweroff -f
fi
# --- containment session (design section 1.3): deny-by-default supervisor ---
. /gc/core.sh
session_id=$fixture_id
session=/tmp/session/.gc
mkdir -p /tmp/session "\$session" || { sync; /bin/poweroff -f; }
touch "\$session/baseline"
# The supervisor and monitor loops resolve applets from /bin directly; only
# the job below runs under the shim PATH, so the monitor never interposes on
# its own helpers now that every applet is shimmed.
export PATH=/bin
(
  while :; do
    for f in /proc/net/tcp /proc/net/tcp6 /proc/net/udp; do
      if [ -s "\$f" ]; then
        rows=\$(wc -l < "\$f")
        if [ "\$rows" -gt 1 ]; then
          gc_net_detect "\$session" "\$(sed -n 2p "\$f")" >/dev/null 2>&1
        fi
      fi
    done
    sleep 1
  done
) &
net_pid=\$!
(
  if [ -x /bin/inotifyd ]; then
    # R1: event-driven top-level watches close the create/use/delete race at
    # depth one, but inotify watches are non-recursive — nested writes at
    # depth >= 2 under a watched root would be invisible to them. Both
    # detectors run side by side (design sections 1.3, 9.1): inotifyd in the
    # background for immediacy, the recursive find -newer sweep below
    # unconditionally for coverage (and as the fallback when inotifyd is
    # absent or dies). A top-level write may be seen twice; that only adds
    # deny pressure, never misses one.
    watches=""
    for d in /*; do
      case "\$d" in /proc|/sys|/dev|/tmp/session|/tmp/session/*) continue ;; esac
      [ -d "\$d" ] && watches="\$watches \$d:ncp"
    done
    [ -n "\$watches" ] && /bin/inotifyd /gc/fs-handler \$watches &
  fi
  while :; do
    find / -newer "\$session/baseline" 2>/dev/null | grep -Ev '^/(tmp/session|proc|sys|dev|gc)' | while IFS= read -r p; do
      gc_fs_detect "\$session" "\$p" >/dev/null 2>&1
    done
    touch "\$session/baseline"
    sleep 1
  done
) &
fs_pid=\$!
(
  while :; do
    ps -eo comm 2>/dev/null | tail -n +2 | while IFS= read -r c; do
      case "\$c" in busybox|sh|init|inotifyd|poweroff|sync|comm) continue ;; esac
      grep -F -x -- "\$c" "\$session/allowlist" >/dev/null 2>&1 || gc_proc_detect "\$session" "\$c" >/dev/null 2>&1
    done
    sleep 1
  done
) &
proc_pid=\$!
# Only the job runs under the shim PATH (design section 1.3); PATH= above
# keeps the supervisor and monitor loops on /bin.
if [ "$have_setsid" = true ]; then
  PATH=/shims:/bin /bin/setsid /bin/busybox sh /job.sh &
else
  PATH=/shims:/bin /bin/busybox sh /job.sh &
fi
job_pid=\$!
while :; do
  alive=\$(for pid in "\$net_pid" "\$fs_pid" "\$proc_pid"; do [ -e "/proc/\$pid" ] && printf '1 ' || printf '0 '; done)
  gc_liveness "\$session" "\$alive" >/dev/null 2>&1
  if [ -f "\$session/kill" ]; then break; fi
  kill -0 "\$job_pid" 2>/dev/null || break
  sleep 1
done
# Killswitch action (design section 5): kill the job process group, sync,
# poweroff. on_poweroff=destroy tears the transient domain down host-side.
# M5: without setsid there is no separate process group; fall back to killing
# the job and its /proc-visible descendants directly. R3 caveats, both bounded
# by the unconditional poweroff -f below (which ends every descendant
# regardless): the walk covers direct children only (TERM pass, then KILL
# pass), and /proc/<pid>/stat field parsing assumes a space-free comm.
if [ -x /bin/setsid ]; then
  kill -TERM -"\$job_pid" 2>/dev/null
  kill -KILL -"\$job_pid" 2>/dev/null
else
  for p in /proc/[0-9]*; do
    ppid=\$(awk '{print \$4}' "\$p/stat" 2>/dev/null) || continue
    if [ "\$ppid" = "\$job_pid" ]; then kill -TERM "\${p#/proc/}" 2>/dev/null; fi
  done
  kill -TERM "\$job_pid" 2>/dev/null
  for p in /proc/[0-9]*; do
    ppid=\$(awk '{print \$4}' "\$p/stat" 2>/dev/null) || continue
    if [ "\$ppid" = "\$job_pid" ]; then kill -KILL "\${p#/proc/}" 2>/dev/null; fi
  done
  kill -KILL "\$job_pid" 2>/dev/null
fi
if [ ! -f "\$session/kill" ]; then gc_session_end "\$session" || :; fi
# Denial-evidence transport (design section 5): framed base64 envelope on the
# console channel, UTF-8, LF-only, fixed key order; pty-safe alphabet.
if [ -f "\$session/containment.log.jsonl" ]; then
  printf '%s\n' "AGENTIC_CONTAINMENT_BEGIN:\$session_id"
  /bin/base64 "\$session/containment.log.jsonl"
  printf '%s\n' "AGENTIC_CONTAINMENT_END:\$session_id"
fi
sync
/bin/poweroff -f
EOF
then
  fixture_fail 6 'guest init could not be written'
fi
if ! chmod 0755 "$root/init" "$root/gc/dispatch" "$root/gc/fs-handler"; then fixture_fail 6 'guest containment scripts could not be made executable'; fi
if [ -n "$containment_payload" ]; then
  # M6: the payload is inline text; write it as the guest job under the shim PATH.
  if ! printf '%s\n' "$containment_payload" >"$root/job.sh"; then fixture_fail 6 'containment payload could not be embedded'; fi
  if ! chmod 0755 "$root/job.sh"; then fixture_fail 6 'containment payload could not be made executable'; fi
fi
if ! gc_embedded_taxonomy >"$root/etc/guest-containment-taxonomy.v1.json"; then
  fixture_fail 6 'containment taxonomy could not be embedded in the initramfs'
fi
if [ "$(sha256sum "$root/etc/guest-containment-taxonomy.v1.json" | awk '{print $1}')" != "$GC_TAXONOMY_SHA256" ]; then
  fixture_fail 6 'embedded containment taxonomy digest mismatch'
fi
if ! (
  cd "$root"
  find . -print0 | LC_ALL=C sort -z | /usr/bin/cpio --null -o --format=newc 2>"$initramfs_build_log" | /usr/bin/gzip -n >"$initramfs"
); then
  build_detail=$(tr '\r\n' ' ' <"$initramfs_build_log" | cut -c1-300)
  fixture_fail 6 "initramfs could not be built${build_detail:+: $build_detail}"
fi
if ! initramfs_sha=$(sha256sum "$initramfs" | awk '{print $1}'); then
  fixture_fail 6 'initramfs digest could not be computed'
fi
if [ "${#initramfs_sha}" -ne 64 ]; then fixture_fail 6 'initramfs digest is invalid'; fi

if ! cat >"$fixture_root/domain.xml" <<EOF
<domain type='kvm'>
  <name>$domain</name>
  <memory unit='MiB'>$memory_mib</memory>
  <vcpu placement='static'>$vcpu</vcpu>
  <os>
    <type arch='x86_64' machine='microvm'>hvm</type>
    <kernel>$kernel</kernel>
    <initrd>$initramfs</initrd>
    <cmdline>earlycon=uart,io,0x3f8,115200 console=ttyS0,115200 rdinit=/init reboot=t panic=1</cmdline>
  </os>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>destroy</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <serial type='pty'>
      <target type='isa-serial' port='0'>
        <model name='isa-serial'/>
      </target>
    </serial>
    <console type='pty'><target type='serial' port='0'/></console>
  </devices>
</domain>
EOF
then
  fixture_fail 6 'domain XML could not be written'
fi

phase=acl
home_acl_applied=true
if ! setfacl -m u:libvirt-qemu:--x "$HOME"; then fixture_fail 7 'home ACL could not be applied'; fi
initramfs_acl_applied=true
if ! setfacl -m u:libvirt-qemu:r "$initramfs"; then fixture_fail 7 'initramfs ACL could not be applied'; fi

phase=console
domain_started=true
script -q -e -c "virsh create '$fixture_root/domain.xml' --console" "$fixture_root/console.typescript" > /dev/null 2>"$console_error" &
recorder_pid=$!
marker_seen=false
for _attempt in $(seq 1 90); do
  if grep -F "$marker" "$fixture_root/console.typescript" >/dev/null 2>&1; then
    marker_seen=true
    break
  fi
  if ! kill -0 "$recorder_pid" 2>/dev/null; then break; fi
  sleep 0.5
done

phase=teardown
if ! state=$(domain_state); then fixture_fail 9 'domain teardown query failed'; fi
if [ "$state" = present ]; then
  domain_destroy_requested=true
  if ! virsh destroy "$domain" >/dev/null; then fixture_fail 9 "domain destroy failed: $domain"; fi
fi
recorder_status=0
if wait "$recorder_pid"; then :; else recorder_status=$?; fi
if [ "$recorder_status" -ne 0 ]; then
  recorder_detail=$(tr '\r\n' ' ' <"$console_error" | cut -c1-300)
  fixture_fail 9 "console recorder failed with status $recorder_status${recorder_detail:+: $recorder_detail}"
fi

phase=evidence
# util-linux script may flush its final transcript only while exiting. Re-read
# the retained recording after join so a successful late marker is not
# classified from the stale polling-loop state.
if grep -F "$marker" "$fixture_root/console.typescript" >/dev/null 2>&1; then
  marker_seen=true
fi
if [ "$marker_seen" != true ]; then
  fixture_fail 10 'guest marker missing from bounded console recording'
fi

phase=containment
containment_segment=""
receipt_schema="agentic-driver.linux-microvm-cutover.v1"
if [ -n "$containment_payload" ]; then
  receipt_schema="agentic-driver.linux-microvm-cutover.v2"
  if ! containment_block=$(gc_containment_evidence "$fixture_root/console.typescript" "$fixture_id"); then
    fixture_fail 10 'containment evidence missing or invalid in bounded console recording'
  fi
  containment_segment=",\"containment\":$containment_block"
fi

phase=acl
if ! setfacl -x u:libvirt-qemu "$initramfs"; then fixture_fail 11 'initramfs ACL could not be removed'; fi
if ! verify_initramfs_acl_removed; then fixture_fail 11 'initramfs ACL removal could not be verified'; fi
initramfs_acl_applied=false
if ! setfacl --restore="$acl_backup"; then fixture_fail 11 'home ACL could not be restored'; fi
if ! getfacl -p "$HOME" >"$acl_after"; then fixture_fail 11 'restored home ACL could not be captured'; fi
if ! cmp -s "$acl_backup" "$acl_after"; then fixture_fail 11 'restored home ACL differs from home.acl.before'; fi
if ! home_acl_after_sha=$(sha256sum "$acl_after" | awk '{print $1}'); then
  fixture_fail 11 'restored home ACL digest could not be computed'
fi
home_acl_applied=false
acl_restored=true

phase=teardown
if ! assert_domain_absent; then fixture_fail 10 'final fixture domain absence could not be proven'; fi
domain_absent=true

phase=evidence
if ! marker_sha=$(printf '%s' "$marker" | sha256sum | awk '{print $1}'); then fixture_fail 12 'marker digest could not be computed'; fi
if ! filesystem_context_sha=$(printf '{"disk":false,"hostShare":false,"credentials":false,"gpu":false,"initramfsSha256":"%s"}' "$initramfs_sha" | sha256sum | awk '{print $1}'); then
  fixture_fail 12 'filesystem context digest could not be computed'
fi
if ! network_context_sha=$(printf '{"network":false}' | sha256sum | awk '{print $1}'); then
  fixture_fail 12 'network context digest could not be computed'
fi
if ! remote_host=$(hostname); then fixture_fail 12 'remote host identity could not be observed'; fi
case "$remote_host" in
  ""|*[!A-Za-z0-9._-]*) fixture_fail 12 'remote host identity is unsafe' ;;
esac

trap - EXIT INT TERM HUP
gc_receipt_json "$receipt_schema" "$remote_host" "$fixture_id" "$domain" "$marker" "$marker_sha" "$script_hash" "$initramfs_sha" "$containment_segment" "$domain" "$domain_destroy_requested" "$domain_absent" "$home_acl_before_sha" "$home_acl_after_sha" "$filesystem_context_sha" "$network_context_sha"
exit 0
