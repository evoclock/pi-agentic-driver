# Linux microVM proof

`agentic_linux_microvm_cutover` runs one job in a throwaway QEMU/KVM guest. The job has no disk, network, host share, credentials or GPU. The machine is removed after the run. Isolation starts off each session; `/agentic-isolation-enable` needs human confirmation and cannot be run by the model. Each proof also asks for confirmation.

To choose a machine, give the target explicitly. Saving a target needs confirmation. The probe checks `/dev/kvm`, the system libvirt driver and a matching QEMU binary before starting. The bundled guest needs an x86_64 KVM host for the full proof.

The killswitch covers credential probing, network use, persistence, self-modification, cache payload staging, cross-agent contact, evidence tampering and reconnaissance. Denials write a digest-chained log outside the guest. Example tests trigger each category and check that the guest is gone afterward. A tested example is not a claim that all possible commands are contained; the host boundary and each run must still be checked.
