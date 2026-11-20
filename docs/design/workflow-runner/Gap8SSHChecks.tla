------------------------- MODULE Gap8SSHChecks -------------------------
EXTENDS Naturals, TLC
CONSTANTS ImageGuard, ArmedGuard, LogGuard, DropGuard, WatchdogGuard,
          TripGuard, DestroyGuard, OriginGuard
VARIABLES phase, imageOK, initramfsOK, taxonomyOK, started, armed, headerOK,
          logOK, exitCode, guestOrigin, dropped, watchdog, destroyed, accepted
vars == <<phase, imageOK, initramfsOK, taxonomyOK, started, armed, headerOK,
          logOK, exitCode, guestOrigin, dropped, watchdog, destroyed, accepted>>
Init == /\ phase = "request" /\ imageOK = FALSE /\ initramfsOK = FALSE
        /\ taxonomyOK = FALSE /\ started = FALSE /\ armed = FALSE
        /\ headerOK = FALSE /\ logOK = FALSE /\ exitCode = 1
        /\ guestOrigin = FALSE /\ dropped = FALSE /\ watchdog = FALSE
        /\ destroyed = FALSE /\ accepted = FALSE
Pins == imageOK /\ initramfsOK /\ taxonomyOK
Preflight == /\ phase = "request" /\ phase' = "verified"
             /\ imageOK' \in BOOLEAN /\ initramfsOK' \in BOOLEAN /\ taxonomyOK' \in BOOLEAN
             /\ UNCHANGED <<started, armed, headerOK, logOK, exitCode, guestOrigin,
                             dropped, watchdog, destroyed, accepted>>
Boot == /\ phase = "verified" /\ (ImageGuard => Pins)
        /\ started' = TRUE /\ phase' = "booted"
        /\ UNCHANGED <<imageOK, initramfsOK, taxonomyOK, armed, headerOK, logOK,
                        exitCode, guestOrigin, dropped, watchdog, destroyed, accepted>>
SerialHeader == /\ phase = "booted" /\ phase' = "header"
                /\ armed' \in BOOLEAN /\ headerOK' \in BOOLEAN
                /\ UNCHANGED <<imageOK, initramfsOK, taxonomyOK, started, logOK,
                                exitCode, guestOrigin, dropped, watchdog, destroyed, accepted>>
Result == /\ phase = "header" /\ phase' = "result"
          /\ logOK' \in BOOLEAN /\ exitCode' \in {0, 1, 126} /\ guestOrigin' \in BOOLEAN
          /\ UNCHANGED <<imageOK, initramfsOK, taxonomyOK, started, armed, headerOK,
                          dropped, watchdog, destroyed, accepted>>
Disconnect == /\ phase \in {"booted", "header", "result"} /\ ~dropped
              /\ dropped' = TRUE
              /\ UNCHANGED <<phase, imageOK, initramfsOK, taxonomyOK, started, armed,
                              headerOK, logOK, exitCode, guestOrigin, watchdog, destroyed, accepted>>
Timeout == /\ phase \in {"booted", "header", "result"} /\ ~watchdog
           /\ watchdog' = TRUE
           /\ UNCHANGED <<phase, imageOK, initramfsOK, taxonomyOK, started, armed,
                           headerOK, logOK, exitCode, guestOrigin, dropped, destroyed, accepted>>
Teardown == /\ phase = "result" /\ phase' = "destroyed" /\ destroyed' \in BOOLEAN
            /\ UNCHANGED <<imageOK, initramfsOK, taxonomyOK, started, armed, headerOK,
                            logOK, exitCode, guestOrigin, dropped, watchdog, accepted>>
Accept == /\ phase = "destroyed" /\ phase' = "accepted" /\ accepted' = TRUE
          /\ (ArmedGuard => Pins /\ armed /\ headerOK)
          /\ (LogGuard => logOK) /\ (DropGuard => ~dropped)
          /\ (WatchdogGuard => ~watchdog) /\ (DestroyGuard => destroyed)
          /\ (OriginGuard => guestOrigin)
          /\ (exitCode = 0 \/ (~TripGuard /\ exitCode = 126))
          /\ UNCHANGED <<imageOK, initramfsOK, taxonomyOK, started, armed, headerOK,
                          logOK, exitCode, guestOrigin, dropped, watchdog, destroyed>>
Fail == /\ phase # "accepted" /\ phase' = "failed"
        /\ UNCHANGED <<imageOK, initramfsOK, taxonomyOK, started, armed, headerOK,
                        logOK, exitCode, guestOrigin, dropped, watchdog, destroyed, accepted>>
Settled == /\ phase \in {"accepted", "failed"} /\ UNCHANGED vars
Next == Preflight \/ Boot \/ SerialHeader \/ Result \/ Disconnect \/ Timeout \/ Teardown \/ Accept \/ Fail \/ Settled
Spec == Init /\ [][Next]_vars
PinnedBeforeBoot == started => Pins
NoGuestWithoutArmedKillswitch == accepted => Pins /\ armed /\ headerOK
LogIntegrity == accepted => logOK
DisconnectNeverPass == accepted => ~dropped
WatchdogNeverPass == accepted => ~watchdog
TripNeverPass == accepted => exitCode # 126
DestroyedBeforePass == accepted => destroyed
OnlyGuestResults == accepted => guestOrigin
NeverPass == ~accepted
=============================================================================
