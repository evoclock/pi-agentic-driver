------------------------- MODULE ApprovalGrants -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Uses, MaxUses
VARIABLES reserved, settled, expired, revoked
vars == <<reserved, settled, expired, revoked>>

Status == IF revoked THEN "revoked"
          ELSE IF expired THEN "expired"
          ELSE IF Cardinality(reserved) >= MaxUses THEN "used-up"
          ELSE "active"
Init == /\ reserved = {}
        /\ settled = {}
        /\ expired = FALSE
        /\ revoked = FALSE
Reserve(u) == /\ Status = "active"
              /\ u \in Uses \ reserved
              /\ reserved' = reserved \cup {u}
              /\ UNCHANGED <<settled, expired, revoked>>
Settle(u) == /\ u \in reserved \ settled
             /\ settled' = settled \cup {u}
             /\ UNCHANGED <<reserved, expired, revoked>>
Expire == /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<reserved, settled, revoked>>
Revoke == /\ ~revoked /\ revoked' = TRUE
          /\ UNCHANGED <<reserved, settled, expired>>
Next == (\E u \in Uses : Reserve(u) \/ Settle(u)) \/ Expire \/ Revoke
Spec == Init /\ [][Next]_vars
TypeOK == /\ reserved \subseteq Uses
          /\ settled \subseteq reserved
          /\ expired \in BOOLEAN /\ revoked \in BOOLEAN
          /\ Status \in {"active", "used-up", "expired", "revoked"}
Capacity == Cardinality(reserved) <= MaxUses
=============================================================================
