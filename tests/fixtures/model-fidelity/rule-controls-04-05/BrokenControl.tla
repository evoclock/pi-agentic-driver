---------------- MODULE BrokenControl ----------------
VARIABLE phase
Init == phase =
Next == UNCHANGED phase
Spec == Init /\ [][Next]_phase
NoStaleEffect == TRUE
=======================================================
