------------------------- MODULE FleetDelivery -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT UnsafeReady, UnsafeReceipt, UnsafeReplay, UnsafeTurn, UnsafeBusy, UnsafeSnapshot
VARIABLES phase, ready, received, sent, age, attempts, busy, mode, turn, target,
          expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock
vars == <<phase, ready, received, sent, age, attempts, busy, mode, turn, target,
          expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock>>
Init == /\ phase = "waiting" /\ ready = FALSE /\ received = FALSE /\ sent = FALSE
        /\ age = 0 /\ attempts = 0 /\ busy \in BOOLEAN
        /\ mode \in {"default", "steer", "interrupt", "hold", "owner"}
        /\ disk = {} /\ written = {} /\ snapshots = [w \in {1, 2} |-> {}]
        /\ writerPhase = [w \in {1, 2} |-> "waiting"] /\ lock = 0
        /\ turn = 0 /\ target = 0 /\ expiredEffect = FALSE /\ staleEffect = FALSE /\ busyEffect = FALSE
Ready == /\ phase = "waiting" /\ ready' = TRUE
         /\ UNCHANGED <<phase, received, sent, age, attempts, busy, mode, turn, target, expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock>>
Interrupt == /\ phase = "waiting" /\ mode = "interrupt" /\ busy /\ busy' = FALSE
             /\ UNCHANGED <<phase, ready, received, sent, age, attempts, mode, turn, target, expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock>>
Submit == /\ phase = "waiting" /\ mode \notin {"hold", "owner"} /\ age < 2
          /\ (ready \/ UnsafeReady) /\ (~busy \/ mode = "steer" \/ UnsafeBusy)
          /\ phase' = "handedOff" /\ target' = turn /\ busyEffect' = (busy /\ mode = "default")
          /\ UNCHANGED <<ready, received, sent, age, attempts, busy, mode, turn, expiredEffect, staleEffect, disk, snapshots, written, writerPhase, lock>>
Consume == /\ phase \in {"handedOff", "expired"} /\ attempts < 2
           /\ ((attempts = 0 /\ age < 2) \/ UnsafeReplay)
           /\ (target = turn \/ UnsafeTurn)
           /\ received' = TRUE /\ attempts' = attempts + 1
           /\ expiredEffect' = (expiredEffect \/ age = 2)
           /\ staleEffect' = (staleEffect \/ target # turn)
           /\ UNCHANGED <<phase, ready, sent, age, busy, mode, turn, target, busyEffect, disk, snapshots, written, writerPhase, lock>>
Confirm == /\ phase = "handedOff" /\ (received \/ UnsafeReceipt) /\ sent' = TRUE /\ phase' = "confirmed"
           /\ UNCHANGED <<ready, received, age, attempts, busy, mode, turn, target, expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock>>
Tick == /\ age < 2 /\ age' = age + 1
        /\ UNCHANGED <<phase, ready, received, sent, attempts, busy, mode, turn, target, expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock>>
Expire == /\ age = 2 /\ phase \in {"waiting", "handedOff"} /\ phase' = "expired"
          /\ UNCHANGED <<ready, received, sent, age, attempts, busy, mode, turn, target, expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock>>
ReplaceTurn == /\ turn = 0 /\ turn' = 1
               /\ UNCHANGED <<phase, ready, received, sent, age, attempts, busy, mode, target, expiredEffect, staleEffect, busyEffect, disk, snapshots, written, writerPhase, lock>>

(* Two processes start with the same snapshot. The writer lock covers re-read,
   single-key merge and atomic rename. UnsafeSnapshot restores the stale write. *)
Acquire(w) == /\ lock = 0 /\ writerPhase[w] = "waiting"
              /\ lock' = w /\ writerPhase' = [writerPhase EXCEPT ![w] = "locked"]
              /\ snapshots' = [snapshots EXCEPT ![w] = IF UnsafeSnapshot THEN @ ELSE disk]
              /\ UNCHANGED <<phase, ready, received, sent, age, attempts, busy, mode, turn, target, expiredEffect, staleEffect, busyEffect, disk, written>>
Write(w) == /\ lock = w /\ writerPhase[w] = "locked"
            /\ disk' = snapshots[w] \cup {w} /\ written' = written \cup {w}
            /\ writerPhase' = [writerPhase EXCEPT ![w] = "done"] /\ lock' = 0
            /\ UNCHANGED <<phase, ready, received, sent, age, attempts, busy, mode, turn, target, expiredEffect, staleEffect, busyEffect, snapshots>>
ConcurrentEntriesRetained == written \subseteq disk
Hold == UNCHANGED vars
Next == Ready \/ Interrupt \/ Submit \/ Consume \/ Confirm \/ Tick \/ Expire \/ ReplaceTurn \/ (\E w \in {1, 2}: Acquire(w) \/ Write(w)) \/ Hold
ReadinessBeforeHandoff == phase \in {"handedOff", "confirmed"} => ready
ReceiptBeforeSuccess == sent => received
NeverReplay == attempts <= 1 /\ ~expiredEffect
ExactTurn == ~staleEffect
ExplicitBusyChoice == ~busyEffect
Spec == Init /\ [][Next]_vars
=============================================================================
