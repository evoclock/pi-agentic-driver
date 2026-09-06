// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerLinuxMicroVMCutoverInterface, registerIsolationSwitchCommands, createIsolationSwitch } from "../scripts/enforcement/linux_microvm_cutover_pi.js";

export default function registerLinuxMicroVMCutover(pi: any) {
  // Registration is limited to the activation-deferred cutover interface and
  // the session-scoped isolation switch commands. The legacy work-mode
  // lifecycle is not registered: agentic_work_mode is not exposed.
  // The isolation switch state is created per registration, so each fresh
  // extension registration (session) starts disabled.
  const isolationSwitch = registerIsolationSwitchCommands(pi, { isolationSwitch: createIsolationSwitch() });
  registerLinuxMicroVMCutoverInterface(pi, { isolationSwitch });
}
