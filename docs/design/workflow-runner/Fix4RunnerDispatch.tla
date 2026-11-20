----------------------- MODULE Fix4RunnerDispatch -----------------------
EXTENDS Naturals
CONSTANTS RequirementGuard, OnceGuard
VARIABLE s
vars == <<s>>
Init == s \in {[required |-> r, claimed |-> FALSE, pc |-> "idle",
  claims |-> 0, spawns |-> 0, prompts |-> 0, stopped |-> FALSE] : r \in BOOLEAN}
Claim == /\ ~s.stopped /\ s.claims < 2 /\ s.pc \in {"idle", "unknown"}
  /\ (~RequirementGuard \/ s.required) /\ (~OnceGuard \/ ~s.claimed)
  /\ s' = [s EXCEPT !.claimed = TRUE, !.claims = @ + 1, !.pc = "claimed"]
Spawn == /\ ~s.stopped /\ s.pc = "claimed"
  /\ s' = [s EXCEPT !.spawns = @ + 1, !.pc = "spawned"]
Submit == /\ ~s.stopped /\ s.pc = "spawned"
  /\ s' = [s EXCEPT !.prompts = @ + 1, !.pc = "submitted"]
Crash == /\ s.pc \in {"claimed", "spawned", "submitted"}
  /\ s' = [s EXCEPT !.pc = "unknown"]
Stop == /\ ~s.stopped /\ s' = [s EXCEPT !.stopped = TRUE]
\* Lost replies, duplicate events and unknown readbacks never reissue effects.
Observe == UNCHANGED s
Next == Claim \/ Spawn \/ Submit \/ Crash \/ Stop \/ Observe
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.pc \in {"idle", "claimed", "spawned", "submitted", "unknown"}
  /\ s.claims \in 0..2 /\ s.spawns \in 0..2 /\ s.prompts \in 0..2
DispatchHasRequirement == s.spawns > 0 => s.required
NoBlindResend == s.spawns <= 1 /\ s.prompts <= 1
=============================================================================
