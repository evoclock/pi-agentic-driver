----------------------- MODULE ParallelScheduler -----------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Tasks, Slots, Depends, Conflicts, Fault
VARIABLES running, merged, closed, abandoned, lease, returned, startedAfterDeps
vars == <<running, merged, closed, abandoned, lease, returned, startedAfterDeps>>
ExampleDepends == [t \in Tasks |-> IF t = 3 THEN {1} ELSE {}]
ExampleConflicts == {<<1,2>>, <<2,1>>}
Held == {lease[t] : t \in running}
Free == Slots \ Held
Ready(t) == /\ t \notin (running \cup merged \cup abandoned)
            /\ Depends[t] \subseteq merged
            /\ \A u \in running : <<t,u>> \notin Conflicts
Init == /\ running = {} /\ merged = {} /\ closed = {} /\ abandoned = {}
        /\ returned = {} /\ lease = [t \in Tasks |-> 0]
        /\ startedAfterDeps = {}
Start(t,s) ==
  /\ Fault # "starve"
  /\ t \notin (running \cup merged \cup abandoned)
  /\ (Depends[t] \subseteq merged \/ Fault = "deps")
  /\ ((\A u \in running : <<t,u>> \notin Conflicts) \/ Fault = "overlap")
  /\ (s \in Free \/ Fault \in {"unique", "cap"})
  /\ (Cardinality(running) < Cardinality(Slots) \/ Fault = "cap")
  /\ running' = running \cup {t}
  /\ lease' = [lease EXCEPT ![t] = s]
  /\ startedAfterDeps' = IF Depends[t] \subseteq merged
                         THEN startedAfterDeps \cup {t} ELSE startedAfterDeps
  /\ UNCHANGED <<merged, closed, abandoned, returned>>
Merge(t) == /\ t \in running \ closed
            /\ running' = running \ {t}
            /\ merged' = merged \cup {t}
            /\ returned' = IF Fault = "leak" THEN returned ELSE returned \cup {t}
            /\ UNCHANGED <<closed, abandoned, lease, startedAfterDeps>>
Close(t) == /\ t \in running \ closed
            /\ closed' = closed \cup {t}
            /\ UNCHANGED <<running, merged, abandoned, lease, returned, startedAfterDeps>>
Abandon(t) == /\ t \in running \cap closed
              /\ running' = running \ {t}
              /\ abandoned' = abandoned \cup {t}
              /\ returned' = IF Fault = "abandon-leak" THEN returned ELSE returned \cup {t}
              /\ UNCHANGED <<merged, closed, lease, startedAfterDeps>>
Resolve(t) == Merge(t) \/ Close(t)
Next == \/ (\E t \in Tasks, s \in Slots : Start(t,s))
        \/ (\E t \in Tasks : Resolve(t) \/ Abandon(t))
Spec == Init /\ [][Next]_vars
        /\ (\A t \in Tasks : WF_vars(\E s \in Slots : Start(t,s)))
        /\ (\A t \in Tasks : WF_vars(Resolve(t)))
        /\ (\A t \in Tasks : WF_vars(Abandon(t)))
NoOverlapRunning == \A t,u \in running : <<t,u>> \notin Conflicts
DepsMergedBeforeStart == running \cup merged \cup abandoned \subseteq startedAfterDeps
LeaseUnique == \A t,u \in running : t # u => lease[t] # lease[u]
NoLeakedLease == merged \cup abandoned \subseteq returned
SlotCap == Cardinality(running) <= Cardinality(Slots)
NoStarvation == \A t \in Tasks : (Ready(t) /\ Free # {}) ~> (t \in running \cup merged \cup abandoned)
=============================================================================
