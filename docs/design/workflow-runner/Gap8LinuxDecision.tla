------------------------ MODULE Gap8LinuxDecision ------------------------
\* Decision model, not a guest execution implementation or permission grant.
\* A = park with explicit unavailable; B = separately reviewed adapter;
\* Hold = retain the task without running checks. OwnerReview/Confirm are
\* owner-only assumptions for B, not effects authorized by this model.
EXTENDS Naturals
CONSTANTS Option, UnavailableGuard, NativeGuard
VARIABLES phase, reviewed, confirmed, executed, unavailable, passed
vars == <<phase, reviewed, confirmed, executed, unavailable, passed>>
Init == /\ phase = "requested" /\ reviewed = FALSE /\ confirmed = FALSE
        /\ executed = FALSE /\ unavailable = FALSE /\ passed = FALSE
Park == /\ phase = "requested" /\ Option = "A"
        /\ phase' = "parked" /\ unavailable' = TRUE
        /\ passed' = ~UnavailableGuard
        /\ UNCHANGED <<reviewed, confirmed, executed>>
Hold == /\ phase = "requested" /\ Option = "Hold"
        /\ phase' = "held"
        /\ UNCHANGED <<reviewed, confirmed, executed, unavailable, passed>>
OwnerReview == /\ phase = "requested" /\ Option = "B"
               /\ phase' = "adapter-reviewed" /\ reviewed' = TRUE
               /\ UNCHANGED <<confirmed, executed, unavailable, passed>>
Confirm == /\ phase = "adapter-reviewed"
           /\ phase' = "confirmed" /\ confirmed' = TRUE
           /\ UNCHANGED <<reviewed, executed, unavailable, passed>>
Run == /\ Option = "B" /\ ~executed
       /\ IF NativeGuard THEN phase = "confirmed" ELSE phase = "requested"
       /\ executed' = TRUE /\ phase' = "result"
       /\ passed' \in BOOLEAN
       /\ UNCHANGED <<reviewed, confirmed, unavailable>>
Fail == /\ phase \in {"adapter-reviewed", "confirmed"}
        /\ phase' = "parked" /\ unavailable' = TRUE
        /\ passed' = ~UnavailableGuard
        /\ UNCHANGED <<reviewed, confirmed, executed>>
Done == /\ phase \in {"parked", "held", "result"} /\ UNCHANGED vars
Actions == Park \/ Hold \/ OwnerReview \/ Confirm \/ Run \/ Fail
Next == Actions \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Actions)
TypeOK == /\ phase \in {"requested", "adapter-reviewed", "confirmed", "parked", "held", "result"}
          /\ reviewed \in BOOLEAN /\ confirmed \in BOOLEAN
          /\ executed \in BOOLEAN /\ unavailable \in BOOLEAN /\ passed \in BOOLEAN
UnavailableNeverPass == unavailable => ~passed
NativeBoundary == executed => reviewed /\ confirmed
PassRequiresExecution == passed => executed
HoldNeverExecutes == Option = "Hold" => ~executed
Settles == <> (phase \in {"parked", "held", "result"})
\* Negative-only malformed phase and Hold execution faults.
UnsafeTypeAction == /\ phase = "requested" /\ phase' = "corrupt-phase" /\ UNCHANGED <<reviewed, confirmed, executed, unavailable, passed>>
UnsafeHoldExecution == /\ Option = "Hold" /\ phase = "held"
                       /\ executed' = TRUE /\ UNCHANGED <<phase, reviewed, confirmed, unavailable, passed>>
UnsafeTypeSpec == Init /\ [][Next \/ UnsafeTypeAction]_vars
UnsafeHoldSpec == Init /\ [][Next \/ UnsafeHoldExecution]_vars
=============================================================================
