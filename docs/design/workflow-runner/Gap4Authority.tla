-------------------------- MODULE Gap4Authority --------------------------
EXTENDS Naturals, FiniteSets
\* One task, two effects, six immutable request bodies. The two claim IDs
\* permit stale-CAS races. Network slots are multisets abstracted to a single
\* retained request and a reply: duplicate delivery is Replay, loss is DropReply.
CONSTANTS AnchorGuard, PartitionGuard, LostReplyGuard, RestoreGuard,
          ReplayGuard, CasGuard, RestartGuard, FsyncGuard, PendingSaveGuard
VARIABLE s
vars == <<s>>
Ids == 1..6
\* 1,2 claim; 3 cancel; 4,5 effect; 6 settle.
EmptyAuthority == [seq |-> 0, epoch |-> 0, cancelled |-> {}, lease |-> 0,
  effects |-> [e \in 1..2 |-> "none"], requests |-> [r \in Ids |-> 0]]
Init == s = [authority |-> EmptyAuthority, durable |-> EmptyAuthority,
  client |-> [seq |-> 0, epoch |-> 0, lease |-> 0, cancelled |-> {}, parked |-> FALSE],
  acknowledgedCancels |-> {}, acceptedCancels |-> {}, pendingCancels |-> {},
  volatileCancels |-> {}, cancelBodySeq |-> 0, cancelBodyEpoch |-> 0,
  cancelSubmissions |-> {}, clientRestarted |-> FALSE,
  diskJournal |-> {}, diskCheckpoint |-> {},
  checkpointPresent |-> TRUE, pending |-> 0, reply |-> 0,
  bodyEpoch |-> 0, bodySeq |-> 0, bodyLease |-> 0,
  sent |-> {}, reachable |-> TRUE, now |-> 0, restarted |-> FALSE,
  highSeq |-> 0, highEpoch |-> 0, originals |-> [r \in Ids |-> 0],
  executions |-> [r \in Ids |-> 0], afterCancel |-> FALSE,
  advancedUnknown |-> FALSE, unfenced |-> FALSE]
Send(r) == /\ s.pending = 0 /\ r \notin s.sent /\ r # 3
  /\ s.pendingCancels = {} /\ s.volatileCancels = {}
  /\ s' = [s EXCEPT !.pending = r, !.sent = @ \cup {r},
    !.bodyEpoch = s.client.epoch, !.bodySeq = s.client.seq,
    !.bodyLease = s.client.lease]
\* Accept includes the local append/fsync boundary, before any network submit.
AcceptOwnerCancel == /\ 3 \notin s.sent /\ s.pending = 0
  /\ s' = [s EXCEPT !.sent = @ \cup {3}, !.acceptedCancels = @ \cup {3},
    !.pendingCancels = (IF PendingSaveGuard THEN @ \cup {3} ELSE @),
    !.volatileCancels = {3}, !.cancelBodySeq = s.client.seq,
    !.cancelBodyEpoch = s.client.epoch]
SubmitPendingCancel == /\ s.pending = 0
  /\ 3 \in (s.pendingCancels \cup s.volatileCancels)
  /\ s' = [s EXCEPT !.pending = 3, !.bodySeq = s.cancelBodySeq,
    !.bodyEpoch = s.cancelBodyEpoch, !.bodyLease = 0,
    !.cancelSubmissions = @ \cup {3}]
ClientCrashRestart == /\ ~s.clientRestarted
  /\ (s.pendingCancels # {} \/ s.volatileCancels # {})
  /\ s' = [s EXCEPT !.clientRestarted = TRUE, !.volatileCancels = {},
    !.pending = 0, !.reply = 0, !.bodyEpoch = 0, !.bodySeq = 0, !.bodyLease = 0,
    !.client = [seq |-> 0, epoch |-> 0, lease |-> 0, cancelled |-> {}, parked |-> FALSE]]
ReadEpoch == /\ s.reachable
  /\ s' = [s EXCEPT !.client = [seq |-> s.authority.seq,
    epoch |-> s.authority.epoch, lease |-> s.authority.lease,
    cancelled |-> s.authority.cancelled,
    parked |-> s.authority.seq < s.client.seq]]
\* Updating durable state and returning a success are distinct actions.
Commit(a) == s' = [s EXCEPT !.authority = a,
  !.durable = (IF FsyncGuard THEN a ELSE s.durable),
  !.highSeq = a.seq, !.highEpoch = a.epoch,
  !.reply = s.pending, !.executions[s.pending] = @ + 1,
  !.originals[s.pending] = (IF @ = 0 THEN a.seq ELSE @)]
Fresh == s.pending # 0 /\ s.reply = 0
  /\ s.authority.requests[s.pending] = 0 /\ s.authority.seq < 4
CommitCancel == /\ Fresh /\ s.pending = 3 /\ s.reachable
  /\ s.authority.cancelled = {} /\ s.authority.epoch < 4
  /\ Commit([s.authority EXCEPT !.seq = @ + 1, !.epoch = @ + 1,
    !.cancelled = {1}, !.requests[3] = s.authority.seq + 1])
CasAdmitClaim == /\ Fresh /\ s.pending \in {1,2} /\ s.reachable
  /\ s.authority.cancelled = {} /\ s.authority.epoch < 4
  /\ (s.authority.lease = 0 \/ s.now < 1)
  /\ (~CasGuard \/ s.bodyEpoch = s.authority.epoch)
  /\ LET a == [s.authority EXCEPT !.seq = @ + 1, !.epoch = @ + 1,
       !.lease = s.authority.epoch + 1,
       !.requests[s.pending] = s.authority.seq + 1]
     IN /\ s' = [s EXCEPT !.authority = a,
          !.durable = (IF FsyncGuard THEN a ELSE s.durable),
          !.highSeq = a.seq, !.highEpoch = a.epoch,
          !.reply = s.pending, !.executions[s.pending] = @ + 1,
          !.originals[s.pending] = a.seq,
          !.unfenced = @ \/ s.bodyEpoch # s.authority.epoch]
LeaseLive == s.bodyLease # 0 /\ s.bodyLease = s.authority.lease
  /\ s.bodyEpoch = s.authority.epoch /\ s.now < 1
Unknown == \E e \in 1..2: s.authority.effects[e] \in {"admitted", "unknown"}
CasAdmitEffect == /\ Fresh /\ s.pending \in {4,5} /\ s.reachable
  /\ s.authority.cancelled = {} /\ LeaseLive
  /\ (~CasGuard \/ s.bodySeq = s.authority.seq) /\ ~Unknown
  /\ LET e == s.pending - 3
         a == [s.authority EXCEPT !.seq = @ + 1, !.effects[e] = "admitted",
           !.requests[s.pending] = s.authority.seq + 1]
     IN /\ s' = [s EXCEPT !.authority = a,
          !.durable = (IF FsyncGuard THEN a ELSE s.durable),
          !.highSeq = a.seq, !.highEpoch = a.epoch,
          !.reply = s.pending, !.executions[s.pending] = @ + 1,
          !.originals[s.pending] = a.seq,
          !.afterCancel = @ \/ s.authority.cancelled # {},
          !.advancedUnknown = @ \/ Unknown,
          !.unfenced = @ \/ s.bodySeq # s.authority.seq]
CasSettle(outcome) == /\ Fresh /\ s.pending = 6 /\ s.reachable /\ LeaseLive
  /\ s.authority.effects[1] \in {"admitted", "unknown"}
  /\ Commit([s.authority EXCEPT !.seq = @ + 1, !.effects[1] = outcome,
    !.requests[6] = s.authority.seq + 1])
\* Failed CAS, expired lease, unknown effect and cancelled calls never mutate.
Refuse == /\ s.pending # 0 /\ s.reply = 0
  /\ s' = [s EXCEPT !.pending = 0, !.client.parked = TRUE]
Acknowledge == /\ s.reply # 0 /\ s.reachable
  /\ s' = [s EXCEPT !.acknowledgedCancels =
      (IF s.reply = 3 THEN @ \cup {1} ELSE @),
    !.diskJournal = (IF s.reply = 3 THEN {1} ELSE @),
    !.diskCheckpoint = (IF s.reply = 3 THEN {1} ELSE @),
    !.pendingCancels = (IF s.reply = 3 THEN {} ELSE @),
    !.volatileCancels = (IF s.reply = 3 THEN {} ELSE @),
    !.pending = 0, !.reply = 0]
DropReply == /\ s.reply # 0
  /\ s' = [s EXCEPT !.reply = 0]
\* A duplicate returns the retained original, not another committed mutation.
Replay == /\ s.pending # 0 /\ s.reply = 0 /\ s.reachable
  /\ s.authority.requests[s.pending] # 0
  /\ IF ReplayGuard THEN s' = [s EXCEPT !.reply = s.pending]
     ELSE /\ s.authority.seq < 4
          /\ s' = [s EXCEPT !.authority.seq = @ + 1,
            !.executions[s.pending] = @ + 1]
DuplicateDelivery(r) == /\ s.pending = 0 /\ s.authority.requests[r] # 0
  /\ s' = [s EXCEPT !.pending = r]
Partition == s' = [s EXCEPT !.reachable = ~@]
OfflineAdmit == /\ ~PartitionGuard /\ ~s.reachable /\ s.pending \in {4,5}
  /\ s' = [s EXCEPT !.unfenced = TRUE,
    !.afterCancel = @ \/ s.authority.cancelled # {}, !.pending = 0]
\* The unsafe client mistakes a queued/lost cancel for a durable acknowledgement.
PrematureCancelAck == /\ ~LostReplyGuard /\ s.pending = 3 /\ s.reply = 0
  /\ s' = [s EXCEPT !.acknowledgedCancels = @ \cup {1}]
DeleteCheckpoint == s' = [s EXCEPT !.checkpointPresent = FALSE, !.diskCheckpoint = {}]
TruncateJournalToPrefix == s' = [s EXCEPT !.diskJournal = {}]
RestartReplay == /\ ~s.checkpointPresent /\ s.diskJournal = {}
  /\ s.acknowledgedCancels # {}
  /\ s' = [s EXCEPT !.client.cancelled =
       (IF AnchorGuard THEN s.authority.cancelled ELSE {}),
    !.client.parked = ~s.reachable,
    !.authority.cancelled = (IF AnchorGuard THEN @ ELSE {})]
Tick == /\ s.now < 1 /\ s' = [s EXCEPT !.now = @ + 1]
\* Lazy expiry is checked by LeaseLive, without an alarm action.
LeaseExpiry == /\ s.now = 1 /\ s.authority.lease # 0
  /\ s' = [s EXCEPT !.authority.lease = 0, !.durable.lease = 0]
Restore == /\ s.authority.seq > 0
  /\ IF RestoreGuard THEN UNCHANGED vars
     ELSE s' = [s EXCEPT !.authority.seq = 0, !.authority.epoch = 0]
DaemonCrashRestart == /\ ~s.restarted
  /\ s' = [s EXCEPT !.restarted = TRUE, !.authority.lease = 0, !.durable.lease = 0,
    !.authority.requests = (IF RestartGuard THEN @ ELSE [r \in Ids |-> 0])]
LoseLocalDurability == /\ ~FsyncGuard /\ s.authority # s.durable
  /\ s.acknowledgedCancels # {}
  /\ s' = [s EXCEPT !.authority = s.durable]
Next == \/ \E r \in Ids: Send(r) \/ DuplicateDelivery(r)
  \/ AcceptOwnerCancel \/ SubmitPendingCancel \/ ClientCrashRestart
  \/ ReadEpoch \/ CommitCancel \/ CasAdmitClaim \/ CasAdmitEffect
  \/ \E o \in {"ok", "failed", "unknown"}: CasSettle(o)
  \/ Refuse \/ Acknowledge \/ DropReply \/ Replay \/ Partition
  \/ OfflineAdmit \/ PrematureCancelAck \/ DeleteCheckpoint
  \/ TruncateJournalToPrefix \/ RestartReplay \/ Tick \/ LeaseExpiry
  \/ Restore \/ DaemonCrashRestart \/ LoseLocalDurability
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.authority.seq \in 0..4 /\ s.authority.epoch \in 0..4
  /\ s.authority.cancelled \subseteq {1} /\ s.acknowledgedCancels \subseteq {1}
  /\ s.authority.lease \in 0..4 /\ s.pending \in 0..6 /\ s.reply \in 0..6
  /\ s.authority.effects \in [1..2 -> {"none", "admitted", "ok", "failed", "unknown"}]
  /\ s.authority.requests \in [Ids -> 0..4]
  /\ s.acceptedCancels \subseteq {3} /\ s.pendingCancels \subseteq {3}
  /\ s.volatileCancels \subseteq {3} /\ s.cancelSubmissions \subseteq {3}
  /\ s.clientRestarted \in BOOLEAN
CancelDurable == s.acknowledgedCancels \subseteq s.authority.cancelled
NoEffectAfterAuthoritativeCancel == ~s.afterCancel
NoAdvanceOnUnknownEffect == ~s.advancedUnknown
ReplayIdempotent == \A r \in Ids: s.executions[r] <= 1
  /\ (s.originals[r] = 0 \/ s.authority.requests[r] = s.originals[r])
EpochSeqMonotonic == s.authority.seq >= s.highSeq /\ s.authority.epoch >= s.highEpoch
PendingCancelSurvivesRestart ==
  /\ (~s.clientRestarted \/ s.acceptedCancels \subseteq
       (s.pendingCancels \cup (IF s.authority.requests[3] # 0 \/ 1 \in s.authority.cancelled THEN {3} ELSE {})))
  /\ s.cancelSubmissions \subseteq s.acceptedCancels
  /\ s.pendingCancels \subseteq s.acceptedCancels
LeaseFenced == ~s.unfenced
=============================================================================
