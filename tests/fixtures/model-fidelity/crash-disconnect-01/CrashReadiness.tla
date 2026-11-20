---------------------- MODULE CrashReadiness ----------------------
EXTENDS Naturals
CONSTANT Guarded
ASSUME Guarded \in BOOLEAN
VARIABLES phase, ready, alive, generation, clearedGeneration, applied, staleEffect
vars == <<phase, ready, alive, generation, clearedGeneration, applied, staleEffect>>

Init == /\ phase = "initial"
        /\ ready = FALSE
        /\ alive = TRUE
        /\ generation = 1
        /\ clearedGeneration = 0
        /\ applied = FALSE
        /\ staleEffect = FALSE

PublishReadiness == /\ phase = "initial"
                    /\ phase' = "cleared"
                    /\ ready' = TRUE
                    /\ clearedGeneration' = generation
                    /\ UNCHANGED <<alive, generation, applied, staleEffect>>

ProcessDies == /\ phase = "cleared"
               /\ phase' = "dead"
               /\ alive' = FALSE
               /\ UNCHANGED <<ready, generation, clearedGeneration, applied, staleEffect>>

ReplaceResource == /\ phase = "dead"
                   /\ phase' = "replaced"
                   /\ generation' = 2
                   /\ UNCHANGED <<ready, alive, clearedGeneration, applied, staleEffect>>

ApplyClearedEffect == /\ phase \in {"dead", "replaced"}
                      /\ ready
                      /\ (~Guarded \/ clearedGeneration = generation)
                      /\ phase' = "finished"
                      /\ applied' = TRUE
                      /\ staleEffect' = (clearedGeneration # generation)
                      /\ UNCHANGED <<ready, alive, generation, clearedGeneration>>

RejectStaleEffect == /\ Guarded
                     /\ phase = "replaced"
                     /\ clearedGeneration # generation
                     /\ phase' = "rejected"
                     /\ UNCHANGED <<ready, alive, generation, clearedGeneration, applied, staleEffect>>

Done == phase \in {"finished", "rejected"} /\ UNCHANGED vars
Next == PublishReadiness \/ ProcessDies \/ ReplaceResource \/ ApplyClearedEffect \/ RejectStaleEffect \/ Done
Spec == Init /\ [][Next]_vars
NoStaleEffect == ~staleEffect
====================================================================
