----------------------- MODULE Gap8BaselineDecision -----------------------
\* A: self-contained suite, then the current native audited refresh.
\* B-first: reviewed classifier repair lands before any new baseline lock.
\* A+B: self-contained suite and a separately briefed classifier repair,
\*      but a baseline may run before that repair lands.
\* Hold: preserve inputs and dispute the old crash-derived evidence.
\* A self-contained fixture removes one known import dependency, not all
\* possible parser, dependency or runtime initialization failures.
EXTENDS Naturals
CONSTANTS Option, ClassifierGuard
VARIABLES phase, source, fixed, selfContained, briefed, lockSource
vars == <<phase, source, fixed, selfContained, briefed, lockSource>>
Init == /\ phase = "unbaselined" /\ source = "none"
        /\ fixed = FALSE /\ selfContained = FALSE /\ briefed = FALSE
        /\ lockSource = "none"
PrepareA == /\ Option \in {"A", "A+B"} /\ phase = "unbaselined"
            /\ ~selfContained /\ selfContained' = TRUE
            /\ UNCHANGED <<phase, source, fixed, briefed, lockSource>>
BriefB == /\ Option \in {"B-first", "A+B"} /\ ~briefed
          /\ briefed' = TRUE
          /\ UNCHANGED <<phase, source, fixed, selfContained, lockSource>>
\* Integration by the owner after a separately reviewed native gate repair.
\* This transition is not permission for the G8 worker to edit gate code.
LandReviewedB == /\ briefed /\ ~fixed /\ fixed' = TRUE
                /\ UNCHANGED <<phase, source, selfContained, briefed, lockSource>>
RunBase == /\ phase = "unbaselined"
           /\ \/ (Option = "A" /\ selfContained)
              \/ (Option = "A+B" /\ selfContained /\ briefed)
              \/ (Option = "B-first" /\ fixed)
           /\ source' \in {"loader-crash", "behavioral-red"}
           /\ phase' = source'
           /\ UNCHANGED <<fixed, selfContained, briefed, lockSource>>
TakeLock == /\ phase \in {"loader-crash", "behavioral-red"}
            /\ (phase = "behavioral-red" \/ ~(fixed /\ ClassifierGuard))
            /\ phase' = "locked" /\ lockSource' = source
            /\ UNCHANGED <<source, fixed, selfContained, briefed>>
RejectCrash == /\ phase = "loader-crash" /\ fixed /\ ClassifierGuard
               /\ phase' = "held"
               /\ UNCHANGED <<source, fixed, selfContained, briefed, lockSource>>
HeadGreen == /\ phase = "locked" /\ phase' = "green"
             /\ UNCHANGED <<source, fixed, selfContained, briefed, lockSource>>
Hold == /\ Option = "Hold" /\ phase = "unbaselined" /\ phase' = "held"
        /\ UNCHANGED <<source, fixed, selfContained, briefed, lockSource>>
Next == PrepareA \/ BriefB \/ LandReviewedB \/ RunBase \/ TakeLock
        \/ RejectCrash \/ HeadGreen \/ Hold \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"unbaselined", "loader-crash", "behavioral-red", "locked", "green", "held"}
          /\ source \in {"none", "loader-crash", "behavioral-red"}
          /\ lockSource \in {"none", "loader-crash", "behavioral-red"}
          /\ fixed \in BOOLEAN /\ selfContained \in BOOLEAN /\ briefed \in BOOLEAN
LockOnlyBehavioralRed == lockSource # "none" => lockSource = "behavioral-red"
GreenRequiresBehavioralRed == phase = "green" => lockSource = "behavioral-red"
HoldNeverLocks == Option = "Hold" => lockSource = "none"
\* Coverage probes: each is deliberately false at its target reachable state.
NeverGreen == phase # "green"
NeverRejectedCrash == ~(phase = "held" /\ source = "loader-crash")
\* Negative-only serialization and Hold-lock faults; absent from Init/Next/Spec.
UnsafeTypeAction == /\ phase = "unbaselined" /\ phase' = "corrupt-phase" /\ UNCHANGED <<source, fixed, selfContained, briefed, lockSource>>
UnsafeHoldLock == /\ Option = "Hold" /\ phase = "held"
                  /\ lockSource' = "loader-crash" /\ UNCHANGED <<phase, source, fixed, selfContained, briefed>>
UnsafeTypeSpec == Init /\ [][Next \/ UnsafeTypeAction]_vars
UnsafeHoldSpec == Init /\ [][Next \/ UnsafeHoldLock]_vars
=============================================================================
