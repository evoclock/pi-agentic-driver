---- MODULE WorkerReuse ----
EXTENDS Naturals, Sequences, TLC
CONSTANT Strategy
VARIABLES phase, current, namespace, runnable, results, complete
vars == <<phase,current,namespace,runnable,results,complete>>
Init == /\ phase = "idle" /\ current = 1 /\ namespace = 0
        /\ runnable = FALSE /\ results = <<>> /\ complete = FALSE
Dispatch == /\ phase = "idle" /\ Strategy # "hold"
            /\ namespace' = IF Strategy = "no-reset" /\ current = 2 THEN 1 ELSE current
            /\ phase' = "running" /\ runnable' = TRUE
            /\ UNCHANGED <<current,results,complete>>
Finish == /\ phase = "running" /\ phase' = "release"
          /\ runnable' = (Strategy = "active")
          /\ UNCHANGED <<current,namespace,results,complete>>
Publish == /\ phase = "release" /\ (~runnable \/ Strategy = "active")
           /\ results' = Append(results,[target |-> current,
                  identity |-> IF Strategy = "misattribute" THEN 3-current ELSE current,
                  quiescent |-> ~runnable])
           /\ complete' = (current = 2 \/ Strategy = "partial")
           /\ phase' = IF complete' THEN "done" ELSE "idle"
           /\ current' = IF complete' THEN current ELSE current+1
           /\ UNCHANGED <<namespace,runnable>>
Abort == /\ phase \in {"running","release"} /\ phase' = "aborted"
         /\ runnable' = FALSE /\ UNCHANGED <<current,namespace,results,complete>>
Next == Dispatch \/ Finish \/ Publish \/ Abort
Spec == Init /\ [][Next]_vars
FreshNamespace == phase \in {"running","release"} => namespace = current
Attribution == \A i \in 1..Len(results): results[i].identity = results[i].target
QuiescentPublication == \A i \in 1..Len(results): results[i].quiescent
CompleteProof == complete => Len(results) = 2
====
