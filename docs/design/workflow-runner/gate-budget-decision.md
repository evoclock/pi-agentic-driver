# Native gate aggregate budget

The native aggregate supervisor is branch-owned code, separate from locked
per-command and make-gate caps. The original 600-second aggregate timed out on
an incomplete measured 639.623 seconds of child work. Its first revision used
900 seconds with a 960-second outer allowance.

After inventory tooling merged, its PR reported a completed 117-contract native
run of 1381.865 seconds. That observation alone cannot fit a 900-second aggregate
or leave 25 percent headroom. G8's merged contract set is larger, so the inventory
measurement is only a reported lower-bound workload comparison, not a measured
complete G8 run or a local passing observation.

Reversible implementation choice: use a conservative 2400-second native
aggregate and a 2460-second outer allowance for the first complete integrated
G8 run. Relative to the reported inventory observation this leaves 42.42 percent
headroom; actual G8 headroom remains unknown until its full run completes. Keep
all contracts and do not claim a complete measurement from a blocked baseline.
Record the actual completed G8 duration in the PR body before review. If it
exceeds 1800 seconds, revisit the aggregate through the reviewed-code route
rather than accepting less than 25 percent headroom on a rerun.

Locked native child timeout 240 seconds (maximum 300), make-gate cap 600 seconds,
25-percent independent per-step preflight, and all locked configuration are
unchanged. No generated lock or evidence is hand-edited. The new native contracts
exercise the headroom predicate and prevent regression to the obsolete aggregate.

Tests: `tests/test_gate_runtime_preflight.py` checks constants, outer allowance,
the old measured lower bound, the merged-workload comparison, exact headroom
boundary, each independent cap, unknown history, and rejection before lock/child.
The aggregate constant and before-effect predicate have separate native mutation
controls. Initial changed-test run was assertion-red before the constants changed;
the focused suite then passed all 12 cases.
