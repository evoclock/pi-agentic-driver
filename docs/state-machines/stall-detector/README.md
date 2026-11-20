# Stall recovery state model

The detector has five closed states: `idle` (no run), `watching` (run in progress), `stalled` (one of `idle-timeout`, `repeated-tool-loop`, `blocked-brief`), `recovery-attempted` (one hint already sent this run), and `exhausted` (no more recovery). A signal can clear before a hint; a new dispatched run resets the detector. The loop budget, not the detector, authorizes dispatch. Recovery text never grants steps or permissions. After a last allowed dispatch, no chase is sent. The bounded model checks the reason and state vocabularies and that neither a second chase nor an extra dispatch is enabled after exhaustion.

Run `$PI_HOME/pi/bin/tlc -config docs/state-machines/stall-detector/StallDetector.cfg docs/state-machines/stall-detector/StallDetector.tla` from the repository root.
