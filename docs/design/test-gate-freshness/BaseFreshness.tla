--------------------------- MODULE BaseFreshness ---------------------------
EXTENDS Naturals
CONSTANT Unsafe
VARIABLES main, head, lease, stage, lockFresh, reviewFresh, classification, comparison
vars == <<main, head, lease, stage, lockFresh, reviewFresh, classification, comparison>>
Init == /\ main = 0 /\ head = 0 /\ lease = 0 /\ stage = "lease"
        /\ lockFresh = TRUE /\ reviewFresh = TRUE /\ classification = "none" /\ comparison = 0
\* Bounded main generations model ancestry; actions fetch main atomically.
Advance == /\ main < 2 /\ main' = main + 1
           /\ UNCHANGED <<head, lease, stage, lockFresh, reviewFresh, classification>>
CatchUp == /\ head < main /\ head' = main /\ lease' = IF Unsafe = "lease" THEN main + 1 ELSE main
           /\ stage' = "lease" /\ classification' = "stale"
           /\ UNCHANGED <<main, lockFresh, reviewFresh>>
\* main is the live anchor; a comparison override never substitutes for it.
ChooseComparison == /\ comparison' \in 0..head
                    /\ UNCHANGED <<main, head, lease, stage, lockFresh, reviewFresh, classification>>
Baseline == /\ stage = "lease" /\ (head = main \/ Unsafe = "lock" \/ (Unsafe = "override" /\ head >= comparison))
            /\ stage' = "lock" /\ lockFresh' = (head = main)
            /\ UNCHANGED <<main, head, lease, reviewFresh, classification>>
Review == /\ stage = "lock" /\ (head = main \/ Unsafe = "review")
          /\ stage' = "review" /\ reviewFresh' = (head = main)
          /\ UNCHANGED <<main, head, lease, lockFresh, classification>>
Push == /\ stage = "review" /\ head = main /\ stage' = "push"
        /\ UNCHANGED <<main, head, lease, lockFresh, reviewFresh, classification>>
CI == /\ stage = "push" /\ head = main /\ stage' = "ci"
      /\ UNCHANGED <<main, head, lease, lockFresh, reviewFresh, classification>>
\* Owner-only merge is modeled, not authorized by the model.
Merge == /\ stage = "ci" /\ head = main /\ stage' = "merged"
         /\ UNCHANGED <<main, head, lease, lockFresh, reviewFresh, classification>>
Reject == /\ head < main
          /\ classification' = IF Unsafe = "missing" THEN "missing" ELSE "stale"
          /\ UNCHANGED <<main, head, lease, stage, lockFresh, reviewFresh>>
Hold == UNCHANGED vars
Next == ChooseComparison \/ ((Advance \/ CatchUp \/ Baseline \/ Review \/ Push \/ CI \/ Merge \/ Reject \/ Hold) /\ UNCHANGED comparison)
Spec == Init /\ [][Next]_vars
NoLockOnStaleBase == lockFresh
NoReviewOnStaleHead == reviewFresh
StaleNeverClassifiedAsMissingTest == classification # "missing"
LeaseRecorded == lease <= head
\* Reachability controls are intentionally false invariants.
NeverMerged == stage # "merged"
NeverStale == classification # "stale"
=============================================================================
