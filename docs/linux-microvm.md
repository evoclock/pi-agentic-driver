# Linux microVM proof

`agentic_linux_microvm_cutover` runs one job in a throwaway QEMU/KVM guest. The job has no disk, network, host share, credentials or GPU. The machine is removed after the run. Isolation starts off each session; `/agentic-isolation-enable` needs human confirmation and cannot be run by the model. Each proof also asks for confirmation.

To choose a machine, give the target explicitly. Saving a target needs confirmation. The probe checks `/dev/kvm`, the system libvirt driver and a matching QEMU binary before starting. The bundled guest needs an x86_64 KVM host for the full proof.

The killswitch covers credential probing, network use, persistence, self-modification, cache payload staging, cross-agent contact, evidence tampering and reconnaissance. Denials write a digest-chained log outside the guest. Example tests trigger each category and check that the guest is gone afterward. A tested example is not a claim that all possible commands are contained; the host boundary and each run must still be checked.

## Isolation proof and containment

**Available in this release:**


The `agentic_linux_microvm_cutover` tool runs a single job inside a throwaway
QEMU/KVM virtual machine on a Linux host. The job cannot reach the host, the
network, or anything else outside the machine. The system deletes the machine
after the job ends.

Isolation is off at the start of every session. Use the `/agentic-isolation-enable`
command in the Pi TUI, and confirm. The model cannot run
that command. Every cutover run asks for its own confirmation too. Nothing is
saved to settings, and headless sessions stay blocked.

### You choose the machine

The model can only relay your words. Saving a target, or running on one,
always requires your confirmation dialog first.

1. Tell the agent where to run the proof, for example "run the microVM proof
   on deploy@192.168.1.50" or "run it on this machine". The first run asks
   you to confirm. Your Yes saves the choice to your Pi config and the run
   continues.
2. Run `/agentic-isolation-enable` and confirm.
3. Each cutover run asks for its own confirmation. Later runs reuse the saved
   target without asking where the microVM runs again.

The tool discovers the technical details from the machine itself:
architecture, kernel, libvirt driver. You configure nothing. Before any run,
the probe checks three requirements: `/dev/kvm` is accessible, libvirt
reports the system-level driver, and a matching `qemu-system-<arch>` binary
exists. A failed check denies the run before anything happens. The shipped
fixture guest is x86_64-built, so the full proof currently needs an x86_64
KVM host.

### What example tests look like

We started with one payload: print a greeting, then call a network tool. The
greeting printed, the tool tripped the killswitch at the HIGH tier, and the
line after it never ran. A kill report landed in the state directory naming
the rule and tier, and the teardown proof showed the machine was gone with
nothing left behind.

From there we wrote a payload for every rule in the taxonomy: credential
probing behind chained commands, secret dumping inside subshells, package
installs, coordination files reaching for other agents, a forged receipt, a
write to the evidence channel, and ten unclassified commands in a row to push
the anomaly threshold to its limit.

The guest had no disk, no network, no host share, no credentials, and no GPU.
Nothing outside the kernel's virtual filesystems could be mounted. Every
attempt was denied and written to a log that survived the machine.

While this is a toy test of sorts my own personal work will be running on
these as well.

### What the containment layer defends against

Agent escapes tend to follow a playbook, and the published incidents from
frontier labs (the HuggingFace incident among them) read like one: grab
credentials, phone home, install something persistent, rewrite your tools,
stage payloads in caches, look for other agents to recruit, clean up the
evidence. The containment layer has a rule for each step:

- **Credential theft.** Reading SSH, cloud, or token material, or dumping
  environment secrets, ends the session immediately.
- **Exfiltration and remote control.** Any network tool, any socket, ends the
  session immediately.
- **Persistence through dependencies.** Package installs, registry writes,
  and manifest tampering are denied and counted. Repeat the attempt and the
  session ends.
- **Self-modification.** Rewriting the agent's own tools or the monitoring
  layer is denied and counted.
- **Payload staging.** Growth in cache and package directories is sampled by
  size; repeated growth ends the session.
- **Cross-agent escalation.** Coordination channels and shared paths used to
  reach other agents end the session immediately.
- **Evidence tampering.** Editing logs, forging receipts, or writing to the
  console channel ends the session immediately.
- **Reconnaissance.** Probing the sandbox to learn whether it is watched is
  counted into a concealment index that ships in the run receipt.

Denials are written to a tamper-evident, digest-chained log that outlives the
session, and a trip produces a kill report naming what happened, with proof
that the cleanup completed.

### Proven against real machines

Every rule above has been run against a real QEMU/KVM guest with a payload
built to trigger it. The kill switches fired where they should, the denials
stopped the jobs, and the cleanup held. One boundary is worth stating: two
rules watch the same directories by design, and together they are stricter
than either alone, so the growth-sampling trip is covered by automated tests
rather than a live run.
