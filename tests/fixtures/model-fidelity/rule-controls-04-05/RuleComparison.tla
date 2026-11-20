---------------- MODULE RuleComparison ----------------
EXTENDS Naturals
CONSTANTS AllowReplacement, RuleMeaning, InitialGeneration
ASSUME RuleMeaning \in {"current-generation", "pinned-generation", "forbid-after-death"}
VARIABLES phase, generation, token, alive, completed, staleEffect, afterDeath
vars == <<phase, generation, token, alive, completed, staleEffect, afterDeath>>
Init == /\ phase = "cleared" /\ generation = InitialGeneration /\ token = InitialGeneration
        /\ alive = TRUE /\ completed = FALSE /\ staleEffect = FALSE /\ afterDeath = FALSE
ClientDies == /\ phase = "cleared" /\ phase' = "dead" /\ alive' = FALSE
              /\ UNCHANGED <<generation, token, completed, staleEffect, afterDeath>>
ReplaceResource == /\ phase = "dead" /\ AllowReplacement /\ phase' = "replaced"
                   /\ generation' = InitialGeneration + 1
                   /\ UNCHANGED <<token, alive, completed, staleEffect, afterDeath>>
ApplyEffect == /\ phase \in {"dead", "replaced"} /\ phase' = "finished"
               /\ completed' = TRUE /\ staleEffect' = (token # generation) /\ afterDeath' = ~alive
               /\ UNCHANGED <<generation, token, alive>>
Done == phase = "finished" /\ UNCHANGED vars
Next == ClientDies \/ ReplaceResource \/ ApplyEffect \/ Done
Spec == Init /\ [][Next]_vars
Safety == CASE RuleMeaning = "current-generation" -> ~staleEffect
            [] RuleMeaning = "pinned-generation" -> token = InitialGeneration
            [] OTHER -> ~afterDeath
========================================================
