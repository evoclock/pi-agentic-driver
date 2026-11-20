---------------------- MODULE Fix4RunnerProcedure ----------------------
EXTENDS Naturals, FiniteSets
\* Bounded refinement of Fix4Runner's dispatch/result boundary. Host honesty,
\* process execution and filesystem durability are assumptions, not proved here.
CONSTANT BindingGuard
VARIABLE s
vars == <<s>>
Current == [task |-> 1, step |-> 1, epoch |-> 1, writer |-> 1,
  dispatch |-> 1, input |-> 1, requirement |-> 1]
Observations == {Current} \cup
  {[Current EXCEPT ![k] = 2] : k \in {"task", "epoch"}}
Init == s = [observation |-> Current, evidence |-> 0, consumed |-> {},
  verified |-> FALSE, matchingAtVerify |-> FALSE, phase |-> "ready"]
Observe == /\ s.phase = "ready"
  /\ \E o \in Observations, e \in {1, 2}:
    s' = [s EXCEPT !.observation = o, !.evidence = e, !.phase = "observed"]
Verify == /\ s.phase = "observed"
  /\ s' = [s EXCEPT !.phase = "checked",
    !.verified = (~BindingGuard \/
      (s.observation = Current /\ s.evidence \notin s.consumed)),
    !.matchingAtVerify = (s.observation = Current /\ s.evidence \notin s.consumed),
    !.consumed = IF ~BindingGuard \/
      (s.observation = Current /\ s.evidence \notin s.consumed)
      THEN @ \cup {s.evidence} ELSE @]
\* A second event may try to spend the first observation again.
Again == /\ s.phase = "checked"
  /\ s' = [s EXCEPT !.phase = "observed", !.verified = FALSE]
\* Event-id idempotency reads the previous result without spending again.
Duplicate == /\ s.phase = "checked" /\ UNCHANGED s
Next == Observe \/ Verify \/ Again \/ Duplicate \/ UNCHANGED s
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.phase \in {"ready", "observed", "checked"}
  /\ s.evidence \in 0..2 /\ s.consumed \subseteq {1, 2}
  /\ s.observation \in Observations /\ s.verified \in BOOLEAN
NoUnboundProcedure == s.verified => s.matchingAtVerify
=============================================================================
