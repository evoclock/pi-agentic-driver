-------------------------- MODULE Fix4RunnerRR5 --------------------------
EXTENDS Naturals, FiniteSets
\* A bounded refinement of Fix4Runner's atomic writer and halt actions.
\* Two polls stand for the production history cap (1,024), not byte counts.
\* A stale observation of generation 2 can survive cleanup of generation 3.
CONSTANTS FreshGenerationGuard, OwnerCapGuard
ASSUME /\ FreshGenerationGuard \in BOOLEAN /\ OwnerCapGuard \in BOOLEAN
VARIABLE s
vars == <<s>>
Init == s = [pc |-> "idle", highest |-> 2, proposed |-> 0,
  retired |-> FALSE, actedBy |-> {}, fork |-> FALSE,
  polls |-> 0, ownerAttempted |-> FALSE, ownerRefused |-> FALSE,
  halted |-> FALSE]
Observe == /\ s.pc = "idle"
  /\ s' = [s EXCEPT !.pc = "observed", !.proposed = s.highest + 1]
\* Completed new generations are published and compact the stale proposal's
\* old name. The model collapses twelve real look ticks into one bounded step.
AdvanceAndCompact == /\ s.pc = "observed" /\ ~s.retired
  /\ s' = [s EXCEPT !.highest = 4, !.retired = TRUE]
Link == /\ s.pc = "observed"
  /\ s' = [s EXCEPT !.pc = "linked"]
Validate == /\ s.pc = "linked"
  /\ s' = [s EXCEPT !.pc = (IF FreshGenerationGuard /\ s.highest > s.proposed
                                  THEN "withdrawn" ELSE "checked")]
FreshAct == /\ s.pc = "checked" /\ s.highest > s.proposed
  /\ 2 \notin s.actedBy
  /\ s' = [s EXCEPT !.actedBy = @ \cup {2}]
StaleAct == /\ s.pc = "checked" /\ 1 \notin s.actedBy
  /\ s' = [s EXCEPT !.actedBy = @ \cup {1},
    !.fork = (2 \in s.actedBy)]
Poll == /\ s.polls < 2 /\ ~s.halted
  /\ s' = [s EXCEPT !.polls = @ + 1]
\* An owner stop is a real attempted input even at the cap; an unsafe guard
\* makes its refusal visible as a safety-state violation, not a missing action.
OwnerStop == /\ ~s.ownerAttempted
  /\ s' = [s EXCEPT !.ownerAttempted = TRUE,
    !.ownerRefused = ~OwnerCapGuard /\ s.polls = 2,
    !.halted = OwnerCapGuard \/ s.polls < 2]
\* Terminal states are quiescent; no fairness or owner-service liveness is claimed.
Next == Observe \/ AdvanceAndCompact \/ Link \/ Validate \/ FreshAct \/ StaleAct \/ Poll \/ OwnerStop \/ UNCHANGED s
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.pc \in {"idle", "observed", "linked", "checked", "withdrawn"}
  /\ s.highest \in {2, 4} /\ s.proposed \in {0, 3}
  /\ s.polls \in 0..2 /\ s.actedBy \subseteq {1, 2}
OneWriterNoFork == Cardinality(s.actedBy) <= 1 /\ ~s.fork
OwnerStopAvailable == ~s.ownerRefused
=============================================================================
