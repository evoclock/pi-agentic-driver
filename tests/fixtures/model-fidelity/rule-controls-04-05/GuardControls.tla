---------------- MODULE GuardControls ----------------
EXTENDS Naturals
CONSTANTS GuardA, GuardB, AllowReplacement, OmitAudit
VARIABLES phase, generation, token, completed, staleEffect, auditMissing
vars == <<phase, generation, token, completed, staleEffect, auditMissing>>
Init == /\ phase = "cleared" /\ generation = 1 /\ token = 1
        /\ completed = FALSE /\ staleEffect = FALSE /\ auditMissing = FALSE
ClientDies == /\ phase = "cleared" /\ phase' = "dead"
              /\ UNCHANGED <<generation, token, completed, staleEffect, auditMissing>>
ReplaceResource == /\ phase = "dead" /\ AllowReplacement /\ ~GuardB
                   /\ phase' = "replaced" /\ generation' = 2
                   /\ UNCHANGED <<token, completed, staleEffect, auditMissing>>
ApplyEffect == /\ phase \in {"dead", "replaced"}
               /\ (~GuardA \/ token = generation) /\ phase' = "finished"
               /\ completed' = TRUE /\ staleEffect' = (token # generation) /\ auditMissing' = OmitAudit
               /\ UNCHANGED <<generation, token>>
RejectEffect == /\ phase = "replaced" /\ GuardA /\ token # generation /\ phase' = "rejected"
                /\ UNCHANGED <<generation, token, completed, staleEffect, auditMissing>>
Done == phase \in {"finished", "rejected"} /\ UNCHANGED vars
Next == ClientDies \/ ReplaceResource \/ ApplyEffect \/ RejectEffect \/ Done
Spec == Init /\ [][Next]_vars
NoStaleEffect == ~staleEffect
NoHazard == token = generation
NoAuditLoss == ~auditMissing
=======================================================
