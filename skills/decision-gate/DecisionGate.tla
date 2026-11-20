---------------------------- MODULE DecisionGate ----------------------------
EXTENDS Naturals
CONSTANTS UnsafeOwner, UnsafeRecord, UnsafeEnforce
VARIABLES choice, recorded, enforced, proceeded
vars == <<choice, recorded, enforced, proceeded>>
Options == {"native", "hold", "owner"}
Init == /\ choice = "none"
        /\ recorded = <<>>
        /\ enforced = FALSE
        /\ proceeded = FALSE
Choose == /\ choice = "none"
          /\ choice' \in Options
          /\ UNCHANGED <<recorded, enforced, proceeded>>
Record == /\ choice # "none"
          /\ recorded' = <<"DecisionGate", "checked", choice>>
          /\ UNCHANGED <<choice, enforced, proceeded>>
Enforce == /\ choice # "none"
           /\ enforced' = TRUE
           /\ UNCHANGED <<choice, recorded, proceeded>>
Proceed == /\ choice \in (IF UnsafeOwner THEN {"native", "owner"} ELSE {"native"})
           /\ (UnsafeRecord \/ recorded = <<"DecisionGate", "checked", choice>>)
           /\ (UnsafeEnforce \/ enforced)
           /\ proceeded' = TRUE
           /\ UNCHANGED <<choice, recorded, enforced>>
Hold == /\ ~proceeded
        /\ choice' = "hold"
        /\ recorded' = <<>>
        /\ enforced' = FALSE
        /\ UNCHANGED proceeded
Next == Choose \/ Record \/ Enforce \/ Proceed \/ Hold
Spec == Init /\ [][Next]_vars
TypeOK == /\ choice \in Options \cup {"none"}
          /\ recorded \in {<<>>} \cup {<<"DecisionGate", "checked", c>> : c \in Options}
          /\ enforced \in BOOLEAN /\ proceeded \in BOOLEAN
OwnerBoundary == proceeded => choice # "owner"
RecordedBeforeProceed == proceeded => recorded = <<"DecisionGate", "checked", choice>>
EnforcedBeforeProceed == proceeded => enforced
\* Hold is available by construction before proceed; no separate safety proof is claimed.
=============================================================================
