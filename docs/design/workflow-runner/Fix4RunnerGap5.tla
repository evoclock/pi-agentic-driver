------------------------- MODULE Fix4RunnerGap5 -------------------------
EXTENDS Naturals
\* Two polls abstract the ordinary 1,024-event cap. Only the already issued
\* final intent may finish beyond it; no fresh effects are admitted.
CONSTANTS TerminalGuard, ControlGuard
VARIABLE s
vars == <<s>>
Init == s = [history |-> 0, phase |-> "parked", woke |-> FALSE,
  wakeConsumed |-> FALSE, pending |-> FALSE, refused |-> FALSE]
Poll == /\ s.history < 2 /\ s.phase = "parked"
  /\ s' = [s EXCEPT !.history = @ + 1]
Wake == /\ s.phase = "parked" /\ ~s.woke
  /\ s' = IF TerminalGuard \/ s.history < 2
    THEN [s EXCEPT !.history = @ + 1, !.woke = TRUE]
    ELSE [s EXCEPT !.refused = TRUE]
WakeTick == /\ s.phase = "parked" /\ s.woke /\ ~s.wakeConsumed
  /\ s' = IF TerminalGuard \/ s.history < 2
    THEN [s EXCEPT !.history = @ + 1, !.wakeConsumed = TRUE,
      !.phase = "awaiting"] ELSE [s EXCEPT !.refused = TRUE]
Receipt == /\ s.phase \in {"parked", "awaiting"} /\ ~s.pending
  /\ s' = IF TerminalGuard \/ s.history < 2
    THEN [s EXCEPT !.history = @ + 1, !.pending = TRUE,
      !.phase = "awaiting"] ELSE [s EXCEPT !.refused = TRUE]
Finish == /\ s.phase = "awaiting" /\ s.pending
  /\ s' = IF TerminalGuard \/ s.history < 2
    THEN [s EXCEPT !.history = @ + 1, !.phase = "done"]
    ELSE [s EXCEPT !.refused = TRUE]
OwnerStop == /\ s.phase \notin {"done", "cancelled"}
  /\ s' = [s EXCEPT !.history = @ + 1, !.phase = "cancelled"]
RepeatControl == /\ s.phase \in {"done", "cancelled"}
  /\ s' = IF ControlGuard THEN s ELSE [s EXCEPT !.history = @ + 1]
Next == Poll \/ Wake \/ WakeTick \/ Receipt \/ Finish \/ OwnerStop
  \/ RepeatControl \/ UNCHANGED s
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.history \in Nat
  /\ s.phase \in {"parked", "awaiting", "done", "cancelled"}
CompletionAvailable == ~s.refused
HistoryBound == s.history <= 7
=============================================================================
