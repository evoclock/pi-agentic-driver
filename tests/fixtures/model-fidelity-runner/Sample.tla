------------------------------- MODULE Sample -------------------------------
EXTENDS Naturals
VARIABLE step
Init == step = 0
Advance == step = 0 /\ step' = 1
Done == step = 1 /\ UNCHANGED step
Next == Advance \/ Done
Safe == step <= 1
Unsafe == step = 0
Spec == Init /\ [][Next]_step
=============================================================================
