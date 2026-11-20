-------------------------- MODULE PromptDelivery --------------------------
EXTENDS Naturals
CONSTANT Unsafe
VARIABLES state, observed, sent, proof, waiting
vars == <<state, observed, sent, proof, waiting>>
States == {"queued", "delivered", "answered", "failed", "unknown", "unattributed", "held"}
Init == state = "queued" /\ observed = "queued" /\ sent = FALSE /\ proof = FALSE /\ waiting = FALSE
Busy == state = "queued" /\ ~sent /\ waiting' = TRUE /\ UNCHANGED <<state, observed, sent, proof>>
Handoff == state = "queued" /\ sent' = TRUE /\ state' = "delivered" /\ observed' = "delivered" /\ waiting' = FALSE /\ UNCHANGED proof
Reject == state = "queued" /\ state' = "failed" /\ observed' = "failed" /\ UNCHANGED <<sent, proof, waiting>>
Uncertain == state = "queued" /\ sent' = TRUE /\ state' = "unknown" /\ observed' = "unknown" /\ UNCHANGED <<proof, waiting>>
NoSnapshot == state \in {"queued", "delivered"} /\ state' = "unattributed" /\ observed' = "unattributed" /\ UNCHANGED <<sent, proof, waiting>>
Report == state \in {"queued", "delivered"} /\ sent /\ proof' = TRUE /\ state' = "answered" /\ observed' = "answered" /\ UNCHANGED <<sent, waiting>>
LoseAttribution == state \in {"queued", "delivered", "unknown", "unattributed"}
  /\ state' = "held" /\ observed' = "held" /\ UNCHANGED <<sent, proof, waiting>>
Read == observed' = (IF Unsafe /\ state = "held" THEN "unknown" ELSE state)
  /\ UNCHANGED <<state, sent, proof, waiting>>
Next == Busy \/ Handoff \/ Reject \/ Uncertain \/ NoSnapshot \/ Report \/ LoseAttribution \/ Read
Spec == Init /\ [][Next]_vars
TypeOK == state \in States /\ observed \in States /\ sent \in BOOLEAN /\ proof \in BOOLEAN /\ waiting \in BOOLEAN
HeldRoundTrips == state = "held" => observed = "held"
NoUnprovenAnswer == state = "answered" => proof
NoReplay == state \in {"answered", "failed", "held"} => ~ENABLED Handoff
=============================================================================
