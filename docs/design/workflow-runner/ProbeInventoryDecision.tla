------------------------ MODULE ProbeInventoryDecision ------------------------
\* Decision comparison only: no model transition grants gate-edit authority.
\* A sentinel is checked by its expected violation, not a positive exit zero.
EXTENDS Naturals
CONSTANTS Choice, SentinelGuard, SafetyGuard, GreenGuard
VARIABLES finished, safetyControl, sentinelChecked, sentinelValid, green
vars == <<finished, safetyControl, sentinelChecked, sentinelValid, green>>
Init == /\ finished = FALSE /\ safetyControl = FALSE
        /\ sentinelChecked = FALSE /\ sentinelValid \in BOOLEAN /\ green = FALSE
Audit == /\ ~finished /\ finished' = TRUE
         /\ safetyControl' = SafetyGuard
         /\ sentinelChecked' = (Choice = "probe-aware" /\ SentinelGuard)
         /\ green' = IF ~GreenGuard THEN TRUE
                      ELSE IF Choice = "positives" THEN FALSE
                      ELSE IF Choice = "drop" THEN safetyControl'
                      ELSE safetyControl' /\ sentinelChecked' /\ sentinelValid
         /\ UNCHANGED sentinelValid
Next == Audit \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
NoUncheckedSentinel == finished => sentinelChecked
NoWeakenedSafetyControl == finished => safetyControl
InventoryGreenOnlyIfAllChecked == green => safetyControl /\ sentinelChecked /\ sentinelValid
=============================================================================
