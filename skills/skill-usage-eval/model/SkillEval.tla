----------------------------- MODULE SkillEval -----------------------------
EXTENDS Naturals
VARIABLES phase, parsed, fitted, answered, reported
vars == <<phase, parsed, fitted, answered, reported>>
Init == phase = "start" /\ parsed = FALSE /\ fitted = FALSE /\ answered = FALSE /\ reported = FALSE
Parse == phase = "start" /\ phase' = "parsed" /\ parsed' = TRUE /\ UNCHANGED <<fitted, answered, reported>>
Reject == phase = "start" /\ phase' = "failed" /\ UNCHANGED <<parsed, fitted, answered, reported>>
Segment == phase = "parsed" /\ phase' = "segmented" /\ UNCHANGED <<parsed, fitted, answered, reported>>
Fit == phase = "segmented" /\ phase' = "fitted" /\ fitted' = TRUE /\ UNCHANGED <<parsed, answered, reported>>
NoFit == phase = "segmented" /\ phase' = "failed" /\ UNCHANGED <<parsed, fitted, answered, reported>>
Ask == phase = "fitted" /\ phase' = "asked" /\ UNCHANGED <<parsed, fitted, answered, reported>>
Answer == phase = "asked" /\ phase' = "decided" /\ answered' = TRUE /\ UNCHANGED <<parsed, fitted, reported>>
AskFails == phase = "asked" /\ phase' = "failed" /\ UNCHANGED <<parsed, fitted, answered, reported>>
Report == phase = "decided" /\ phase' = "reported" /\ reported' = TRUE /\ UNCHANGED <<parsed, fitted, answered>>
Terminal == phase \in {"failed", "reported"} /\ UNCHANGED vars
Next == Parse \/ Reject \/ Segment \/ Fit \/ NoFit \/ Ask \/ Answer \/ AskFails \/ Report \/ Terminal
TypeOK == phase \in {"start", "parsed", "segmented", "fitted", "asked", "decided", "failed", "reported"} /\ parsed \in BOOLEAN /\ fitted \in BOOLEAN /\ answered \in BOOLEAN /\ reported \in BOOLEAN
NoUnansweredReport == reported => (parsed /\ fitted /\ answered /\ phase = "reported")
NoFailedReport == phase = "failed" => ~reported
Spec == Init /\ [][Next]_vars
=============================================================================
