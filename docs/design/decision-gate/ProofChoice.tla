----------------------------- MODULE ProofChoice -----------------------------
CONSTANTS Kind, Configured, GapRecorded
VARIABLE phase
Init == phase = "compare"
Next == phase' = "proceed"
Spec == Init /\ [][Next]_phase
HarnessRunnable == phase = "proceed" => (Kind = "behavior" => Configured)
HonestPromise == phase = "proceed" =>
  ((Kind = "code" => GapRecorded) /\ Kind \in {"code", "behavior", "hold"})
NativePreferred == phase = "proceed" => (Configured => Kind # "code")
=============================================================================
