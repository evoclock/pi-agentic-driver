---------------------- MODULE Gap8LinuxUnattended ----------------------
\* B refinement: attended and unattended runs both need a valid standing guest-check
\* grant admits a run. Neither branch can replace the pinned guest killswitch.
\* Two runs expose revocation between runs; no grant is inferred from prose.
EXTENDS Naturals
CONSTANTS Mode, PreauthGuard, RevocationGuard, KillswitchGuard, TripGuard,
          NativeGuard, CheckoutGuard, ResultGuard, CancelGuard, ArgvGuard,
          UnavailableGuard
VARIABLES mode, phase, scoped, expired, revoked, switched, tui, admitted,
          armed, taxonomy, runs, executed, validAtRun, revokedAtRun,
          nativeAtRun, armedAtRun, taxonomyAtRun, staged, argv,
          guestRun, resultRun, source, cancelled, tripped, tripRun,
          unavailable, passed, exitCode
vars == <<mode, phase, scoped, expired, revoked, switched, tui, admitted,
          armed, taxonomy, runs, executed, validAtRun, revokedAtRun,
          nativeAtRun, armedAtRun, taxonomyAtRun, staged, argv,
          guestRun, resultRun, source, cancelled, tripped, tripRun,
          unavailable, passed, exitCode>>
Init == /\ mode \in IF Mode = "both" THEN {"attended", "unattended"} ELSE {Mode}
        /\ phase = "requested" /\ scoped \in BOOLEAN /\ expired \in BOOLEAN
        /\ revoked = FALSE /\ switched \in BOOLEAN /\ tui \in BOOLEAN
        /\ admitted = FALSE /\ armed \in BOOLEAN /\ taxonomy \in {0, 1}
        /\ runs = 0 /\ executed = FALSE /\ validAtRun = FALSE
        /\ revokedAtRun = FALSE /\ nativeAtRun = FALSE
        /\ armedAtRun = FALSE /\ taxonomyAtRun = 0
        /\ staged = 0 /\ argv = 0 /\ guestRun = 0 /\ resultRun = 0
        /\ source = "none" /\ cancelled = FALSE /\ tripped = FALSE
        /\ tripRun = 0 /\ unavailable = FALSE /\ passed = FALSE
        /\ exitCode = 255
ValidPreauth == scoped /\ ~expired /\ ~revoked
Authorize == /\ phase = "requested" /\ mode = "attended"
             /\ (~PreauthGuard \/ (scoped /\ ~expired))
             /\ (~RevocationGuard \/ ~revoked)
             /\ switched /\ tui /\ admitted' = TRUE /\ phase' = "authorized"
             /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
                  armed, taxonomy, runs, executed, validAtRun, revokedAtRun,
                  nativeAtRun, armedAtRun, taxonomyAtRun, staged, argv,
                  guestRun, resultRun, source, cancelled, tripped, tripRun,
                  unavailable, passed, exitCode>>
Stage == /\ (~PreauthGuard \/ (scoped /\ ~expired))
         /\ (~RevocationGuard \/ ~revoked)
         /\ validAtRun' = ValidPreauth
         /\ (phase = "authorized" \/ (phase = "requested" /\ mode = "unattended"))
         /\ phase' = "staged"
         /\ staged' \in IF CheckoutGuard THEN {1} ELSE {1, 2}
         /\ argv' \in IF ArgvGuard THEN {1} ELSE {1, 2}
         /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
              admitted, armed, taxonomy, runs, executed,
              revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun,
              guestRun, resultRun, source, cancelled, tripped, tripRun,
              unavailable, passed, exitCode>>
Run == /\ runs < 2 /\ ~executed /\ ~tripped
       /\ (phase = "staged" \/ (~NativeGuard /\ phase = "requested"))
       /\ (mode = "unattended" \/ ~NativeGuard \/ (switched /\ tui /\ admitted))
       /\ (~PreauthGuard \/ (scoped /\ ~expired))
       /\ (~RevocationGuard \/ ~revoked)
       /\ (~KillswitchGuard \/ (armed /\ taxonomy = 1))
       /\ phase' = "running" /\ runs' = runs + 1 /\ executed' = TRUE
       /\ guestRun' = runs + 1 /\ validAtRun' = ValidPreauth
       /\ revokedAtRun' = revoked
       /\ nativeAtRun' = (switched /\ tui /\ admitted)
       /\ armedAtRun' = armed /\ taxonomyAtRun' = taxonomy
       /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
            admitted, armed, taxonomy, staged, argv, resultRun, source,
            cancelled, tripped, tripRun, unavailable, passed, exitCode>>
Result == /\ executed /\ (phase = "running" \/ (~TripGuard /\ phase = "killed")
                         \/ (~CancelGuard /\ phase = "cancelled"))
          /\ (~CancelGuard \/ ~cancelled) /\ (~TripGuard \/ ~tripped)
          /\ phase' = "finished" /\ passed' \in BOOLEAN
          /\ exitCode' = IF passed' THEN 0 ELSE 1
          /\ source' \in IF ResultGuard THEN {"guest"} ELSE {"guest", "host-proof"}
          /\ resultRun' \in IF ResultGuard THEN {guestRun} ELSE {0, guestRun}
          /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
               admitted, armed, taxonomy, runs, executed, validAtRun,
               revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun,
               staged, argv, guestRun, cancelled, tripped, tripRun, unavailable>>
Trip == /\ phase = "running" /\ phase' = "killed"
        /\ tripped' = TRUE /\ tripRun' = runs /\ exitCode' = 126
        /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
             admitted, armed, taxonomy, runs, executed, validAtRun,
             revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun,
             staged, argv, guestRun, resultRun, source, cancelled,
             unavailable, passed>>
Cancel == /\ phase \in {"requested", "authorized", "staged", "running"}
          /\ phase' = "cancelled" /\ cancelled' = TRUE
          /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
               admitted, armed, taxonomy, runs, executed, validAtRun,
               revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun,
               staged, argv, guestRun, resultRun, source, tripped,
               tripRun, unavailable, passed, exitCode>>
Revoke == /\ phase = "finished" /\ runs = 1 /\ ~revoked
          /\ revoked' = TRUE
          /\ UNCHANGED <<mode, phase, scoped, expired, switched, tui,
               admitted, armed, taxonomy, runs, executed, validAtRun,
               revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun,
               staged, argv, guestRun, resultRun, source, cancelled,
               tripped, tripRun, unavailable, passed, exitCode>>
Expire == /\ phase = "finished" /\ runs = 1 /\ ~expired
          /\ expired' = TRUE
          /\ UNCHANGED <<mode, phase, scoped, revoked, switched, tui,
               admitted, armed, taxonomy, runs, executed, validAtRun,
               revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun,
               staged, argv, guestRun, resultRun, source, cancelled,
               tripped, tripRun, unavailable, passed, exitCode>>
NextRequest == /\ phase = "finished" /\ runs < 2 /\ ~tripped
               /\ phase' = "requested" /\ admitted' = FALSE
               /\ executed' = FALSE /\ staged' = 0 /\ argv' = 0
               /\ cancelled' = FALSE /\ unavailable' = FALSE
               /\ passed' = FALSE /\ exitCode' = 255
               /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
                    armed, taxonomy, runs, validAtRun, revokedAtRun,
                    nativeAtRun, armedAtRun, taxonomyAtRun, guestRun,
                    resultRun, source, tripped, tripRun>>
Park == /\ phase \in {"requested", "authorized", "staged"}
        /\ phase' = "parked" /\ unavailable' = TRUE
        /\ passed' = ~UnavailableGuard
        /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui,
             admitted, armed, taxonomy, runs, executed, validAtRun,
             revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun,
             staged, argv, guestRun, resultRun, source, cancelled,
             tripped, tripRun, exitCode>>
Next == Authorize \/ Stage \/ Run \/ Result \/ Trip \/ Cancel \/ Revoke
        \/ Expire \/ NextRequest \/ Park \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"attended", "unattended"}
          /\ phase \in {"requested", "authorized", "staged", "running", "finished", "killed", "cancelled", "parked"}
          /\ {scoped, expired, revoked, switched, tui, admitted, armed,
                executed, validAtRun, revokedAtRun, nativeAtRun, armedAtRun,
                cancelled, tripped, unavailable, passed} \subseteq BOOLEAN
          /\ taxonomy \in 0..1 /\ taxonomyAtRun \in 0..1 /\ runs \in 0..2
          /\ staged \in 0..2 /\ argv \in 0..2 /\ guestRun \in 0..2
          /\ resultRun \in 0..2 /\ tripRun \in 0..2
          /\ source \in {"none", "guest", "host-proof"}
          /\ exitCode \in {255, 0, 1, 126}
UnavailableNeverPass == unavailable => ~passed
RevokedPreauthBlocksNextRun == executed => ~revokedAtRun
UnattendedNeedsValidPreauth == executed => validAtRun
ProbeNeedsValidGrant == phase = "staged" => validAtRun
NoGuestWithoutArmedKillswitch == executed => armedAtRun /\ taxonomyAtRun = 1
KillswitchTripNeverPass == tripped => ~passed /\ exitCode = 126
NativeBoundary == executed => IF mode = "attended" THEN nativeAtRun ELSE validAtRun
CheckoutIntegrity == executed => staged = 1
ArgvFromFrozenChecks == executed => argv = 1
ResultOnlyFromGuest == passed => executed /\ source = "guest" /\ resultRun = guestRun /\ guestRun # 0
CancellationNeverPass == cancelled => ~passed
NoSilentTripRetry == tripped => runs = tripRun
\* Expected-failure probes witness actual autonomous pass and revoked-next-run park.
NeverAutonomousPass == ~(passed /\ mode = "unattended" /\ (~switched \/ ~tui))
NeverRevokedPark == ~(phase = "parked" /\ mode = "unattended" /\ revoked /\ runs = 1)
\* Negative-only malformed phase and retry-after-trip faults.
UnsafeTypeAction == /\ phase = "requested" /\ phase' = "corrupt-phase" /\ UNCHANGED <<mode, scoped, expired, revoked, switched, tui, admitted, armed, taxonomy, runs, executed, validAtRun, revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun, staged, argv, guestRun, resultRun, source, cancelled, tripped, tripRun, unavailable, passed, exitCode>>
UnsafeTripRetry == /\ tripped /\ runs < 2
                   /\ runs' = runs + 1 /\ UNCHANGED <<mode, phase, scoped, expired, revoked, switched, tui, admitted, armed, taxonomy, executed, validAtRun, revokedAtRun, nativeAtRun, armedAtRun, taxonomyAtRun, staged, argv, guestRun, resultRun, source, cancelled, tripped, tripRun, unavailable, passed, exitCode>>
UnsafeTypeSpec == Init /\ [][Next \/ UnsafeTypeAction]_vars
UnsafeRetrySpec == Init /\ [][Next \/ UnsafeTripRetry]_vars
=============================================================================
