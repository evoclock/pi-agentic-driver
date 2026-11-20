---------------------------- MODULE AckHandoff ----------------------------
EXTENDS Naturals

\* Abstraction of executeHerdrPromptExchange and the one dispatch consumer
\* decision that can send another prompt (runWorkerJourney's unresponsive
\* branch). A returned prompt acknowledgement is the only transition that
\* establishes a sent prompt. A failed invocation is uncertain, not evidence
\* that no prompt was sent. No transport runs here.
FailureModes == {"kind-missing", "kind-unsupported", "kind-empty",
                 "kind-switched", "status-invalid", "status-blocked",
                 "read-failed", "read-timeout", "report-missing"}
PreModes == {"first-codex", "second-codex", "kind-changed-before",
             "read-failed-before"}
\* transport: prompt_handoff_uncertain. stalled-*: agent_prompt_stalled with
\* recovery that saw an advanced idle role, an unproven state, or a failed get.
UncertainModes == {"transport", "stalled-advanced", "stalled-unknown",
                   "stalled-recovery-failed"}
\* Results the dispatch journey classifies as an unresponsive worker:
\* prompt_stalled, prompt_delivery_unknown and process_timeout.
UnresponsiveReasons == {"stalled-advanced", "stalled-unknown",
                        "stalled-recovery-failed", "read-timeout"}
VARIABLES phase, handoff, mark, reason, attempts, reprompts
vars == <<phase, handoff, mark, reason, attempts, reprompts>>

Init == phase = "before" /\ handoff = FALSE /\ mark = "none"
        /\ reason = "none" /\ attempts = 0 /\ reprompts = 0
PreRefuse == \E r \in PreModes:
               phase = "before" /\ phase' = "refused"
               /\ reason' = r /\ UNCHANGED <<handoff, mark, attempts, reprompts>>
PromptReturns == phase = "before" /\ phase' = "sent"
                 /\ handoff' = TRUE /\ attempts' = 1
                 /\ UNCHANGED <<mark, reason, reprompts>>
PromptUncertain == \E r \in UncertainModes:
                   phase = "before" /\ phase' = "uncertain"
                   /\ mark' = "unknown" /\ attempts' = 1
                   /\ reason' = r /\ UNCHANGED <<handoff, reprompts>>
AckRefuse == \E r \in FailureModes:
               phase = "sent" /\ phase' = "refused"
               /\ reason' = r /\ mark' = "unattributed"
               /\ UNCHANGED <<handoff, attempts, reprompts>>
AckComplete == phase = "sent" /\ phase' = "complete"
               /\ UNCHANGED <<handoff, mark, reason, attempts, reprompts>>
\* Autonomous dispatch may send one gap-analysis prompt after an unresponsive
\* result, but never after a returned acknowledgement (mark unattributed).
DispatchReprompt == phase \in {"refused", "uncertain"}
                    /\ reason \in UnresponsiveReasons
                    /\ mark # "unattributed" /\ reprompts = 0
                    /\ reprompts' = 1
                    /\ UNCHANGED <<phase, handoff, mark, reason, attempts>>
Terminal == phase \in {"refused", "complete", "uncertain"} /\ UNCHANGED vars
Next == PreRefuse \/ PromptReturns \/ PromptUncertain \/ AckRefuse
        \/ AckComplete \/ DispatchReprompt \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK == phase \in {"before", "sent", "refused", "complete", "uncertain"}
          /\ handoff \in BOOLEAN /\ mark \in {"none", "unknown", "unattributed"}
          /\ reason \in FailureModes \cup PreModes \cup UncertainModes \cup {"none"}
          /\ attempts \in 0..1 /\ reprompts \in 0..1
PostSentMarked == (phase = "refused" /\ handoff) => mark = "unattributed"
PreRefusalHonest == (phase = "refused" /\ ~handoff) => mark = "none"
UnknownMarked == phase = "uncertain" => mark = "unknown"
NoReplay == attempts <= 1
NoRepromptAfterReturn == handoff => reprompts = 0
=============================================================================
