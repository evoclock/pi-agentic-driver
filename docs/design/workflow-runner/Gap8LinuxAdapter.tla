------------------------- MODULE Gap8LinuxAdapter -------------------------
\* Refinement of Gap8LinuxDecision for owner-selected B, not runtime proof.
\* Native facts are observations, never values the adapter may manufacture.
\* AdapterAvailable abstracts a reviewed checks API/runtime that is not
\* provided by the current transient proof tool. No install is modeled.
EXTENDS Naturals
CONSTANTS Choice, AdapterAvailable, NativeGuard, CheckoutGuard,
          ResultGuard, CancelGuard, ArgvGuard
VARIABLES phase, switched, tui, confirmed, payloadUnchanged,
          receiptDigest, stagedDigest, pinnedArgv, runArgv,
          executed, nativeAtRun, guestRun, resultRun, source,
          cancelled, unavailable, passed
vars == <<phase, switched, tui, confirmed, payloadUnchanged,
          receiptDigest, stagedDigest, pinnedArgv, runArgv,
          executed, nativeAtRun, guestRun, resultRun, source,
          cancelled, unavailable, passed>>
Init == /\ phase = "requested" /\ switched \in BOOLEAN /\ tui \in BOOLEAN
        /\ confirmed = FALSE /\ payloadUnchanged = TRUE
        /\ receiptDigest = 1 /\ stagedDigest = 0
        /\ pinnedArgv = 1 /\ runArgv = 0
        /\ executed = FALSE /\ nativeAtRun = FALSE
        /\ guestRun = 0 /\ resultRun = 0 /\ source = "none"
        /\ cancelled = FALSE /\ unavailable = FALSE /\ passed = FALSE
Confirm == /\ phase = "requested" /\ Choice = "B" /\ AdapterAvailable
           /\ switched /\ tui /\ confirmed' = TRUE /\ phase' = "confirmed"
           /\ UNCHANGED <<switched, tui, payloadUnchanged, receiptDigest,
                stagedDigest, pinnedArgv, runArgv, executed, nativeAtRun,
                guestRun, resultRun, source, cancelled, unavailable, passed>>
Stage == /\ phase = "confirmed" /\ phase' = "staged"
         /\ stagedDigest' \in IF CheckoutGuard THEN {receiptDigest} ELSE {1, 2}
         /\ runArgv' \in IF ArgvGuard THEN {pinnedArgv} ELSE {1, 2}
         /\ UNCHANGED <<switched, tui, confirmed, payloadUnchanged,
                receiptDigest, pinnedArgv, executed, nativeAtRun, guestRun,
                resultRun, source, cancelled, unavailable, passed>>
Run == /\ Choice = "B" /\ AdapterAvailable /\ ~executed
       /\ IF NativeGuard THEN phase = "staged"
                          ELSE phase \in {"requested", "staged"}
       /\ phase' = "running" /\ executed' = TRUE /\ guestRun' = 1
       /\ nativeAtRun' = (switched /\ tui /\ confirmed /\ payloadUnchanged)
       /\ UNCHANGED <<switched, tui, confirmed, payloadUnchanged,
            receiptDigest, stagedDigest, pinnedArgv, runArgv,
            resultRun, source, cancelled, unavailable, passed>>
Result == /\ phase \in {"running", "cancelled"} /\ executed
          /\ (~CancelGuard \/ ~cancelled) /\ phase' = "finished"
          /\ passed' \in BOOLEAN
          /\ source' \in IF ResultGuard THEN {"guest"} ELSE {"guest", "host-proof"}
          /\ resultRun' \in IF ResultGuard THEN {guestRun} ELSE {0, guestRun}
          /\ UNCHANGED <<switched, tui, confirmed, payloadUnchanged,
               receiptDigest, stagedDigest, pinnedArgv, runArgv,
               executed, nativeAtRun, guestRun, cancelled, unavailable>>
CancelOrTimeout == /\ phase \in {"requested", "confirmed", "staged", "running"}
                   /\ phase' = "cancelled" /\ cancelled' = TRUE
                   /\ UNCHANGED <<switched, tui, confirmed, payloadUnchanged,
                        receiptDigest, stagedDigest, pinnedArgv, runArgv,
                        executed, nativeAtRun, guestRun, resultRun, source,
                        unavailable, passed>>
Park == /\ phase \in {"requested", "confirmed", "staged"}
        /\ Choice # "Hold" /\ phase' = "parked" /\ unavailable' = TRUE
        /\ UNCHANGED <<switched, tui, confirmed, payloadUnchanged,
             receiptDigest, stagedDigest, pinnedArgv, runArgv,
             executed, nativeAtRun, guestRun, resultRun, source,
             cancelled, passed>>
Hold == /\ phase = "requested" /\ Choice = "Hold" /\ phase' = "held"
        /\ UNCHANGED <<switched, tui, confirmed, payloadUnchanged,
             receiptDigest, stagedDigest, pinnedArgv, runArgv,
             executed, nativeAtRun, guestRun, resultRun, source,
             cancelled, unavailable, passed>>
Next == Confirm \/ Stage \/ Run \/ Result \/ CancelOrTimeout \/ Park \/ Hold
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"requested", "confirmed", "staged", "running", "finished", "cancelled", "parked", "held"}
          /\ switched \in BOOLEAN /\ tui \in BOOLEAN /\ confirmed \in BOOLEAN
          /\ payloadUnchanged \in BOOLEAN /\ executed \in BOOLEAN
          /\ nativeAtRun \in BOOLEAN /\ cancelled \in BOOLEAN
          /\ unavailable \in BOOLEAN /\ passed \in BOOLEAN
          /\ receiptDigest = 1 /\ stagedDigest \in 0..2
          /\ pinnedArgv = 1 /\ runArgv \in 0..2
          /\ guestRun \in 0..1 /\ resultRun \in 0..1
          /\ source \in {"none", "guest", "host-proof"}
UnavailableNeverPass == unavailable => ~passed
NativeBoundary == executed => nativeAtRun /\ payloadUnchanged
CheckoutIntegrity == executed => stagedDigest = receiptDigest
ArgvFromFrozenChecks == executed => runArgv = pinnedArgv
ResultOnlyFromGuest == passed => executed /\ source = "guest" /\ resultRun = guestRun /\ guestRun # 0
CancellationNeverPass == cancelled => ~passed
\* Deliberately false coverage probes used only in dedicated cfgs.
NeverGuestPass == ~passed
NeverUnavailable == ~unavailable
\* Negative-only malformed phase and unavailable-to-pass promotion faults.
UnsafeTypeAction == /\ phase = "requested" /\ phase' = "corrupt-phase" /\ UNCHANGED <<switched, tui, confirmed, payloadUnchanged, receiptDigest, stagedDigest, pinnedArgv, runArgv, executed, nativeAtRun, guestRun, resultRun, source, cancelled, unavailable, passed>>
UnsafeUnavailablePass == /\ phase = "parked" /\ unavailable
                         /\ passed' = TRUE /\ UNCHANGED <<phase, switched, tui, confirmed, payloadUnchanged, receiptDigest, stagedDigest, pinnedArgv, runArgv, executed, nativeAtRun, guestRun, resultRun, source, cancelled, unavailable>>
UnsafeTypeSpec == Init /\ [][Next \/ UnsafeTypeAction]_vars
UnsafeUnavailableSpec == Init /\ [][Next \/ UnsafeUnavailablePass]_vars
=============================================================================
