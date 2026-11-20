-------------------------- MODULE DualSkillEval --------------------------
EXTENDS Naturals
VARIABLES phase, reserved, jev, openai, acting, history
vars == <<phase, reserved, jev, openai, acting, history>>
Init == phase = "start" /\ reserved = FALSE /\ jev = FALSE /\ openai = FALSE /\ acting = FALSE /\ history = FALSE
Reserve == phase = "start" /\ phase' = "reserved" /\ reserved' = TRUE /\ UNCHANGED <<jev, openai, acting, history>>
Reject == phase = "start" /\ phase' = "failed" /\ UNCHANGED <<reserved, jev, openai, acting, history>>
AskJev == phase = "reserved" /\ phase' = "jev" /\ jev' = TRUE /\ UNCHANGED <<reserved, openai, acting, history>>
AskOpenAI == phase = "jev" /\ phase' = "both" /\ openai' = TRUE /\ UNCHANGED <<reserved, jev, acting, history>>
Fail == phase \in {"reserved", "jev", "both"} /\ phase' = "failed" /\ UNCHANGED <<reserved, jev, openai, acting, history>>
Write == phase = "both" /\ phase' = "written" /\ acting' = TRUE /\ UNCHANGED <<reserved, jev, openai, history>>
Append == phase = "written" /\ phase' = "done" /\ history' = TRUE /\ UNCHANGED <<reserved, jev, openai, acting>>
Terminal == phase \in {"failed", "done"} /\ UNCHANGED vars
Next == Reserve \/ Reject \/ AskJev \/ AskOpenAI \/ Fail \/ Write \/ Append \/ Terminal
TypeOK == phase \in {"start", "reserved", "jev", "both", "written", "done", "failed"} /\ reserved \in BOOLEAN /\ jev \in BOOLEAN /\ openai \in BOOLEAN /\ acting \in BOOLEAN /\ history \in BOOLEAN
NoPartialVerdict == acting => (reserved /\ jev /\ openai)
NoUnreportedHistory == history => (acting /\ phase = "done")
NoFailedHistory == phase = "failed" => ~history
Spec == Init /\ [][Next]_vars
=============================================================================
