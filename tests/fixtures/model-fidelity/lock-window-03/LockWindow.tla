---------------- MODULE LockWindow ----------------
EXTENDS Naturals
CONSTANT Mode
ASSUME Mode \in {"external-snapshot", "token-only", "immutable-pin", "same-store", "service-check"}
VARIABLES phase, clientAlive, backendAlive, lockSnapshot, metadataToken,
          identityToken, pinnedGeneration, generation, publishedGeneration, completed, staleEffect
vars == <<phase, clientAlive, backendAlive, lockSnapshot, metadataToken,
          identityToken, pinnedGeneration, generation, publishedGeneration, completed, staleEffect>>
Init == /\ phase = "cleared" /\ clientAlive = TRUE /\ backendAlive = TRUE
        /\ lockSnapshot = FALSE /\ metadataToken = 0 /\ identityToken = 0
        /\ pinnedGeneration = 0 /\ generation = 1 /\ publishedGeneration = 1
        /\ completed = FALSE /\ staleEffect = FALSE
ClientDies == /\ phase = "cleared" /\ phase' = "client-dead" /\ clientAlive' = FALSE
              /\ UNCHANGED <<backendAlive, lockSnapshot, metadataToken, identityToken, pinnedGeneration, generation, publishedGeneration, completed, staleEffect>>
ObserveLock == /\ phase = "client-dead" /\ phase' = "lock-observed" /\ lockSnapshot' = backendAlive
               /\ UNCHANGED <<clientAlive, backendAlive, metadataToken, identityToken, pinnedGeneration, generation, publishedGeneration, completed, staleEffect>>
BackendDies == /\ phase = "lock-observed" /\ phase' = "backend-dead" /\ backendAlive' = FALSE
               /\ UNCHANGED <<clientAlive, lockSnapshot, metadataToken, identityToken, pinnedGeneration, generation, publishedGeneration, completed, staleEffect>>
ReadMetadata == /\ phase = "backend-dead" /\ phase' = "metadata-read" /\ metadataToken' = publishedGeneration
                /\ UNCHANGED <<clientAlive, backendAlive, lockSnapshot, identityToken, pinnedGeneration, generation, publishedGeneration, completed, staleEffect>>
ReadIdentity == /\ phase = "metadata-read" /\ phase' = "identity-read"
                /\ identityToken' = generation /\ pinnedGeneration' = generation
                /\ UNCHANGED <<clientAlive, backendAlive, lockSnapshot, metadataToken, generation, publishedGeneration, completed, staleEffect>>
ReplaceResource == /\ phase = "identity-read" /\ phase' = "replaced" /\ generation' = 2
                   /\ publishedGeneration' = IF Mode = "same-store" THEN 2 ELSE publishedGeneration
                   /\ UNCHANGED <<clientAlive, backendAlive, lockSnapshot, metadataToken, identityToken, pinnedGeneration, completed, staleEffect>>
PublishGeneration == /\ phase = "replaced" /\ phase' = "published" /\ publishedGeneration' = generation
                     /\ UNCHANGED <<clientAlive, backendAlive, lockSnapshot, metadataToken, identityToken, pinnedGeneration, generation, completed, staleEffect>>
EffectGuard == CASE Mode = "same-store" -> metadataToken = generation /\ generation = publishedGeneration
                [] Mode = "service-check" -> identityToken = generation
                [] Mode = "external-snapshot" -> lockSnapshot /\ identityToken = metadataToken
                [] Mode = "token-only" -> identityToken = metadataToken
                [] OTHER -> pinnedGeneration = metadataToken
ApplyEffect == /\ phase \in {"identity-read", "replaced", "published"} /\ EffectGuard
               /\ phase' = "finished" /\ completed' = TRUE /\ staleEffect' = (metadataToken # generation)
               /\ UNCHANGED <<clientAlive, backendAlive, lockSnapshot, metadataToken, identityToken, pinnedGeneration, generation, publishedGeneration>>
RejectEffect == /\ phase \in {"replaced", "published"} /\ ~EffectGuard /\ phase' = "rejected"
                /\ UNCHANGED <<clientAlive, backendAlive, lockSnapshot, metadataToken, identityToken, pinnedGeneration, generation, publishedGeneration, completed, staleEffect>>
Done == phase \in {"finished", "rejected"} /\ UNCHANGED vars
Next == ClientDies \/ ObserveLock \/ BackendDies \/ ReadMetadata \/ ReadIdentity \/ ReplaceResource \/ PublishGeneration \/ ApplyEffect \/ RejectEffect \/ Done
Spec == Init /\ [][Next]_vars
NoStaleEffect == ~staleEffect
NoCompletion == ~completed
====================================================
