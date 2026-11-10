------------------------------- MODULE EFDW -------------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Unsafe, Author, Reviewer
VARIABLES phase, reviews, qaPassed, terminal, terminalAccepted, transferred, integrated
vars == <<phase, reviews, qaPassed, terminal, terminalAccepted, transferred, integrated>>

Init == \E n \in {0, 2}:
  /\ reviews = n
  /\ phase = IF n = 2 THEN "recovery" ELSE "contract"
  /\ qaPassed = FALSE /\ terminal = (n = 2)
  /\ terminalAccepted = FALSE /\ transferred = FALSE /\ integrated = FALSE

Readiness == phase = "contract" /\ phase' = "implement" /\ UNCHANGED <<reviews, qaPassed, terminal, terminalAccepted, transferred, integrated>>
Implement == phase = "implement" /\ phase' = "review" /\ UNCHANGED <<reviews, qaPassed, terminal, terminalAccepted, transferred, integrated>>
ReviewPass == phase = "review" /\ reviews < 2
  /\ reviews' = reviews + 1 /\ phase' = "qa"
  /\ UNCHANGED <<qaPassed, terminal, terminalAccepted, transferred, integrated>>
ReviewReject == phase = "review" /\ reviews < 2
  /\ reviews' = reviews + 1 /\ phase' = (IF reviews' = 2 THEN "recovery" ELSE "correction")
  /\ terminal' = (reviews' = 2) /\ UNCHANGED <<qaPassed, terminalAccepted, transferred, integrated>>
Correction == phase = "correction" /\ phase' = "review" /\ UNCHANGED <<reviews, qaPassed, terminal, terminalAccepted, transferred, integrated>>
QAPass == phase = "qa" /\ phase' = "delivery" /\ qaPassed' = TRUE
  /\ UNCHANGED <<reviews, terminal, terminalAccepted, transferred, integrated>>
QAReject == phase = "qa" /\ phase' = (IF reviews = 2 THEN "recovery" ELSE "correction")
  /\ terminal' = (reviews = 2) /\ UNCHANGED <<reviews, qaPassed, terminalAccepted, transferred, integrated>>
Transfer == phase = "recovery" /\ transferred' = TRUE /\ UNCHANGED <<phase, reviews, qaPassed, terminal, terminalAccepted, integrated>>
RecoverAccepted == phase = "recovery" /\ transferred /\ phase' = "delivery" /\ terminalAccepted' = TRUE
  /\ UNCHANGED <<reviews, qaPassed, terminal, transferred, integrated>>
RecoverHeld == phase = "recovery" /\ phase' = "stop" /\ UNCHANGED <<reviews, qaPassed, terminal, terminalAccepted, transferred, integrated>>
VerifyDelivery == phase = "delivery" /\ phase' = "owner-wait" /\ UNCHANGED <<reviews, qaPassed, terminal, terminalAccepted, transferred, integrated>>
ConfirmIntegration == phase = "owner-wait" /\ phase' = "cleanup" /\ integrated' = TRUE
  /\ UNCHANGED <<reviews, qaPassed, terminal, terminalAccepted, transferred>>
Preserve == phase = "owner-wait" /\ phase' = "stop" /\ UNCHANGED <<reviews, qaPassed, terminal, terminalAccepted, transferred, integrated>>
UnsafeReviewAfterRecovery == Unsafe /\ phase = "recovery" /\ phase' = "review" /\ reviews' = reviews + 1
  /\ UNCHANGED <<qaPassed, terminal, terminalAccepted, transferred, integrated>>
Done == phase \in {"cleanup", "stop"} /\ UNCHANGED vars

Next == Readiness \/ Implement \/ ReviewPass \/ ReviewReject \/ Correction \/ QAPass
  \/ QAReject \/ Transfer \/ RecoverAccepted \/ RecoverHeld \/ VerifyDelivery
  \/ ConfirmIntegration \/ Preserve \/ UnsafeReviewAfterRecovery \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == phase \in {"contract", "implement", "review", "qa", "correction", "recovery", "delivery", "owner-wait", "cleanup", "stop"}
  /\ reviews \in 0..3 /\ qaPassed \in BOOLEAN /\ terminal \in BOOLEAN
  /\ terminalAccepted \in BOOLEAN /\ transferred \in BOOLEAN /\ integrated \in BOOLEAN
ReviewerSeparation == Author # Reviewer
NoThirdReview == reviews <= 2
NoRecoveryReview == terminal => phase \notin {"review", "qa", "correction"}
DeliveryEvidence == phase \in {"delivery", "owner-wait", "cleanup"} => (qaPassed \/ terminalAccepted)
OwnerIntegration == phase = "cleanup" => integrated
=============================================================================
