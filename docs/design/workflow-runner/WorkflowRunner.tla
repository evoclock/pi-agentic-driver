----------------------------- MODULE WorkflowRunner -----------------------------
EXTENDS Naturals
CONSTANTS JournalGuard, DispatchGuard, EpochStampGuard, WriterStampGuard,
          ReadbackGuard, TrustGuard, DispatchIdGuard, AckResumeGuard,
          AckReconcileGuard, CancelPhaseGuard, CancelEpochGuard,
          WriterFenceGuard, TransferEpochGuard
ASSUME /\ JournalGuard \in BOOLEAN /\ DispatchGuard \in BOOLEAN
       /\ EpochStampGuard \in BOOLEAN /\ WriterStampGuard \in BOOLEAN
       /\ ReadbackGuard \in BOOLEAN /\ TrustGuard \in BOOLEAN
       /\ DispatchIdGuard \in BOOLEAN /\ AckResumeGuard \in BOOLEAN
       /\ AckReconcileGuard \in BOOLEAN /\ CancelPhaseGuard \in BOOLEAN
       /\ CancelEpochGuard \in BOOLEAN
       /\ WriterFenceGuard \in BOOLEAN /\ TransferEpochGuard \in BOOLEAN

\* Two steps, two tries per step, at most one crash, hold and transfer.
\* Effect, host readback and independent verification are abstract observations.
VARIABLE s
Init == s = [phase |-> "ready", step |-> 1, attempts |-> [i \in 1..2 |-> 0],
  epoch |-> 0, writer |-> 1, intent |-> FALSE, journaled |-> FALSE,
  dispatched |-> FALSE, ack |-> FALSE, reconciled |-> FALSE,
  dispatchId |-> 0, dispatchEpoch |-> 0, dispatchWriter |-> 1,
  dispatchStep |-> 1, outstanding |-> 0, result |-> "none",
  resultEpoch |-> 0, resultWriter |-> 1, resultDispatch |-> 0,
  resultStep |-> 1, trusted |-> FALSE, wake |-> FALSE,
  verifiedWake |-> FALSE, held |-> FALSE, stopped |-> FALSE,
  stopStep |-> 1, advanced |-> FALSE, lastEpoch |-> 0,
  lastWriter |-> 1, lastDispatch |-> 0, lastValid |-> FALSE,
  lastWake |-> FALSE, lastHeld |-> FALSE, lastTrusted |-> FALSE,
  resumedWaiting |-> FALSE, resumeHadAck |-> FALSE,
  ackedReadback |-> FALSE, stopEpoch |-> 0,
  crashOnce |-> FALSE, holdUsed |-> FALSE, transferUsed |-> FALSE]

RecordIntent == /\ s.phase = "ready" /\ s.attempts[s.step] < 2
  /\ s' = [s EXCEPT !.phase = "intent", !.intent = TRUE,
    !.journaled = JournalGuard, !.attempts[s.step] = @ + 1,
    !.ack = FALSE, !.reconciled = FALSE, !.resumedWaiting = FALSE]
\* An effect can happen before its reply is durably acknowledged.
Effect == /\ s.phase = "intent" /\ ~s.dispatched
  /\ (JournalGuard => s.journaled)
  /\ s' = [s EXCEPT !.phase = "waiting", !.dispatched = TRUE,
    !.dispatchId = @ + 1, !.dispatchEpoch = s.epoch,
    !.dispatchWriter = s.writer, !.dispatchStep = s.step,
    !.outstanding = @ + 1, !.advanced = FALSE]
JournalAck == /\ s.phase = "waiting" /\ s.dispatched /\ ~s.ack
  /\ s' = [s EXCEPT !.ack = TRUE]
Crash == /\ s.phase \in {"intent", "waiting", "parked"} /\ ~s.crashOnce
  /\ s' = [s EXCEPT !.phase = "crashed", !.crashOnce = TRUE,
    !.reconciled = FALSE]
\* Ack skips readback only for the same fenced effect; the unsafe switch
\* deliberately ignores ack so NoUnackedResume supplies a counterexample.
Resume == /\ s.phase = "crashed"
  /\ LET waiting == s.dispatched /\ s.dispatchEpoch = s.epoch
      /\ s.dispatchWriter = s.writer /\ (AckResumeGuard => s.ack)
     IN s' = [s EXCEPT !.phase = (IF waiting THEN "waiting" ELSE "parked"),
       !.resumedWaiting = waiting, !.resumeHadAck = s.ack]
\* Unknown readback leaves the effect unresolved. It spends no attempt.
ReadbackUnknown == /\ s.phase = "parked" /\ s.intent
  /\ ~s.reconciled /\ UNCHANGED s
ReconcileAbsent == /\ s.phase = "parked" /\ s.intent
  /\ ~s.dispatched /\ s.outstanding = 0 /\ ~s.reconciled
  /\ s' = [s EXCEPT !.phase = "ready", !.intent = FALSE,
    !.ack = FALSE, !.reconciled = TRUE, !.result = "none",
    !.trusted = FALSE, !.verifiedWake = FALSE]
ReconcilePresent == /\ s.phase \in {"parked", "waiting"} /\ s.intent
  /\ s.dispatched /\ (AckReconcileGuard => ~s.ack) /\ ~s.reconciled
  /\ s.dispatchEpoch = s.epoch /\ s.dispatchWriter = s.writer
  /\ s' = [s EXCEPT !.phase = "waiting", !.ack = TRUE,
    !.reconciled = TRUE, !.ackedReadback = s.ack]
\* After owner release or writer transfer, a *trusted terminal readback*
\* retires the old effect. Unknown cannot use this transition.
ReconcileOld == /\ s.phase \in {"parked", "waiting"} /\ s.intent
  /\ s.dispatched /\ ~s.reconciled /\ s.outstanding = 1
  /\ (s.dispatchEpoch # s.epoch \/ s.dispatchWriter # s.writer)
  /\ s' = [s EXCEPT !.phase = "ready", !.intent = FALSE,
    !.dispatched = FALSE, !.outstanding = 0, !.ack = TRUE,
    !.reconciled = TRUE, !.result = "none", !.trusted = FALSE,
    !.verifiedWake = FALSE, !.wake = FALSE]
\* Unsafe control: a false absent readback cannot excuse an old live effect.
ReadbackWrong == /\ ~ReadbackGuard /\ s.phase = "parked"
  /\ s.intent /\ s.dispatched /\ ~s.reconciled
  /\ s' = [s EXCEPT !.phase = "ready", !.intent = FALSE,
    !.dispatched = FALSE, !.reconciled = TRUE]
\* A verified result carries the dispatch's identities, never receive-time labels.
ReceiveGood == /\ s.phase \in {"waiting", "parked", "held"} /\ s.intent
  /\ (DispatchGuard => s.dispatched)
  /\ s' = [s EXCEPT !.result = "good",
    !.resultEpoch = (IF EpochStampGuard THEN s.dispatchEpoch ELSE s.epoch),
    !.resultWriter = (IF WriterStampGuard THEN s.dispatchWriter ELSE s.writer),
    !.resultDispatch = s.dispatchId, !.resultStep = s.step,
    !.trusted = TRUE, !.wake = TRUE, !.verifiedWake = TRUE]
ReceiveStale == /\ s.phase \in {"waiting", "parked", "held"} /\ s.intent
  /\ ~(s.trusted /\ s.result = "good")
  /\ s' = [s EXCEPT !.result = "good",
    !.resultEpoch = (IF s.epoch = 0 THEN 1 ELSE 0),
    !.resultWriter = s.writer, !.resultDispatch = s.dispatchId,
    !.resultStep = s.step, !.trusted = FALSE,
    !.wake = TRUE, !.verifiedWake = TRUE]
ReceiveWrongWriter == /\ s.phase \in {"waiting", "parked"} /\ s.intent
  /\ ~(s.trusted /\ s.result = "good")
  /\ s' = [s EXCEPT !.result = "good", !.resultEpoch = s.epoch,
    !.resultWriter = (IF s.writer = 1 THEN 2 ELSE 1),
    !.resultDispatch = s.dispatchId, !.resultStep = s.step,
    !.trusted = FALSE, !.wake = TRUE, !.verifiedWake = TRUE]
ReceiveUnverified == /\ s.phase \in {"waiting", "parked"} /\ s.intent
  /\ ~(s.trusted /\ s.result = "good")
  /\ s' = [s EXCEPT !.result = "good", !.resultEpoch = s.epoch,
    !.resultWriter = s.writer, !.resultDispatch = s.dispatchId,
    !.resultStep = s.step, !.trusted = FALSE,
    !.wake = TRUE]
ReceiveForgedCurrent == /\ s.phase = "held" /\ s.intent
  /\ ~(s.trusted /\ s.result = "good")
  /\ s' = [s EXCEPT !.result = "good", !.resultEpoch = s.epoch,
    !.resultWriter = s.writer, !.resultDispatch = s.dispatchId,
    !.resultStep = s.step, !.trusted = FALSE,
    !.wake = TRUE, !.verifiedWake = TRUE]
\* An otherwise plausible result from an earlier effect tests dispatch identity.
\* The trust bit represents independent artifact checks, not ID matching.
ReceiveOldDispatch == /\ s.phase \in {"waiting", "parked"} /\ s.intent
  /\ s.dispatched /\ s.dispatchId > 1
  /\ ~(s.trusted /\ s.result = "good")
  /\ s' = [s EXCEPT !.result = "good", !.resultEpoch = s.dispatchEpoch,
    !.resultWriter = s.dispatchWriter, !.resultDispatch = s.dispatchId - 1,
    !.resultStep = s.step, !.trusted = TRUE,
    !.wake = TRUE, !.verifiedWake = TRUE]
LateResult == /\ s.phase = "cancelled" /\ s.dispatched
  /\ ~(s.trusted /\ s.result = "good")
  /\ s' = [s EXCEPT !.result = "good", !.resultEpoch = s.dispatchEpoch,
    !.resultWriter = s.dispatchWriter, !.resultDispatch = s.dispatchId,
    !.trusted = FALSE]
Park == /\ s.phase = "waiting" /\ s' = [s EXCEPT !.phase = "parked"]
\* A hint is not allowed to erase an already independently verified result.
ObserveTransition == /\ s.phase = "parked" /\ s.intent /\ ~s.wake
  /\ s' = [s EXCEPT !.wake = TRUE]
Wake == /\ s.phase = "parked" /\ s.wake
  /\ s' = [s EXCEPT !.phase = (IF s.dispatched THEN "waiting" ELSE "parked"),
    !.wake = FALSE]
Hold == /\ s.phase \in {"waiting", "parked", "intent"}
  /\ ~s.holdUsed /\ s.epoch < 2
  /\ s' = [s EXCEPT !.phase = "held", !.held = TRUE,
    !.holdUsed = TRUE, !.epoch = @ + 1,
    !.reconciled = FALSE, !.advanced = FALSE]
Release == /\ s.phase = "held"
  /\ s' = [s EXCEPT !.phase = "parked", !.held = FALSE,
    !.reconciled = FALSE]
Transfer == /\ s.phase \in {"waiting", "parked"}
  /\ ~s.transferUsed /\ s.writer = 1 /\ s.epoch < 2
  /\ s' = [s EXCEPT !.writer = 2,
    !.epoch = (IF TransferEpochGuard THEN @ + 1 ELSE @),
    !.transferUsed = TRUE, !.reconciled = FALSE,
    !.advanced = FALSE]
Advance == /\ s.phase \in {"waiting", "parked", "held"}
  /\ s.result = "good" /\ s.resultStep = s.step /\ s.intent
  /\ (DispatchGuard => s.dispatched /\ s.resultDispatch # 0
      /\ s.dispatchStep = s.step)
  /\ (DispatchIdGuard => s.resultDispatch = s.dispatchId)
  /\ (TrustGuard => s.trusted /\ s.dispatchEpoch = s.epoch)
  /\ (WriterFenceGuard => s.dispatchWriter = s.writer)
  /\ (JournalGuard => s.journaled)
  /\ s' = [s EXCEPT !.advanced = TRUE,
    !.lastEpoch = s.resultEpoch, !.lastWriter = s.resultWriter,
    !.lastDispatch = s.resultDispatch, !.lastValid = s.dispatched,
    !.lastWake = s.verifiedWake, !.lastHeld = s.held,
    !.lastTrusted = s.trusted, !.outstanding = 0,
    !.step = (IF s.step = 1 THEN 2 ELSE s.step),
    !.phase = (IF s.step = 1 THEN "ready" ELSE "done"),
    !.intent = (IF s.step = 1 THEN FALSE ELSE @),
    !.dispatched = (IF s.step = 1 THEN FALSE ELSE @),
    !.journaled = (IF s.step = 1 THEN FALSE ELSE @),
    !.ack = (IF s.step = 1 THEN FALSE ELSE @),
    !.result = (IF s.step = 1 THEN "none" ELSE @),
    !.trusted = (IF s.step = 1 THEN FALSE ELSE @),
    !.wake = (IF s.step = 1 THEN FALSE ELSE @),
    !.verifiedWake = (IF s.step = 1 THEN FALSE ELSE @)]
Exhausted == /\ s.phase = "ready" /\ s.attempts[s.step] >= 2
  /\ s' = [s EXCEPT !.phase = "exhausted"]
Cancel == /\ s.phase \in {"ready", "intent", "waiting", "parked", "held", "crashed"}
  /\ s.epoch < 3
  /\ s' = [s EXCEPT !.phase = (IF CancelPhaseGuard THEN "cancelled" ELSE "parked"),
    !.epoch = (IF CancelEpochGuard THEN @ + 1 ELSE @),
    !.held = TRUE, !.stopped = TRUE, !.stopStep = s.step,
    !.stopEpoch = s.epoch, !.advanced = FALSE]
Done == /\ s.phase \in {"done", "exhausted", "cancelled"} /\ UNCHANGED s
Next == RecordIntent \/ Effect \/ JournalAck \/ Crash \/ Resume \/ ReadbackUnknown
  \/ ReconcileAbsent \/ ReconcilePresent \/ ReconcileOld \/ ReadbackWrong
  \/ ReceiveGood \/ ReceiveStale \/ ReceiveWrongWriter \/ ReceiveUnverified
  \/ ReceiveForgedCurrent \/ ReceiveOldDispatch \/ LateResult \/ Park \/ ObserveTransition \/ Wake
  \/ Hold \/ Release \/ Transfer \/ Advance \/ Exhausted \/ Cancel \/ Done
Spec == Init /\ [][Next]_s
TypeOK == /\ s.phase \in {"ready", "intent", "waiting", "parked", "crashed", "held", "done", "cancelled", "exhausted"}
  /\ s.step \in 1..2 /\ s.epoch \in 0..3 /\ s.writer \in 1..2
  /\ s.dispatchId \in 0..4 /\ s.outstanding \in 0..2
  /\ s.stopEpoch \in 0..2
  /\ \A i \in 1..2: s.attempts[i] \in 0..2
NoStaleAdvance == s.advanced => s.lastEpoch = s.epoch
NoOldWriterAdvance == s.advanced => s.lastWriter = s.writer
NoHeldAdvance == s.advanced => ~s.lastHeld
DispatchHasIntent == s.dispatched => s.journaled
NoUnverifiedWakeAdvance == s.advanced => s.lastWake
NoBlindResend == s.outstanding <= 1
NoStopAdvance == s.stopped => ~s.advanced /\ s.step = s.stopStep
NoAdvanceWithoutDispatch == s.advanced => s.lastValid /\ s.lastDispatch # 0
NoOwnDispatchAdvance == s.advanced => s.lastDispatch = s.dispatchId
NoTrustedAdvance == s.advanced => s.lastTrusted /\ s.lastEpoch = s.dispatchEpoch
  /\ s.lastWriter = s.dispatchWriter
NoUnackedResume == s.resumedWaiting => s.resumeHadAck
NoAcknowledgedReadback == ~s.ackedReadback
NoCancelTerminal == s.stopped => s.phase = "cancelled"
NoCancelEpochGap == s.stopped => s.epoch > s.stopEpoch
ResultEpochIsDispatchEpoch == s.trusted /\ s.result = "good" /\ s.dispatched => s.resultEpoch = s.dispatchEpoch
ResultWriterIsDispatchWriter == s.trusted /\ s.result = "good" /\ s.dispatched => s.resultWriter = s.dispatchWriter
\* Liveness assumes an eventually responding worker/verifier, exact readback
\* for uncertain effects, and weak fairness of every continuously enabled move.
\* Owner holds, cancel, writer transfer and adversarial forged results are excluded.
LiveNext == RecordIntent \/ Effect \/ JournalAck \/ Crash \/ Resume
  \/ ReadbackUnknown \/ ReconcileAbsent \/ ReconcilePresent \/ ReceiveGood
  \/ Park \/ ObserveTransition \/ Wake \/ Advance \/ Exhausted \/ Done
LiveSpec == Init /\ [][LiveNext]_s
  /\ WF_s(RecordIntent) /\ WF_s(Effect) /\ WF_s(JournalAck)
  /\ WF_s(Resume) /\ WF_s(ReconcileAbsent) /\ WF_s(ReconcilePresent)
  /\ WF_s(ReceiveGood) /\ WF_s(Wake) /\ WF_s(Advance)
  /\ WF_s(Exhausted)
EventuallyDoneOrExhausted == <>(s.phase \in {"done", "exhausted"})
=============================================================================
