#!/usr/bin/env bash
set -euo pipefail

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
if ! mkdir -p "$root/bin" "$root/proc" "$root/sys" "$root/dev"; then fixture_fail 6 'guest root could not be created'; fi
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
