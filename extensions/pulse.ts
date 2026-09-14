// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Board Pulse provider extension. Registers the deterministic
// agentic_kanban_pulse tool and owns the optional fixed-interval timer. The
// board is resolved per tool call from the calling session's working
// directory; a workspace with no board file gets a structured
// board-unavailable result. Board Pulse is capacity scheduling; it is
// distinct from Herdr worker liveness pulse.
//
// No resources start in the extension factory: the timer is created and
// started only on session_start and cleared idempotently on session_shutdown
// (PULSE_DESIGN_v3 §8). The worker spawn seam is the existing guarded
// herdr-lifecycle boundary — native confirmation, trusted repository,
// installed model roll, fixed argv, shell:false — never raw pane management.

import { executeHerdrSpawnWorker } from "../scripts/enforcement/herdr_lifecycle_pi.js";
import { resolveBoardPath, registerPulseTools, createPulseTimer, pulseTick, pulseWorkerSpawnSeam } from "../scripts/enforcement/pulse_scheduler_pi.js";

export default function pulsePi(pi) {

  // Guarded worker-creation seam (§2.5): every Pulse spawn goes through
  // pulseWorkerSpawnSeam, which is placement-aware and fails closed — host
  // placements route to executeHerdrSpawnWorker (native confirmation,
  // verification); container/microvm placements are denied before any host
  // worker is ever started. No other creation path exists.
  const spawnWorker = pulseWorkerSpawnSeam({ executeHerdrSpawnWorker });

  const result = registerPulseTools(pi, {
    resolveBoardPath: (ctx) => resolveBoardPath(typeof ctx === "string" ? ctx : ctx?.cwd || process.cwd()),
    spawnWorker,
  });

  // Optional timer (§8): created only after session_start, only when the
  // resolved workspace policy enables Pulse in automated mode with a valid
  // interval. fillOnStart queues one tick after startup; it is not catch-up.
  // Ticks never overlap and missed ticks are never replayed. Reload/new/
  // resume/fork emit session_shutdown first, so exactly one fresh runtime
  // exists at a time and no in-memory single-flight state is inherited.
  let timer = null;
  const clearTimer = () => {
    if (timer) {
      timer.clear();
      timer = null;
    }
  };
  const setupTimer = async (_event, ctx) => {
    clearTimer();
    try {
      const boardPath = resolveBoardPath(ctx?.cwd || process.cwd());
      if (!boardPath) return;
      const { readAutomationPolicy, checkAutomationPolicy } = await import(new URL("../scripts/enforcement/task_board_core_pi.js", import.meta.url).href);
      const policy = readAutomationPolicy(boardPath);
      const check = checkAutomationPolicy(policy, { boardPath });
      const pulse = check.ok ? check.policy.pulse : null;
      if (!pulse || pulse.enabled !== true || pulse.mode !== "automated") return;
      timer = createPulseTimer({
        intervalSeconds: pulse.intervalSeconds,
        fillOnStart: pulse.fillOnStart === true,
        tick: () => pulseTick({ boardPath, spawnWorker, context: ctx }),
      });
      timer.start();
    } catch {
      // No-board/no-policy/disabled policy produce zero scheduling effects.
      clearTimer();
    }
  };
  if (typeof pi?.on === "function") {
    pi.on("session_start", setupTimer);
    pi.on("session_shutdown", clearTimer);
  }

  return result;
}
