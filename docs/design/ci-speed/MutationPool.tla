--------------------------- MODULE MutationPool ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Option
Jobs == 1..3
Limit == IF Option = "serial" THEN 1 ELSE 2
VARIABLES running, finished, reports, accepted
vars == <<running, finished, reports, accepted>>
Init == /\ running = {} /\ finished = {} /\ reports = {} /\ accepted = FALSE
Start(j) == /\ Option # "hold"
            /\ j \notin (running \cup finished)
            /\ Cardinality(running) < Limit
            /\ running' = running \cup {j}
            /\ UNCHANGED <<finished, reports, accepted>>
Finish(j) == /\ j \in running
             /\ running' = running \ {j}
             /\ finished' = finished \cup {j}
             /\ reports' = reports \cup {<<j, IF Option = "misattribute" THEN 1 ELSE j>>}
             /\ UNCHANGED accepted
Accept == /\ ~accepted
          /\ IF Option = "skip" THEN finished # {} ELSE finished = Jobs
          /\ accepted' = TRUE
          /\ UNCHANGED <<running, finished, reports>>
Next == (\E j \in Jobs: Start(j) \/ Finish(j)) \/ Accept
OwnTree == Option # "shared" \/ Cardinality(running) <= 1
Attribution == \A pair \in reports: pair[1] = pair[2]
CompleteProof == accepted => finished = Jobs
Spec == Init /\ [][Next]_vars
=============================================================================
