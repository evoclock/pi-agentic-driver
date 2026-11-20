---------------------------- MODULE Fix4Runner ----------------------------
EXTENDS Naturals, FiniteSets
\* Four contenders; variants 1..4 represent changed digest, duplicate step,
\* path case, and trailing slash. All denote the same checked procedure/artifact.
\* Delta count and retained generation files are bounded abstract sizes, not bytes.
CONSTANTS IdentityGuard, HaltGuard, WriterGuard, FactGuard, BoundGuard
ASSUME /\ IdentityGuard \in BOOLEAN /\ HaltGuard \in BOOLEAN
       /\ WriterGuard \in BOOLEAN /\ FactGuard \in BOOLEAN
       /\ BoundGuard \in BOOLEAN
Writers == 1..4
Variants == 1..4
VARIABLE s
vars == <<s>>
Init == s = [pc |-> [w \in Writers |-> "idle"], variant |-> [w \in Writers |-> 1],
  tombs |-> {}, halt |-> FALSE, lock |-> 0, actedBy |-> {}, journaledBy |-> {},
  afterCancel |-> FALSE, afterHalt |-> FALSE, fork |-> FALSE,
  deltas |-> 0, lockFiles |-> 0, looks |-> 0,
  facts |-> [tombs |-> {}, halt |-> FALSE, lock |-> 0],
  snapshotValid |-> FALSE, snapshotFacts |-> [tombs |-> {}, halt |-> FALSE, lock |-> 0],
  compacted |-> FALSE, compactFacts |-> [tombs |-> {}, halt |-> FALSE, lock |-> 0]]
\* Persistent per-step tombstone; no caller-controlled expected digest enters it.
Cancel == /\ 1 \notin s.tombs /\ s.deltas < 2
  /\ s' = [s EXCEPT !.tombs = @ \cup {1}, !.facts.tombs = @ \cup {1},
    !.halt = TRUE, !.facts.halt = TRUE,
    !.deltas = @ + 1, !.compacted = FALSE]
OwnerHalt == /\ ~s.halt /\ s.deltas < 2
  /\ s' = [s EXCEPT !.halt = TRUE, !.facts.halt = TRUE,
    !.deltas = @ + 1, !.compacted = FALSE]
\* Atomic publication of a complete generation. The unsafe WriterGuard-off
\* branch models the old restore-window rename vacating a live predecessor.
Claim(w, v) == /\ w \in Writers /\ v \in Variants /\ (w = 1 \/ v = 1)
  /\ s.pc[w] = "idle"
  /\ s.journaledBy = {}
  /\ (IF IdentityGuard THEN 1 ELSE v) \notin s.tombs
  /\ (~s.halt \/ (~IdentityGuard /\ v # 1 /\ 1 \in s.tombs))
  /\ (~WriterGuard \/ s.lock = 0)
  /\ (~BoundGuard \/ s.lockFiles < 2) /\ s.deltas < 2
  /\ s' = [s EXCEPT !.pc[w] = "claimed", !.variant[w] = v,
    !.lock = w, !.facts.lock = w, !.lockFiles = @ + 1,
    !.deltas = @ + 1,
    !.halt = (IF IdentityGuard THEN @ ELSE FALSE),
    !.facts.halt = (IF IdentityGuard THEN @ ELSE FALSE), !.compacted = FALSE]
PrePublish(w) == /\ w \in Writers /\ s.pc[w] = "claimed"
  /\ s' = [s EXCEPT !.pc[w] = "checked"]
\* Owner halt can interleave between claim and publication; re-check is here.
Act(w) == /\ w \in Writers /\ s.pc[w] = "checked"
  /\ (~HaltGuard \/ ~s.halt) /\ (~WriterGuard \/ s.lock = w)
  /\ s' = [s EXCEPT !.pc[w] = "acted", !.actedBy = @ \cup {w},
    !.afterCancel = @ \/ (1 \in s.tombs), !.afterHalt = @ \/ s.halt]
Journal(w) == /\ w \in Writers /\ s.pc[w] = "acted" /\ s.deltas < 2
  /\ s' = [s EXCEPT !.pc[w] = "journaled", !.journaledBy = @ \cup {w},
    !.fork = @ \/ (s.journaledBy # {} /\ w \notin s.journaledBy),
    !.deltas = @ + 1]
Retire(w) == /\ w \in Writers /\ s.pc[w] = "journaled" /\ s.lock = w
  /\ s.deltas < 2
  /\ s' = [s EXCEPT !.pc[w] = "retired", !.lock = 0, !.facts.lock = 0,
    !.deltas = @ + 1, !.lockFiles = (IF BoundGuard THEN 1 ELSE @), !.compacted = FALSE]
\* A snapshot captures exact safety facts. A scheduler can suggest when to run
\* Compact, but cannot choose the retained facts. Delta count resets only here.
\* Four read-only polls stand for an arbitrarily repeated external status loop.
\* They still claim a writer in the current runtime; old generations must compact.
Look == /\ s.looks < 4 /\ s.lock = 0 /\ s.deltas < 2
  /\ s' = [s EXCEPT !.looks = @ + 1, !.deltas = @ + 1,
    !.lockFiles = (IF BoundGuard THEN 1 ELSE @ + 1), !.compacted = FALSE]
Snapshot == /\ s.deltas > 0
  /\ s' = [s EXCEPT !.snapshotValid = TRUE, !.snapshotFacts = s.facts,
    !.deltas = 0, !.compacted = FALSE]
\* Only a current authenticated checkpoint may replace old deltas. Facts remain
\* exact in the snapshot and the retained lock high-water mark.
Compact == /\ s.snapshotValid /\ s.deltas = 0 /\ ~s.compacted
  /\ s' = [s EXCEPT !.compacted = TRUE,
    !.compactFacts = (IF FactGuard THEN s.snapshotFacts
      ELSE [tombs |-> {}, halt |-> s.halt, lock |-> s.lock])]
Next == \/ Cancel \/ OwnerHalt \/ Look \/ Snapshot \/ Compact
  \/ \E w \in Writers, v \in Variants: Claim(w, v)
  \/ \E u \in Writers: PrePublish(u) \/ Act(u) \/ Journal(u) \/ Retire(u)
Spec == Init /\ [][Next]_vars
CancelledNeverActs == ~s.afterCancel
NoActAfterHalt == ~s.afterHalt
OneWriterNoFork == Cardinality(s.actedBy) <= 1 /\ ~s.fork
NoJournalFork == ~s.fork
CompactionExact == ~s.compacted \/ s.compactFacts = s.facts
StoreBound == s.deltas <= 2 /\ s.lockFiles <= 2
TypeOK == /\ s.tombs \subseteq {1} /\ s.lock \in 0..4
  /\ s.actedBy \subseteq Writers /\ s.journaledBy \subseteq Writers
=============================================================================
