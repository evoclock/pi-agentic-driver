---------------------- MODULE ConfigurationTransition ----------------------
EXTENDS Naturals
CONSTANT Unsafe
VARIABLES workspace, config, originalLock, lockConfig, checked
vars == <<workspace, config, originalLock, lockConfig, checked>>
Init == /\ workspace = 0 /\ config = 0 /\ originalLock = 0
        /\ lockConfig = 0 /\ checked = FALSE
AppendContract == /\ config = 0 /\ config' = 1 /\ checked' = FALSE
                  /\ UNCHANGED <<workspace, originalLock, lockConfig>>
FreshLease == /\ workspace = 0 /\ config = 1 /\ workspace' = 1
              /\ lockConfig' = 2 /\ checked' = FALSE
              /\ UNCHANGED <<config, originalLock>>
Baseline == /\ workspace = 1 /\ lockConfig = 2 /\ lockConfig' = config
            /\ UNCHANGED <<workspace, config, originalLock, checked>>
Check == /\ (lockConfig = config \/ Unsafe) /\ checked' = TRUE
         /\ UNCHANGED <<workspace, config, originalLock, lockConfig>>
Hold == UNCHANGED vars
EraseOriginal == /\ Unsafe /\ originalLock' = 1
                 /\ UNCHANGED <<workspace, config, lockConfig, checked>>
Next == AppendContract \/ FreshLease \/ Baseline \/ Check \/ EraseOriginal \/ Hold
Spec == Init /\ [][Next]_vars
LockCoversCheckedConfiguration == ~checked \/ lockConfig = config
OriginalEvidencePreserved == originalLock = 0
=============================================================================
