---------------- MODULE BudgetTransition ----------------
EXTENDS Integers
CONSTANTS Split, Guard, NativeCap
VARIABLES phase, jitter, ready, ciPass
vars == <<phase, jitter, ready, ciPass>>
\* Rounded measured seconds, plus bounded setup (100s) and jitter (0..100s).
Native == 1587 + 100 + jitter
Shared == 163 + 100 + jitter
Total == 1587 + 163 + 100 + jitter
Fits == IF Split THEN Native <= NativeCap /\ Shared <= 600 ELSE Total <= NativeCap
Room == IF Split THEN 4 * Native <= 3 * NativeCap /\ 4 * Shared <= 3 * 600
        ELSE 4 * Total <= 3 * NativeCap
Init == /\ phase = "plan" /\ jitter \in 0..100 /\ ready = FALSE /\ ciPass = FALSE
Validate == /\ phase = "plan" /\ phase' = "checked"
            /\ ready' = ((Fits /\ Room) \/ ~Guard) /\ UNCHANGED <<jitter, ciPass>>
Run == /\ phase = "checked" /\ ready /\ phase' = "ci"
       /\ ciPass' = Fits /\ UNCHANGED <<jitter, ready>>
Push == /\ phase = "ci" /\ (ciPass \/ ~Guard) /\ phase' = "push"
        /\ UNCHANGED <<jitter, ready, ciPass>>
Hold == /\ phase = "checked" /\ ~ready /\ phase' = "hold"
        /\ UNCHANGED <<jitter, ready, ciPass>>
Done == /\ phase \in {"push", "hold"} /\ UNCHANGED vars
Next == Validate \/ Run \/ Push \/ Hold \/ Done
Spec == Init /\ [][Next]_vars
NoRedPush == phase = "push" => ciPass
Headroom == ready => Room
SplitCanRun == phase = "checked" /\ Split => ready
NeverPushed == phase # "push"
==========================================================
