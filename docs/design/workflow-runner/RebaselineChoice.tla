-------------------------- MODULE RebaselineChoice --------------------------
EXTENDS Naturals
CONSTANT Mode
VARIABLES phase, finalConfig, baseFailed, counted, locked, oldLockIntact, historyIntact
vars == <<phase, finalConfig, baseFailed, counted, locked, oldLockIntact, historyIntact>>
Init == /\ phase = "choose" /\ finalConfig = FALSE /\ baseFailed = FALSE
        /\ counted = FALSE /\ locked = FALSE /\ oldLockIntact = TRUE /\ historyIntact = TRUE
Choose == /\ phase = "choose"
          /\ phase' = IF Mode = "owner-wait" THEN "hold" ELSE "config"
          /\ UNCHANGED <<finalConfig, baseFailed, counted, locked, oldLockIntact, historyIntact>>
Configure == /\ phase = "config" /\ phase' = "baseline"
             /\ finalConfig' = (Mode # "late-config")
             /\ oldLockIntact' = (Mode # "rewrite-lock")
             /\ historyIntact' = (Mode # "rewrite-history")
             /\ UNCHANGED <<baseFailed, counted, locked>>
FailBase == /\ phase = "baseline" /\ phase' = "lock"
            /\ baseFailed' = (Mode # "count-without-failure")
            /\ counted' = TRUE /\ UNCHANGED <<finalConfig, locked, oldLockIntact, historyIntact>>
Lock == /\ phase = "lock" /\ phase' = "implementation" /\ locked' = TRUE
        /\ UNCHANGED <<finalConfig, baseFailed, counted, oldLockIntact, historyIntact>>
Implement == /\ phase = "implementation" /\ phase' = "checks"
             /\ UNCHANGED <<finalConfig, baseFailed, counted, locked, oldLockIntact, historyIntact>>
Check == /\ phase = "checks" /\ phase' = "done"
         /\ UNCHANGED <<finalConfig, baseFailed, counted, locked, oldLockIntact, historyIntact>>
Done == /\ phase \in {"done", "hold"} /\ UNCHANGED vars
Next == Choose \/ Configure \/ FailBase \/ Lock \/ Implement \/ Check \/ Done
FailFirstProven == counted => (baseFailed /\ finalConfig)
NoLockRewrittenOrDeleted == oldLockIntact
NoPushedHistoryRewritten == historyIntact
ConfigBeforeLock == locked => finalConfig
\* Bounded progress: every nonterminal phase has a forward action; hold is the
\* sole non-progress terminal state. WF(Next) excludes infinite prefix stutter.
Progress == phase # "hold"
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
=============================================================================
