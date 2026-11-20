# Approval grants

`ApprovalGrants.tla` models one bounded grant. A reservation spends one use; an outcome settles only that reservation, at most once. Expiry and revocation disable new reservations without erasing old uses. Status is derived in priority order: revoked, expired, used-up, active. The model checks capacity, settlement membership and the closed status vocabulary. `CHECK_DEADLOCK FALSE` allows the grant to end with no further commands.

Production mapping: `recordApproval` creates the grant, `authorizeApproval` reads `approvalGrantStatus`, `reserveApprovalUse` creates and returns the use identity, and `recordApprovalUse` appends its outcome under the same writer lock. Historical unlinked outcome rows remain readable, but cannot be used to settle a new reservation. A reservation is not refunded after a partial spawn or an audit outcome.

Run from a child of repository `.scratch/` (the installed TLC wrapper requires that location): `$PI_HOME/pi/bin/tlc -config ../../docs/state-machines/approval-grants/ApprovalGrants.cfg ../../docs/state-machines/approval-grants/ApprovalGrants.tla`.
