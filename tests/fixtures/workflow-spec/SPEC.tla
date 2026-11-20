---------------- MODULE SPEC ----------------
EXTENDS Naturals
CONSTANT SkipGuard
VARIABLE reviewed
Init == reviewed = FALSE
Review == reviewed' = TRUE
Dispatch == reviewed \/ ~SkipGuard
Next == Review \/ (Dispatch /\ UNCHANGED reviewed)
Spec == Init /\ [][Next]_reviewed
NoSkippedReview == reviewed \/ SkipGuard
=============================================
