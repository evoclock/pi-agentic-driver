------------------------- MODULE ObservabilityBase -------------------------
EXTENDS Naturals
CONSTANT Unsafe
VARIABLES main, head, tracking, observed, selected, image, stage
vars == <<main, head, tracking, observed, selected, image, stage>>
Init == /\ main = 0 /\ head = 0 /\ tracking = 0 /\ observed = 0
        /\ selected = 0 /\ image = 0 /\ stage = "checkout"
Advance == /\ main < 2 /\ main' = main + 1
           /\ UNCHANGED <<head, tracking, observed, selected, image, stage>>
MergeMain == /\ head < main /\ head' = main /\ stage' = "checkout"
             /\ UNCHANGED <<main, tracking, observed, selected, image>>
\* The host must fetch before selecting a base; tracking can be arbitrarily old.
HostSelect == /\ stage = "checkout" /\ (head = main \/ Unsafe = "stalehead")
              /\ observed' = main /\ tracking' = main
              /\ selected' = IF Unsafe = "cached" THEN tracking ELSE main
              /\ stage' = "verified"
              /\ UNCHANGED <<main, head, image>>
RejectStaleHead == /\ stage = "checkout" /\ head < main /\ stage' = "blocked"
                   /\ UNCHANGED <<main, head, tracking, observed, selected, image>>
\* Image materialization can accidentally retain a previous local main ref.
Image == /\ stage = "verified" /\ image' \in 0..2 /\ stage' = "image"
         /\ UNCHANGED <<main, head, tracking, observed, selected>>
OfflineCheck == /\ stage = "image" /\ (image = selected \/ Unsafe = "image")
                /\ stage' = "gate"
                /\ UNCHANGED <<main, head, tracking, observed, selected, image>>
RejectImage == /\ stage = "image" /\ image # selected /\ stage' = "blocked"
               /\ UNCHANGED <<main, head, tracking, observed, selected, image>>
Hold == UNCHANGED vars
Next == Advance \/ MergeMain \/ HostSelect \/ RejectStaleHead \/ Image \/ OfflineCheck \/ RejectImage \/ Hold
Spec == Init /\ [][Next]_vars
\* Freshness means the host's fetched sample, not a permanently frozen remote.
GateUsesVerifiedBase == stage # "gate" \/ (selected = observed /\ image = observed)
NoLockOnStaleBase == stage # "gate" \/ head >= observed
NeverGate == stage # "gate"
NeverReject == stage # "blocked"
=============================================================================
