-------------------------- MODULE NudgeLedger --------------------------
EXTENDS Naturals, TLC

\* One ledger entry. Delivery is absent until a transport state is known.
VARIABLES phase, action, result, delivery, terminalCount
vars == <<phase, action, result, delivery, terminalCount>>
DeliveryStates == {"delivered", "rejected-before-delivery", "unknown"}

Init == /\ phase = "idle"
        /\ action = "none"
        /\ result = "none"
        /\ delivery = "none"
        /\ terminalCount = 0

Request(a) == /\ phase = "idle"
              /\ a \in {"nudge", "replacement"}
              /\ phase' = "requested"
              /\ action' = a
              /\ result' = "requested"
              /\ delivery' = "none"
              /\ UNCHANGED terminalCount

NudgeTerminal(r, d) ==
  /\ phase = "requested" /\ action = "nudge"
  /\ \/ r = "delivered" /\ d = "delivered"
     \/ r = "rejected" /\ d = "rejected-before-delivery"
     \/ r = "unknown" /\ d = "unknown"
     \/ r \in {"failed", "parked"} /\ d \in DeliveryStates \cup {"none"}
  /\ phase' = "terminal" /\ result' = r /\ delivery' = d
  /\ terminalCount' = terminalCount + 1
  /\ UNCHANGED action

ReplacementTerminal(r) ==
  /\ phase = "requested" /\ action = "replacement"
  /\ r \in {"spawned", "failed", "parked"}
  /\ phase' = "terminal" /\ result' = r /\ delivery' = "none"
  /\ terminalCount' = terminalCount + 1
  /\ UNCHANGED action

Next == \/ \E a \in {"nudge", "replacement"} : Request(a)
        \/ \E r \in {"delivered", "rejected", "unknown", "failed", "parked"} :
             \E d \in DeliveryStates \cup {"none"} : NudgeTerminal(r, d)
        \/ \E r \in {"spawned", "failed", "parked"} : ReplacementTerminal(r)

Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"idle", "requested", "terminal"}
          /\ action \in {"none", "nudge", "replacement"}
          /\ result \in {"none", "requested", "delivered", "rejected", "unknown", "spawned", "failed", "parked"}
          /\ delivery \in DeliveryStates \cup {"none"}
          /\ terminalCount \in Nat
OneTerminal == terminalCount <= 1
ResultDelivery ==
  /\ (phase = "idle" => result = "none" /\ delivery = "none")
  /\ (phase = "requested" => result = "requested" /\ delivery = "none")
  /\ (phase = "terminal" => terminalCount = 1)
  /\ (action = "replacement" => delivery = "none" /\ result \in {"requested", "spawned", "failed", "parked"})
  /\ (action = "nudge" =>
        \/ result = "requested" /\ delivery = "none"
        \/ result = "delivered" /\ delivery = "delivered"
        \/ result = "rejected" /\ delivery = "rejected-before-delivery"
        \/ result = "unknown" /\ delivery = "unknown"
        \/ result \in {"failed", "parked"} /\ delivery \in DeliveryStates \cup {"none"})
==========================================================================
