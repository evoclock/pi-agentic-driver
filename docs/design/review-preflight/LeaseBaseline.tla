------------------------- MODULE LeaseBaseline -------------------------
EXTENDS Naturals
CONSTANT FreezeGuard
VARIABLES route, phase, config, locked, checked
vars == <<route, phase, config, locked, checked>>
Init == /\ route = "none" /\ phase = "choose"
        /\ config = 1 /\ locked = 0 /\ checked = FALSE
Fresh == /\ phase = "choose" /\ route' = "fresh" /\ phase' = "prepare"
         /\ UNCHANGED <<config, locked, checked>>
Hold == /\ phase = "choose" /\ route' = "hold" /\ phase' = "held"
        /\ UNCHANGED <<config, locked, checked>>
Baseline == /\ phase = "prepare" /\ locked' = config /\ phase' = "locked"
            /\ UNCHANGED <<route, config, checked>>
ChangeConfig == /\ phase = "locked" /\ ~FreezeGuard /\ config = 1
                /\ config' = 2 /\ UNCHANGED <<route, phase, locked, checked>>
Check == /\ phase = "locked" /\ checked' = TRUE /\ phase' = "done"
         /\ UNCHANGED <<route, config, locked>>
Done == /\ phase \in {"done", "held"} /\ UNCHANGED vars
Next == Fresh \/ Hold \/ Baseline \/ ChangeConfig \/ Check \/ Done
Spec == Init /\ [][Next]_vars
LockCoversCheckedConfiguration == checked => locked = config
=======================================================================
