import registerLifecycleModeInterface from "../scripts/lifecycle_mode_pi.js";
import { registerLinuxMicroVMCutoverInterface } from "../scripts/enforcement/linux_microvm_cutover_pi.js";

export default function registerLinuxMicroVMCutover(pi: any) {
  const runtime: { workMode?: string; workContext?: unknown; isolationEnabled?: boolean } = {};
  registerLifecycleModeInterface(pi, runtime);
  return registerLinuxMicroVMCutoverInterface(pi, { runtime });
}
