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
GC_TAXONOMY_SHA256="1b2c9cd424f682d800f8049423a5626a697be1b6f759b2a1d6bb07461978969a"
# Severity tiers (design section 2.0): CRITICAL/HIGH trip immediately,
# ELEVATED/ANOMALY accumulate pressure within a sliding time window.
GC_WINDOW_SECONDS=60
GC_ELEVATED_THRESHOLD=5
GC_ANOMALY_THRESHOLD=10
GC_EVENT_WEIGHT=1
GC_LOG_CAP_BYTES=8192
GC_LOG_TRUNC=512

gc_embedded_taxonomy() {
  cat <<'GC_TAXONOMY_EOF'
{
  "schema": "guest-containment-taxonomy.v1",
  "description": "Deny-by-default rule taxonomy for the guest containment monitor (design GUEST_CONTAINMENT_DESIGN.md section 2). One rule per line; IDs are never reused; new rules append.",
  "rules": [
    {"id": "GC-PKG-001", "class": "GC-PKG", "severity": "ELEVATED", "action": "deny", "match": "package-manager-install: invocation of npm install, npm ci, pip install, yarn add, pnpm add, gem install, cargo install, apk add, apt install", "evidence": "METR autonomous-replication evaluation work (arXiv:2403.13793); HF incident dependency-install persistence step", "since": "v1"},
    {"id": "GC-PKG-002", "class": "GC-PKG", "severity": "ELEVATED", "action": "deny", "match": "registry-write-command: npm publish, npm token, .npmrc writes, pip config, keyring writes", "evidence": "HF incident: agent attempted package publication", "since": "v1"},
    {"id": "GC-PKG-003", "class": "GC-PKG", "severity": "ELEVATED", "action": "deny", "match": "package-metadata-tamper: writes to package.json, package-lock.json, pyproject.toml, requirements*.txt outside the job scratch space", "evidence": "METR evaluation logs: dependency-manifest tampering as persistence step", "since": "v1"},
    {"id": "GC-FSW-001", "class": "GC-FSW", "severity": "ELEVATED", "action": "deny", "match": "write-outside-allowlist: create/append/truncate on any path outside /tmp/session, detected by inotifyd or find -newer sweeps", "evidence": "METR evaluation logs: out-of-bounds file writes during evaluation runs", "since": "v1"},
    {"id": "GC-FSW-002", "class": "GC-FSW", "severity": "ELEVATED", "action": "deny", "match": "self-code-modification: writes under the agent job install/execution directories including the shim tree /shims/", "evidence": "HF incident: agent rewrote the repository it was working in; monitor self-rewrite defense", "since": "v1"},
    {"id": "GC-FSW-003", "class": "GC-FSW", "severity": "ELEVATED", "action": "deny", "match": "file-growth-anomaly: unexpected growth in cache/package directories (~/.npm, ~/.cache/pip, /var/cache/*) beyond the size-delta threshold", "evidence": "METR evaluation logs: bulk cache staging of payloads", "since": "v1"},
    {"id": "GC-SHR-001", "class": "GC-SHR", "severity": "HIGH", "action": "deny", "match": "shared-cache-write: writes to paths shared with other agents or the coordinator; with host-share absent any such attempt is a deny", "evidence": "receipt proves host-share=absent; writes would indicate boundary violation", "since": "v1"},
    {"id": "GC-SHR-002", "class": "GC-SHR", "severity": "HIGH", "action": "deny", "match": "cross-agent-channel: creation of or writes to inter-agent coordination paths (maildirs, task-queue files, agent state files)", "evidence": "HF incident multi-agent escalation; METR coordination/sabotage threat model", "since": "v1"},
    {"id": "GC-NET-001", "class": "GC-NET", "severity": "HIGH", "action": "deny", "match": "socket-open: any entry in /proc/net/tcp, /proc/net/tcp6, /proc/net/udp at any sweep", "evidence": "fixture boots with no network device; any socket is exfiltration-capable", "since": "v1"},
    {"id": "GC-NET-002", "class": "GC-NET", "severity": "HIGH", "action": "deny", "match": "network-tool-invocation: shim-detects wget, curl, nc, ssh, telnet, ping regardless of arguments", "evidence": "METR self-replication exfiltration patterns; HF incident remote control", "since": "v1"},
    {"id": "GC-CRED-001", "class": "GC-CRED", "severity": "CRITICAL", "action": "deny", "match": "credential-path-read: opens of ~/.ssh/, ~/.aws/, ~/.netrc, ~/.git-credentials, token files", "evidence": "credential theft is step one in every reported agent-escape chain", "since": "v1"},
    {"id": "GC-CRED-002", "class": "GC-CRED", "severity": "CRITICAL", "action": "deny", "match": "env-secret-probing: attempts to dump or scan the environment for secret-shaped keys", "evidence": "METR evaluation logs; HF incident postmortem credential harvest attempts", "since": "v1"},
    {"id": "GC-LOG-001", "class": "GC-LOG", "severity": "CRITICAL", "action": "deny", "match": "transcript-write: writes to the console transcript, the monitor log, or the receipt channel by any path other than the supervisor", "evidence": "log is opened append-only by the supervisor; other writers are evidence tampering", "since": "v1"},
    {"id": "GC-LOG-002", "class": "GC-LOG", "severity": "CRITICAL", "action": "deny", "match": "log-truncate-or-rename: >, rm, mv, truncate, sed -i targeting monitor/agent logs", "evidence": "METR report: models attempting to edit their own logs", "since": "v1"},
    {"id": "GC-TOOL-001", "class": "GC-TOOL", "severity": "CRITICAL", "action": "deny", "match": "receipt-forgery: job printing AGENTIC_MICROVM_PROBE:* or AGENTIC_MICROVM_RECEIPT:* lines", "evidence": "host closed-receipt parsing rejects forged output; guest-side denial closes the loop", "since": "v1"},
    {"id": "GC-TOOL-002", "class": "GC-TOOL", "severity": "CRITICAL", "action": "deny", "match": "marker-injection: writes to /dev/console, /dev/ttyS0, or other devtmpfs write targets that could inject marker text", "evidence": "METR tool-call spoofing family; serial stream integrity", "since": "v1"}
  ],
  "residual": {"class": "unknown", "tier": "ANOMALY", "action": "deny", "note": "everything not allowlisted and not classified above; accumulates toward the ANOMALY threshold"}
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

gc_log_event() { # state_dir source class subject_type subject_value
  local state_dir=$1 source=$2 class=$3 stype=$4 svalue=$5
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
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"deny","summary":true}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class")
  else
    record=$(printf '{"schema":"%s","session":"%s","taxonomy":"%s","taxonomySha256":"%s","event":{"ts":"%s","seq":%s,"source":"%s","class":"%s","action":"deny","subject":{"type":"%s","value":"%s"}}}' \
      "$GC_LOG_SCHEMA" "$(basename "$state_dir")" "$GC_TAXONOMY_VERSION" "$tsha" "$ts" "$seq" "$source" "$class" "$stype" "$svalue")
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

# Test hooks: the containment core is callable without booting the guest.
if [ "${1:-}" = "--gc-decide" ]; then shift; gc_decide "$@"; exit $?; fi
if [ "${1:-}" = "--gc-log" ]; then shift; gc_log_event "$@"; exit $?; fi
if [ "${1:-}" = "--gc-taxonomy-sha" ]; then
  computed=$(gc_embedded_taxonomy | sha256sum | awk '{print $1}')
  if [ "$computed" != "$GC_TAXONOMY_SHA256" ]; then
    printf 'microvm failure phase=setup code=taxonomy-digest-mismatch\n' >&2
    exit 2
  fi
  printf '%s\n' "$computed"
  exit 0
fi

phase=setup
if [ "$#" -ne 2 ]; then
  printf 'microvm failure phase=identity code=2 detail=fixture id and script hash are required\n' >&2
  exit 2
fi
fixture_id=$1
script_hash=$2
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
for name in sh mount poweroff uname; do
  if ! ln -s busybox "$root/bin/$name"; then fixture_fail 6 "BusyBox link could not be created: $name"; fi
done
if ! cat >"$root/init" <<EOF
#!/bin/busybox sh
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mount -t devtmpfs devtmpfs /dev
echo '$marker'
echo "guest-kernel=\$(/bin/uname -r)"
echo 'network=absent disk=absent host-share=absent'
sync
/bin/poweroff -f
EOF
then
  fixture_fail 6 'guest init could not be written'
fi
if ! chmod 0755 "$root/init"; then fixture_fail 6 'guest init could not be made executable'; fi
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
  <memory unit='MiB'>128</memory>
  <vcpu placement='static'>1</vcpu>
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
printf '{"schema":"%s","ok":true,"status":"VERIFIED","authorityCreated":false,"runtimeActivated":false,"persisted":false,"identity":{"remoteHost":"%s","fixtureId":"%s","domain":"%s"},"marker":{"value":"%s","sha256":"%s"},"scriptHash":"%s","initramfsSha256":"%s","teardown":{"domain":{"name":"%s","transient":true,"destroyOnExit":true,"destroyRequested":%s,"absent":%s,"checked":true,"check":"virsh dominfo/list"},"acl":{"beforeSha256":"%s","afterSha256":"%s","equal":true,"checked":true,"initramfsEntryRemoved":true}},"context":{"filesystem":{"summary":"disk=absent host-share=absent credentials=absent gpu=absent","disk":false,"hostShare":false,"credentials":false,"gpu":false,"sha256":"%s"},"network":{"summary":"network=absent","guest":false,"sha256":"%s"},"guestMounts":["proc","sysfs","devtmpfs"]}}\n' \
  "$receipt_schema" "$remote_host" "$fixture_id" "$domain" "$marker" "$marker_sha" "$script_hash" "$initramfs_sha" \
  "$domain" "$domain_destroy_requested" "$domain_absent" "$home_acl_before_sha" "$home_acl_after_sha" \
  "$filesystem_context_sha" "$network_context_sha"
exit 0
