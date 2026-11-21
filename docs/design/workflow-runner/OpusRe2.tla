----------------------------- MODULE OpusRe2 -----------------------------
EXTENDS WorkflowRunner
\* Ports of the second Opus review's probe/ and fixtry/ checks onto the
\* committed FIX4 state rather than retaining an old copied model.
AdvanceOnlyTrusted == s.advanced => s.lastTrusted
PortResultEpochIsDispatchEpoch == s.advanced => s.lastEpoch = s.dispatchEpoch
PortResultWriterIsDispatchWriter == s.advanced => s.lastWriter = s.dispatchWriter

ProbeFair == /\ WF_s(RecordIntent) /\ WF_s(Effect) /\ WF_s(JournalAck)
  /\ WF_s(Resume) /\ WF_s(ReconcileAbsent) /\ WF_s(ReconcilePresent)
  /\ WF_s(ReceiveGood) /\ WF_s(Wake) /\ WF_s(Advance)
  /\ WF_s(Exhausted)
L3 == Init /\ [][LiveNext \/ ReceiveStale]_s /\ ProbeFair
L4 == Init /\ [][LiveNext \/ Hold \/ Release \/ ReconcileOld]_s
  /\ ProbeFair /\ WF_s(Release) /\ WF_s(ReconcileOld)
L5 == Init /\ [][LiveNext \/ Transfer \/ ReconcileOld]_s
  /\ ProbeFair /\ WF_s(ReconcileOld)
L6 == Init /\ [][LiveNext \/ ReceiveUnverified]_s /\ ProbeFair
=============================================================================
