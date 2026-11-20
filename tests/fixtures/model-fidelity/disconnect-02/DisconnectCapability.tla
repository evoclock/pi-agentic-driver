---------------- MODULE DisconnectCapability ----------------
EXTENDS Naturals
CONSTANTS Guarded, FictionalCleanup
VARIABLES phase, connected, capability, inFlight, generation, token,
          detected, revoked, staleEffect, disconnectedWrite, completed
vars == <<phase, connected, capability, inFlight, generation, token,
          detected, revoked, staleEffect, disconnectedWrite, completed>>
Init == /\ phase = "initial" /\ connected = TRUE /\ capability = FALSE
        /\ inFlight = FALSE /\ generation = 1 /\ token = 0
        /\ detected = FALSE /\ revoked = FALSE /\ staleEffect = FALSE
        /\ disconnectedWrite = FALSE /\ completed = FALSE
PublishCapability == /\ phase = "initial" /\ phase' = "cleared"
                     /\ capability' = TRUE /\ inFlight' = TRUE /\ token' = generation
                     /\ UNCHANGED <<connected, generation, detected, revoked, staleEffect, disconnectedWrite, completed>>
Disconnect == /\ phase = "cleared" /\ phase' = "disconnected" /\ connected' = FALSE
              /\ capability' = IF FictionalCleanup THEN FALSE ELSE capability
              /\ disconnectedWrite' = FictionalCleanup
              /\ UNCHANGED <<inFlight, generation, token, detected, revoked, staleEffect, completed>>
DetectFault == /\ ~connected /\ ~detected /\ detected' = TRUE
               /\ UNCHANGED <<phase, connected, capability, inFlight, generation, token, revoked, staleEffect, disconnectedWrite, completed>>
RevokeCapability == /\ detected /\ ~revoked /\ revoked' = TRUE /\ capability' = FALSE
                    /\ UNCHANGED <<phase, connected, inFlight, generation, token, detected, staleEffect, disconnectedWrite, completed>>
ReplaceResource == /\ phase = "disconnected" /\ phase' = "replaced" /\ generation' = 2
                   /\ UNCHANGED <<connected, capability, inFlight, token, detected, revoked, staleEffect, disconnectedWrite, completed>>
ApplyEffect == /\ phase \in {"disconnected", "replaced"} /\ inFlight
               /\ (~Guarded \/ token = generation)
               /\ phase' = "finished" /\ completed' = TRUE /\ staleEffect' = (token # generation)
               /\ UNCHANGED <<connected, capability, inFlight, generation, token, detected, revoked, disconnectedWrite>>
RejectEffect == /\ phase = "replaced" /\ Guarded /\ token # generation
                /\ phase' = "rejected"
                /\ UNCHANGED <<connected, capability, inFlight, generation, token, detected, revoked, staleEffect, disconnectedWrite, completed>>
Done == phase \in {"finished", "rejected"} /\ UNCHANGED vars
Next == PublishCapability \/ Disconnect \/ DetectFault \/ RevokeCapability \/ ReplaceResource \/ ApplyEffect \/ RejectEffect \/ Done
Spec == Init /\ [][Next]_vars
NoStaleEffect == ~staleEffect
NoDisconnectedWrite == ~disconnectedWrite
NoPostDisconnectCompletion == ~completed
NoRevocation == ~revoked
===============================================================
