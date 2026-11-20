------------------------- MODULE BinaryIdentity -------------------------
EXTENDS Naturals

CONSTANT NameOnly
VARIABLES candidate, accepted
vars == <<candidate, accepted>>

Cases == {"trusted", "updated-release", "root-escape", "traversal",
          "unexpected-directory", "symlink-outside", "unconfigured-alias",
          "path-shadowed", "shell-script", "relative-path", "non-executable"}
AcceptedCases == {"trusted", "updated-release"}

Init == candidate \in Cases /\ accepted = FALSE
Decide == ~accepted /\ accepted' = (IF NameOnly THEN TRUE ELSE candidate \in AcceptedCases)
          /\ UNCHANGED candidate
Next == Decide \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK == candidate \in Cases /\ accepted \in BOOLEAN
OnlyAllowedCodexBinary == accepted => candidate \in AcceptedCases
=============================================================================
