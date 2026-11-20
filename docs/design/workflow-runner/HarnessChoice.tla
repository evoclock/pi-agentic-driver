----------------------------- MODULE HarnessChoice -----------------------------
EXTENDS Naturals
CONSTANT Option
VARIABLES phase, kindMatches, accountPresent, approvalPresent, spawned
vars == <<phase, kindMatches, accountPresent, approvalPresent, spawned>>
Scoped == kindMatches /\ accountPresent /\ approvalPresent
Init == /\ phase = "choose"
        /\ kindMatches \in BOOLEAN /\ accountPresent \in BOOLEAN
        /\ approvalPresent \in BOOLEAN /\ spawned = FALSE
Guarded == /\ phase = "choose" /\ Option = "guarded"
           /\ phase' = IF Scoped THEN "served" ELSE "hold"
           /\ spawned' = Scoped
           /\ UNCHANGED <<kindMatches, accountPresent, approvalPresent>>
Hold == /\ phase = "choose" /\ Option \in {"hold", "owner"}
        /\ phase' = "hold" /\ UNCHANGED <<kindMatches, accountPresent, approvalPresent, spawned>>
Bypass == /\ phase = "choose" /\ Option = "bypass"
          /\ phase' = "served" /\ spawned' = TRUE
          /\ UNCHANGED <<kindMatches, accountPresent, approvalPresent>>
BadType == /\ phase = "choose" /\ Option = "bad-type"
           /\ phase' = "invalid" /\ UNCHANGED <<kindMatches, accountPresent, approvalPresent, spawned>>
Done == /\ phase \in {"served", "hold", "invalid"} /\ UNCHANGED vars
Next == Guarded \/ Hold \/ Bypass \/ BadType \/ Done
ScopedSpawn == spawned => Scoped
TypeOK == /\ phase \in {"choose", "served", "hold"}
          /\ kindMatches \in BOOLEAN /\ accountPresent \in BOOLEAN
          /\ approvalPresent \in BOOLEAN /\ spawned \in BOOLEAN
Spec == Init /\ [][Next]_vars
=============================================================================
