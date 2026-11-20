-------------------------- MODULE ReviewPreflight --------------------------
EXTENDS Naturals
CONSTANTS RequiredGuard, NativeGuard, TokenGuard
VARIABLES phase, route, checkerPresent, tokensPreserved, passed
vars == <<phase, route, checkerPresent, tokensPreserved, passed>>
Init == /\ phase = "choose" /\ route = "none" /\ passed = FALSE
        /\ checkerPresent \in BOOLEAN /\ tokensPreserved \in BOOLEAN
Choose == /\ phase = "choose" /\ phase' = "verify"
          /\ route' \in {"native", "copied", "hold"}
          /\ UNCHANGED <<checkerPresent, tokensPreserved, passed>>
Verify == /\ phase = "verify" /\ phase' = "done"
          /\ passed' = (route # "hold"
               /\ (checkerPresent \/ ~RequiredGuard)
               /\ (route = "native" \/ ~NativeGuard)
               /\ (tokensPreserved \/ ~TokenGuard))
          /\ UNCHANGED <<route, checkerPresent, tokensPreserved>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == Choose \/ Verify \/ Done
Spec == Init /\ [][Next]_vars
RequiredChecker == passed => checkerPresent
NativeGateOnly == passed => route = "native"
FrozenTokensRemain == passed => tokensPreserved
=============================================================================
