import { registerLinuxMicroVMCutoverInterface } from "../scripts/enforcement/linux_microvm_cutover_pi.js";

export default function registerLinuxMicroVMCutover(pi: any) {
  // Registration is limited to the activation-deferred cutover interface:
  // native confirmation, trusted facts, and fixed boundaries are preserved by
  // the interface itself; the transient runtime is local to this
  // registration and only carries adapter state it observes at cutover time.
  const runtime: { workMode?: string; workContext?: unknown; isolationEnabled?: boolean } = {};
  return registerLinuxMicroVMCutoverInterface(pi, { runtime });
}
