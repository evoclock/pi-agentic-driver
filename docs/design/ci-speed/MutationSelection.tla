------------------------ MODULE MutationSelection ------------------------
EXTENDS Naturals
CONSTANT Option
Jobs == 1..3
Kinds == {"target", "test", "gate", "unknown", "clean"}
VARIABLES kind, selected, chosen
vars == <<kind, selected, chosen>>
Init == /\ kind = "clean" /\ selected = {} /\ chosen = FALSE
Observe(k) == /\ ~chosen /\ kind' = k /\ UNCHANGED <<selected, chosen>>
Select == /\ ~chosen /\ chosen' = TRUE
          /\ selected' = CASE Option = "all" -> Jobs
                              [] Option = "unsafe-proof" /\ kind \in {"test", "gate"} -> {1}
                              [] Option = "unsafe-unknown" /\ kind = "unknown" -> {}
                              [] Option = "unsafe-target" /\ kind = "target" -> Jobs
                              [] kind \in {"test", "gate", "unknown"} -> Jobs
                              [] kind = "target" -> {1}
                              [] OTHER -> {}
          /\ UNCHANGED kind
Next == (\E k \in Kinds: Observe(k)) \/ Select
ProofFull == (chosen /\ kind \in {"test", "gate"}) => selected = Jobs
UnknownFull == (chosen /\ kind = "unknown") => selected = Jobs
MappedExact == (chosen /\ kind = "target" /\ Option # "all") => selected = {1}
Spec == Init /\ [][Next]_vars
=============================================================================
