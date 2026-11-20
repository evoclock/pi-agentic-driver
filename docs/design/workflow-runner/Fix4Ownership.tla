-------------------------- MODULE Fix4Ownership --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS FreshGenerationGuard, OwnerCapGuard, ReleaseControlGuard,
  TransferControlGuard, TransferGenerationGuard, EffectFenceGuard,
  ReconcileTerminalGuard
VARIABLES s, o
RR == INSTANCE Fix4RunnerRR5
vars == <<s, o>>
\* Logical ownership is independent of RR5's per-event filesystem writer.
\* Two owners, at most two ownership changes and two issued effects.
Init == /\ RR!Init
  /\ o = [owner |-> 1, generation |-> 0, intent |-> FALSE,
    dispatchOwner |-> 0, dispatchGeneration |-> 0, outstanding |-> 0,
    attempts |-> 0, changes |-> 0, unauthorized |-> FALSE,
    generationLost |-> FALSE, staleAct |-> FALSE]
ReleaseOwnership(trusted) == /\ o.owner # 0 /\ o.changes < 2
  /\ (ReleaseControlGuard => trusted)
  /\ o' = [o EXCEPT !.owner = 0, !.generation = @ + 1,
    !.changes = @ + 1, !.unauthorized = @ \/ ~trusted]
Transfer(trusted, target) == /\ o.changes < 2 /\ target # o.owner
  /\ target \in {1, 2} /\ (TransferControlGuard => trusted)
  /\ o' = [o EXCEPT !.owner = target,
    !.generation = (IF TransferGenerationGuard THEN @ + 1 ELSE @),
    !.changes = @ + 1, !.unauthorized = @ \/ ~trusted,
    !.generationLost = @ \/ ~TransferGenerationGuard]
\* An observed actor/generation is independently supplied by the host adapter.
Act(actor, generation) == /\ ~o.intent /\ o.attempts < 2
  /\ (EffectFenceGuard => o.owner # 0 /\ actor = o.owner
    /\ generation = o.generation)
  /\ o' = [o EXCEPT !.intent = TRUE, !.attempts = @ + 1,
    !.dispatchOwner = actor, !.dispatchGeneration = generation,
    !.outstanding = @ + 1,
    !.staleAct = @ \/ o.owner = 0 \/ actor # o.owner
      \/ generation # o.generation]
\* terminalBound means trusted, terminal AND task/dispatch/branch/generation bound.
\* Unknown or merely present evidence must not erase the old outstanding effect.
ReconcileOld(terminalBound) == /\ o.intent
  /\ (o.dispatchOwner # o.owner \/ o.dispatchGeneration # o.generation)
  /\ (ReconcileTerminalGuard => terminalBound)
  /\ o' = [o EXCEPT !.intent = FALSE,
    !.outstanding = (IF terminalBound THEN 0 ELSE @)]
OwnershipNext == ReleaseOwnership(TRUE) \/ ReleaseOwnership(FALSE)
  \/ (\E trusted \in BOOLEAN, target \in {1, 2}: Transfer(trusted, target))
  \/ (\E actor \in {1, 2}, generation \in 0..2: Act(actor, generation))
  \/ ReconcileOld(TRUE) \/ ReconcileOld(FALSE)
Next == (RR!Next /\ UNCHANGED o) \/ (OwnershipNext /\ UNCHANGED s)
Spec == Init /\ [][Next]_vars
TypeOK == /\ RR!TypeOK /\ o.owner \in 0..2 /\ o.generation \in 0..2
  /\ o.changes \in 0..2 /\ o.attempts \in 0..2
  /\ o.outstanding \in 0..2 /\ o.dispatchOwner \in 0..2
  /\ o.dispatchGeneration \in 0..2
OneWriterNoFork == RR!OneWriterNoFork
OwnerStopAvailable == RR!OwnerStopAvailable
ControlAuthorized == ~o.unauthorized
GenerationAdvanced == ~o.generationLost
NoStaleOwnerActs == ~o.staleAct
NoBlindRetry == o.outstanding <= 1
=============================================================================
