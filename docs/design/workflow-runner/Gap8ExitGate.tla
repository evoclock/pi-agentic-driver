--------------------------- MODULE Gap8ExitGate ---------------------------
\* G8 exit gate with a progress-ruled retry loop. Declared checks
\* (lint, types, one test per spec invariant) run on the receipt
\* commit. Each failed pass produces a gap set (the failed check
\* ids, each mapped back to the spec invariants it covers). The
\* worker is re-dispatched with that list until the set is empty.
\* The loop continues while the gap set shrinks or changes. It
\* parks on: no progress (the same gap set for NoProgressLimit
\* consecutive passes), a hard safety ceiling (a backstop, not a
\* budget), or a non-retryable condition (nothing declared, an
\* invariant without a test, or a test command that observed zero
\* tests). A step is never marked done while gaps remain.
EXTENDS Naturals, FiniteSets
CONSTANTS ExitGuard, BindGuard, EmptyGuard, CoverageGuard,
          GapGuard, ProgressGuard, CeilingGuard, ZeroGuard
CONSTANTS NoProgressLimit, SafetyCeiling
Checks == {"lint", "types", "inv"}
VARIABLES declared, covered, zero, commit, res, phase,
          gaps, prevGaps, staleStreak, passes,
          passAtDone, freshAtDone, declaredAtDone, coveredAtDone,
          gapsAtDone, zeroAtDone
vars == <<declared, covered, zero, commit, res, phase,
          gaps, prevGaps, staleStreak, passes,
          passAtDone, freshAtDone, declaredAtDone, coveredAtDone,
          gapsAtDone, zeroAtDone>>
None == [st |-> "none", at |-> 0]
AllPass == \A c \in declared: res[c].st = "pass"
AllFresh == \A c \in declared: res[c].at = commit
CurGaps == {c \in declared: res[c].st = "fail" /\ res[c].at = commit}
Closed == declared # {} => \A c \in declared: res[c].at = commit /\ res[c].st # "none"
GateOpen == /\ ~EmptyGuard \/ declared # {}
            /\ ~CoverageGuard \/ covered
            /\ ~ZeroGuard \/ ~zero
            /\ ~ExitGuard \/ AllPass
            /\ ~BindGuard \/ AllFresh
Init == /\ declared \in SUBSET Checks /\ covered \in BOOLEAN /\ zero \in BOOLEAN
        /\ commit = 0 /\ res = [c \in Checks |-> None] /\ phase = "working"
        /\ gaps = {} /\ prevGaps = {} /\ staleStreak = 0 /\ passes = 0
        /\ passAtDone = FALSE /\ freshAtDone = FALSE
        /\ declaredAtDone = {} /\ coveredAtDone = FALSE
        /\ gapsAtDone = {} /\ zeroAtDone = FALSE
Frozen == <<passAtDone, freshAtDone, declaredAtDone, coveredAtDone,
            gapsAtDone, zeroAtDone>>
Loop == <<gaps, prevGaps, staleStreak, passes>>
\* A new receipt. After the first, commit toggles in {1, 2} so the
\* state space stays finite while the loop can run past two attempts.
Receipt == /\ phase = "working"
           /\ commit' = IF commit = 0 THEN 1 ELSE 3 - commit
           /\ phase' = "checking"
           /\ UNCHANGED <<declared, covered, zero, res>>
           /\ UNCHANGED Loop /\ UNCHANGED Frozen
\* Run each declared check at most once on the current commit.
RunCheck == /\ phase = "checking"
            /\ \E c \in declared, o \in {"pass", "fail"}:
                 /\ res[c].at # commit
                 /\ res' = [res EXCEPT ![c] = [st |-> o, at |-> commit]]
            /\ UNCHANGED <<declared, covered, zero, commit, phase>>
            /\ UNCHANGED Loop /\ UNCHANGED Frozen
Advance == /\ phase = "checking" /\ GateOpen
           /\ phase' = "done"
           /\ passAtDone' = AllPass /\ freshAtDone' = AllFresh
           /\ declaredAtDone' = declared /\ coveredAtDone' = covered
           /\ gapsAtDone' = IF ExitGuard THEN CurGaps ELSE {}
           /\ zeroAtDone' = zero
           \* When ExitGuard is off, the buggy runner marks the step done
           \* and drops the gap list, so only ChecksPassedBeforeDone fails.
           /\ UNCHANGED <<declared, covered, zero, commit, res>>
           /\ UNCHANGED Loop
SameGaps == CurGaps = prevGaps
NextStreak == IF SameGaps THEN staleStreak + 1 ELSE 1
NoProgress == ProgressGuard /\ Closed /\ CurGaps # {} /\ NextStreak >= NoProgressLimit
HitCeiling == CeilingGuard /\ passes + 1 >= SafetyCeiling
NonRetryable == declared = {} \/ ~covered \/ zero
Park == /\ phase = "checking"
        /\ \/ NonRetryable
           \/ (Closed /\ CurGaps # {} /\ NoProgress)
           \/ (Closed /\ CurGaps # {} /\ HitCeiling)
        /\ phase' = "parked"
        /\ UNCHANGED <<declared, covered, zero, commit, res>>
        /\ UNCHANGED Loop /\ UNCHANGED Frozen
\* Return to the loop with the gap set, only when that set shrunk or
\* changed and the safety ceiling has not been hit. The counter is
\* capped so TLC can enumerate even when CeilingGuard is off.
Return == /\ phase = "checking" /\ Closed /\ CurGaps # {} /\ ~NonRetryable
          /\ ~NoProgress /\ ~HitCeiling
          /\ phase' = "working"
          /\ gaps' = CurGaps
          /\ prevGaps' = CurGaps
          /\ staleStreak' = IF NextStreak < NoProgressLimit
                            THEN NextStreak
                            ELSE NoProgressLimit
          /\ passes' = IF passes < SafetyCeiling THEN passes + 1 ELSE passes
          /\ UNCHANGED <<declared, covered, zero, commit, res>>
          /\ UNCHANGED Frozen
\* Buggy: mark the step done while the gap set is still nonempty.
\* Only enabled when GapGuard is off. Claims the checks passed.
CompleteWithGaps == /\ ~GapGuard
                    /\ phase = "checking" /\ CurGaps # {} /\ ~NonRetryable
                    /\ phase' = "done"
                    /\ passAtDone' = TRUE /\ freshAtDone' = AllFresh
                    /\ declaredAtDone' = declared /\ coveredAtDone' = covered
                    /\ gapsAtDone' = CurGaps /\ zeroAtDone' = zero
                    /\ UNCHANGED <<declared, covered, zero, commit, res>>
                    /\ UNCHANGED Loop
Actions == Receipt \/ RunCheck \/ Advance \/ Return \/ Park \/ CompleteWithGaps
Next == Actions \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
FairSpec == Init /\ [][Next]_vars /\ WF_vars(Actions)
TypeOK == /\ declared \subseteq Checks /\ covered \in BOOLEAN /\ zero \in BOOLEAN
          /\ commit \in 0..2
          /\ phase \in {"working", "checking", "done", "parked"}
          /\ gaps \subseteq Checks /\ prevGaps \subseteq Checks
          /\ staleStreak \in 0..NoProgressLimit
          /\ passes \in 0..SafetyCeiling
          /\ passAtDone \in BOOLEAN /\ freshAtDone \in BOOLEAN
          /\ declaredAtDone \subseteq Checks /\ coveredAtDone \in BOOLEAN
          /\ gapsAtDone \subseteq Checks /\ zeroAtDone \in BOOLEAN
ChecksPassedBeforeDone == phase = "done" => passAtDone
FreshEvidenceOnly == phase = "done" => freshAtDone
NoVacuousDone == phase = "done" => declaredAtDone # {}
EveryInvariantTested == phase = "done" => coveredAtDone
NoDoneWithGaps == phase = "done" => gapsAtDone = {}
NoZeroTestDone == phase = "done" => ~zeroAtDone
Termination == <>[](phase \in {"done", "parked"})
\* Negative-only malformed phase decoder; ordinary protocol is unchanged.
UnsafeTypeAction == /\ phase = "working" /\ phase' = "corrupt-phase" /\ UNCHANGED <<declared, covered, zero, commit, res, gaps, prevGaps, staleStreak, passes, passAtDone, freshAtDone, declaredAtDone, coveredAtDone, gapsAtDone, zeroAtDone>>
UnsafeTypeSpec == Init /\ [][Next \/ UnsafeTypeAction]_vars
=============================================================================
