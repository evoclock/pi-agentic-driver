# TLC result

Checked 12 November 2026 with TLC2 2.19, `ApprovalGrants.cfg`: model checking completed; no error. 152 states generated, 76 distinct states, depth 7. Invariants `TypeOK` and `Capacity` passed. Terminal deadlocks are allowed by the configuration because a revoked or expired grant can have no enabled command.
