------------------------ MODULE Gap8OutputContract ------------------------
EXTENDS Naturals, TLC
CONSTANTS Option, CheckGuard, ScopeGuard, LegacyGuard, FreshGuard, DigestGuard
VARIABLES phase, worker, bytes, expected, path, written, recorded, checked,
          checkedBytes, passed, accepted
vars == <<phase, worker, bytes, expected, path, written, recorded, checked,
          checkedBytes, passed, accepted>>
Init == /\ phase = "ready" /\ worker \in BOOLEAN /\ bytes = "broken"
        /\ expected = "broken" /\ path = "artifact" /\ written = {}
        /\ recorded = "none" /\ checked = FALSE /\ checkedBytes = "none"
        /\ passed = FALSE /\ accepted = FALSE
Write == /\ Option # "Hold" /\ phase = "ready"
         /\ bytes' \in {"broken", "repaired"} /\ path' \in {"artifact", "outside"}
         /\ (ScopeGuard => path' = "artifact")
         /\ written' = written \cup {path'} /\ phase' = "written"
         /\ UNCHANGED <<worker, expected, recorded, checked, checkedBytes, passed, accepted>>
\* B requires a separately audited redeclaration. This action assumes its host
\* has verified that refresh; it is not authority supplied by the model.
AuditedRefresh == /\ Option = "B" /\ phase = "written" /\ worker
                  /\ expected' = bytes
                  /\ UNCHANGED <<phase, worker, bytes, path, written, recorded,
                                  checked, checkedBytes, passed, accepted>>
Record == /\ phase = "written" /\ (ScopeGuard => path = "artifact")
          /\ ((worker /\ Option = "A") \/ ~LegacyGuard \/ bytes = expected)
          /\ recorded' \in {"broken", "repaired"}
          /\ (DigestGuard => recorded' = bytes) /\ phase' = "recorded"
          /\ UNCHANGED <<worker, bytes, expected, path, written, checked,
                          checkedBytes, passed, accepted>>
Check == /\ phase = "recorded" /\ checked' = TRUE /\ checkedBytes' = bytes
         /\ passed' = (bytes = "repaired") /\ phase' = "checked"
         /\ UNCHANGED <<worker, bytes, expected, path, written, recorded, accepted>>
ChangeAfterCheck == /\ phase = "checked" /\ bytes = checkedBytes
                    /\ bytes' = IF bytes = "broken" THEN "repaired" ELSE "broken"
                    /\ UNCHANGED <<phase, worker, expected, path, written, recorded,
                                    checked, checkedBytes, passed, accepted>>
Accept == /\ phase \in {"recorded", "checked"}
          /\ (CheckGuard => checked /\ passed)
          /\ (FreshGuard => bytes = checkedBytes /\ bytes = recorded)
          /\ accepted' = TRUE /\ phase' = "accepted"
          /\ UNCHANGED <<worker, bytes, expected, path, written, recorded,
                          checked, checkedBytes, passed>>
Stop == /\ phase # "accepted" /\ phase' = "held"
        /\ UNCHANGED <<worker, bytes, expected, path, written, recorded,
                        checked, checkedBytes, passed, accepted>>
Settled == /\ phase \in {"accepted", "held"} /\ UNCHANGED vars
Next == Write \/ AuditedRefresh \/ Record \/ Check \/ ChangeAfterCheck \/ Accept \/ Stop \/ Settled
Spec == Init /\ [][Next]_vars
ChecksOnRecordedBytes == accepted => checked /\ passed /\ checkedBytes = recorded
FrozenPathsOnly == written \subseteq {"artifact"} /\ (accepted => path = "artifact")
LegacyUnchanged == (~worker /\ recorded # "none") => recorded = expected
NoTOCTOU == accepted => bytes = checkedBytes /\ recorded = bytes
RecordedActualBytes == (phase \in {"recorded", "checked"} /\ ~checked) => recorded = bytes
NeverRepairedWorker == ~(worker /\ accepted /\ recorded = "repaired")
=============================================================================
