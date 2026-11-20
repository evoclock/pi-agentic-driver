------------------------- MODULE StallDetector -------------------------
EXTENDS Naturals, TLC

CONSTANT MaxSteps
ASSUME MaxSteps \in Nat \ {0}
States == {"idle", "watching", "stalled", "recovery-attempted", "exhausted"}
Reasons == {"none", "idle-timeout", "repeated-tool-loop", "blocked-brief"}
VARIABLES state, reason, remaining, nudges
vars == <<state, reason, remaining, nudges>>

Init == /\ state = "idle" /\ reason = "none"
        /\ remaining = MaxSteps /\ nudges = 0
Start == /\ state = "idle" /\ remaining > 0
         /\ state' = "watching" /\ UNCHANGED <<reason, remaining, nudges>>
Detect(r) == /\ state = "watching" /\ r \in Reasons \ {"none"}
             /\ state' = "stalled" /\ reason' = r
             /\ UNCHANGED <<remaining, nudges>>
Clear == /\ state = "stalled" /\ state' = "watching"
         /\ reason' = "none" /\ UNCHANGED <<remaining, nudges>>
Chase == /\ state = "stalled" /\ remaining > 0 /\ nudges < MaxSteps
         /\ state' = "recovery-attempted" /\ nudges' = nudges + 1
         /\ UNCHANGED <<reason, remaining>>
Dispatch == /\ state \in {"watching", "stalled", "recovery-attempted"}
            /\ remaining > 0 /\ remaining' = remaining - 1
            /\ UNCHANGED <<state, reason, nudges>>
End == /\ state \in {"watching", "stalled", "recovery-attempted"}
       /\ state' = IF remaining = 0 THEN "exhausted" ELSE "idle"
       /\ reason' = "none" /\ UNCHANGED <<remaining, nudges>>
Stop == /\ state # "exhausted" /\ state' = "exhausted"
        /\ reason' = "none" /\ UNCHANGED <<remaining, nudges>>
Next == Start \/ (\E r \in Reasons \ {"none"}: Detect(r)) \/ Clear \/ Chase \/ Dispatch \/ End \/ Stop
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in States /\ reason \in Reasons
          /\ remaining \in 0..MaxSteps /\ nudges \in 0..MaxSteps
NoRepeatChase == state = "recovery-attempted" => reason # "none"
NoDispatchAfterBudget == remaining = 0 => ~ENABLED Dispatch
=============================================================================
