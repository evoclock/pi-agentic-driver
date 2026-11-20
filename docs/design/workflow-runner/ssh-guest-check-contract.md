# G8b fixed-subsystem guest checks

G8b implements the local image assembler, PID1 supervisor, fixed SSH protocol and
manifest-bound production drivers. An installed backend and a booted image are
separate acceptance requirements. Local fixtures, model checks and an assembled
manifest are not live guest evidence. No deployment is performed by these tools.

## Boundaries

The existing native adapter still owns trusted-project admission, receipt-bound
claims and scoped standing-grant admission before any authenticated readiness
probe, in both native TUI and unattended contexts. The grant must match the
trusted Git-origin repository and only `guest-check`, be unexpired and unrevoked,
and have capacity for a reserved use. There is no per-run confirmation or prompt
fallback. Missing or invalid grants return unavailable without probing. Admission
reserves one use before the first probe; a failed probe still consumes that use.
Grant validity, abort and (for attended runs) the isolation switch are rechecked
before each probe, each guest effect and result acceptance. Revocation checks,
exclusive durable intents and acceptance. An explicit Linux request never falls
back to the host. Missing target metadata returns unavailable. A target without
its exact source-pinned image manifest is rejected.

The client uses only SSH subsystem `pad-guest-check-v1`, BatchMode, strict host-key
checking, no forwarding, no proxy command and no remote shell command. The target
must resolve without per-user SSH configuration. SSH authentication remains with
the platform; no credentials or agent socket are sent into the guest.

## Data and fixed execution

Private profile files:

- `linux-microvm-checks.json`: `schema: pad-linux-check-target.v1`, `sshTarget`,
  five `pins` (image, initramfs, kernel, firecracker, taxonomy), and
  `imageManifestSha256`.
- `linux-microvm-checks-image.json`: the assembler's exact manifest bytes.

The manifest fixes every check's ID, argv, working directory and timeout. The
runtime compares all requested checks before starting transport. It reloads the
native claim and target before launch and after results. A changed command, cwd,
timeout, source pin or manifest fails closed. A stale generation cannot publish
a result. A prior uncertain intent or containment trip is not silently retried.

The server accepts a closed header plus one bounded base64 archive frame. It does
not accept command strings or arbitrary argv. It verifies all five root-owned
artifact files before boot and reports their pins. Each job has an exclusive,
fsynced private directory. The checkout block and root image are read-only; the
VM configuration has no network interface, vsock or host share.

The guest validates boot identity and the archive digest, refuses archive links,
devices and traversal, and extracts only bounded regular files/directories.
Checkout files are root-owned and read-only. Only `.scratch`, `.local` and
`/tmp/session` are writable by the unprivileged check UID. The frozen argv runs
without a shell, with supplementary groups removed, UID/GID 65534,
no-new-privileges, bounded process/file-descriptor counts and no inherited secrets.
Check stdout/stderr go to a bounded pipe, not to the console. Only PID1 emits the
header, armed marker and base64 result frames. The guest deadline remains active
even if the child closes both output descriptors.

Testudo's pinned monitor runs as root. Its state is under private `/run/pad`,
outside the child's writable trees. Both watchers must complete their first
sweep and stay alive. A trip or monitor loss refuses execution or yields exit126.
The monitor is a sampled detector, not a claim to intercept every syscall.
Guest privilege separation, a read-only root, absent external network devices
and absent host shares are independent boundaries. Live adversarial acceptance
must test the real image and monitor rather than infer containment from markers.

The client requires the exact job/check/bundle/taxonomy header, armed-before-result
ordering, guest-labelled command digest, exact serial-log digest and observed VM
destruction. A drop, malformed frame, watchdog, trip or missing teardown cannot
pass. Results remain tied to the original native claim. A terminal trip prevents
later checks from starting. The host transport has a 600-second outer cap per VM
(including boot) and a monotonic 1800-second aggregate cap. The image-baked check
timeout is enforced separately inside the guest; a 600-second check may exhaust
the outer boot-inclusive cap and fail closed.

## Reproducible offline assembly

Run from the reviewed repository checkout:

```sh
python3 scripts/guest_checks_image.py --recipe /path/to/private-reviewed-recipe.json --out .scratch/guest-image-new
```

The output directory must not exist. The assembler never downloads, installs,
mounts a host filesystem, executes supplied binaries or boots a VM. It captures
and hashes every input before publication. Its uncompressed newc archive has
sorted names, fixed ownership/modes/inodes/epoch, no compression-version entropy,
and a root-only console device. It copies the supplied root image, kernel and
Firecracker bytes unchanged and emits their manifest pins. PID1/supervisor bytes,
monitor, taxonomy, BusyBox and the check map are included in the initramfs chain.

Recipe fields are closed:

- `schema: pad-guest-image-recipe.v1`.
- `testudoCommit: 92796bc7d487b6c0a8b9128be87653f17898742b`.
- `sourceDateEpoch`: fixed integer, not build time.
- `assets`: image, kernel, firecracker, busybox, monitor, taxonomy; each has a
  canonical local `path` and actual `sha256`.
- `checks`: ID to `{command: [argv], cwd: relativePath, timeoutSeconds: integer}`.

The Testudo monitor source must hash to
`d2aa2b380bb2855fcb75a1feeda72877f8e59f658697b409d8581503a5b4e97c`;
taxonomy must hash to
`0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd`.
The client also pins this release's protected supervisor source at
`e08c596207f020f3cbb3e8c97434ffc611105c3855a5cf60a4c300d662c0fbc4`;
changing it requires a reviewed client/source-pin transition.
The source is AGPL-3.0-only, as is this repository. Preserve source/license records
when distributing assembled artifacts. No third-party source is silently vendored.

The owner must supply an independently reviewed, credential-free x86-64 ext4
root image and matching kernel, Firecracker and static BusyBox. The base image
must contain `/usr/bin/python3`, `/bin/sh`, `flock` (its lock covers each monitor
sweep because Testudo's event sequence and pressure files have shared writers),
required monitor utilities, all fixed
check runtimes and their exact dependencies, and mount-point directories `/dev`,
`/proc`, `/run`, `/tmp`, `/work`. For Node ESM checks, reviewed dependencies can be
placed in read-only `/node_modules`. No package installation occurs inside a
check. Dependency acquisition belongs to a separate top-level Socket Firewall
step with exact versions and lockfile pins. The assembler does not establish how
a supplied opaque rootfs was built; its build provenance and reproducibility
remain an owner-reviewed prerequisite, not a fabricated success.

The checkout transfer is a Git archive, not Git history. Checks needing the
original Git database are unsupported by this image protocol; do not manufacture
a different HEAD and describe it as the receipt commit. Unsupported checks fail
closed and need a separately reviewed transport extension.

## Owner-held installation

Do not execute installation until independent review covers the exact PAD commit,
real source inputs and resulting artifact manifest. These are first-install
instructions, not an automatic upgrade or an authorization to touch a backend.
Preserve existing configurations and job evidence rather than overwrite them.

On the selected Linux backend, provision a dedicated non-root `padchecks` account
and KVM access through the host's reviewed account policy. Install the reviewed
launcher as root-owned mode0555 at:

```text
/usr/local/libexec/pad-guest-check-v1.py
```

Install generated assets under an immutable version directory:

```text
/opt/pad/guest/<actual image-manifest SHA-256>/
```

Every ancestor and pin file must be root-owned and not group/world-writable.
Install `image`, `kernel`, `firecracker`, `taxonomy` and `initramfs.cpio`; only
Firecracker needs an executable mode. Do not replace bytes in an existing version
directory. Create `/var/lib/pad-guest-checks` mode0700 owned by the dedicated
account. Install `/etc/pad/guest-checks.json` mode0644 owned by root:

```json
{
  "schema": "pad-guest-launcher.v1",
  "pins": {
    "image": {"path": "/opt/pad/guest/ACTUAL_MANIFEST_DIGEST/image", "sha256": "ACTUAL_IMAGE_DIGEST"},
    "initramfs": {"path": "/opt/pad/guest/ACTUAL_MANIFEST_DIGEST/initramfs.cpio", "sha256": "ACTUAL_INITRAMFS_DIGEST"},
    "kernel": {"path": "/opt/pad/guest/ACTUAL_MANIFEST_DIGEST/kernel", "sha256": "ACTUAL_KERNEL_DIGEST"},
    "firecracker": {"path": "/opt/pad/guest/ACTUAL_MANIFEST_DIGEST/firecracker", "sha256": "ACTUAL_FIRECRACKER_DIGEST"},
    "taxonomy": {"path": "/opt/pad/guest/ACTUAL_MANIFEST_DIGEST/taxonomy", "sha256": "ACTUAL_TAXONOMY_DIGEST"}
  },
  "checks": ["ACTUAL_IMAGE_CHECK_ID"],
  "vcpus": 2,
  "memoryMiB": 2048,
  "timeoutSeconds": 600,
  "runDir": "/var/lib/pad-guest-checks"
}
```

The placeholders intentionally fail validation. Populate from the actual
manifest, not this example. The checks list must match the baked map.

The reviewed sshd configuration must define the subsystem and restrict this
account to the fixed launcher. For example, merge the following with the existing
host configuration; do not overwrite unrelated sshd policy:

```text
Subsystem pad-guest-check-v1 /usr/bin/python3 -I -B /usr/local/libexec/pad-guest-check-v1.py
Match User padchecks
    ForceCommand /usr/bin/python3 -I -B /usr/local/libexec/pad-guest-check-v1.py
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    AuthorizedKeysFile /etc/ssh/pad-authorized-keys/%u
Match all
```

Use root-managed authorized keys with the `restrict` option. Review account-shell
and public-key authentication behavior for the actual host. Validate with
`sudo sshd -t` before the owner reloads the service. Do not weaken host-key checks,
permit a login shell lane, forward credentials or substitute the transient proof
payload. Install the target JSON and exact manifest bytes into the private Pi
profile only after the backend is ready. A local profile alone grants no use;
a scoped, expiring, revocable standing guest-check grant is required even in the
native TUI. The attended isolation switch remains required; it is not a grant.
The separate transient proof tool's confirmation is unchanged.

## Evidence and acceptance

Existing `Gap8SSHChecks.tla` covers pin admission, header/armed ordering, result
origin, log integrity, drops, watchdog, trips and teardown. Existing
`Gap8LinuxUnattended.tla` covers grant admission in both contexts and revocation.
Its Stage action abstracts preflight/probing after admission; `ProbeNeedsValidGrant`
and the attended no-grant negative control forbid probing without a valid grant.
Run rechecks the grant separately. These snapshots do not prove wall-clock atomicity. They are
finite abstractions, not proofs of Linux privileges, filesystem immutability,
wall time, source provenance or monitor syscall coverage. Protocol action-map
and fault-window rendering remain unavailable in the model-fidelity tool.

Local tests exercise real process streams with fake launchers/VMMs, deterministic
fixture packing, archive rejection, deadline behavior, claim revocation and
manifest mismatches. These are not a real image boot. Live acceptance still needs
actual rootfs/kernel/tool pins, the owner-installed subsystem, observed armed
containment, a passing fixed check, a deliberate trip, revocation between runs,
cancellation/disconnect/watchdog and verified teardown. No success is claimed
for any missing prerequisite.

The inherited `exit-core-backend-unavailable` mutation keeps its stable ID. Its
G8b target now checks the absent-profile refusal rather than the deliberately
removed hard-coded null driver. This is the feature's configuration transition,
not a waived unavailable test. Its original test stays unchanged. New contracts
cover manifest bytes, fixed argv, monitor source, armed ordering, teardown,
assembly input bytes, archive boundaries, guest deadlines and pre-boot cancellation.
