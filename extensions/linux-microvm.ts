import { registerLinuxMicroVMCutoverInterface } from "../scripts/enforcement/linux_microvm_cutover_pi.js";

export default function registerLinuxMicroVMCutover(pi: any) {
  return registerLinuxMicroVMCutoverInterface(pi, {
    runtime: { workMode: "ad-hoc" },
  });
}
