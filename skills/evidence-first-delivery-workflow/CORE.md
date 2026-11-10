# Portable contract for an inactive delivery design

This is a method. It cannot execute work, validate trust in external receipts, or grant a worker authority. A human-approved task boundary precedes every graph.

## 1. Reconcile

Read the canonical owner contract and latest acceptance records before worker reports. Compare the exact artifact head with live version control and forge state. Keep separate fields for implemented, tested, reviewed, integrated, and unknown. Persist earlier reviewer involvement, consumed review count, correction count, sole-writer transfer and unresolved findings. A rename, merge or resume does not reset a unit's review history. New units need independent evidence of new scope.

## 2. Method and contract

Select an existing method matched to the unit, not a scheduler. Write BDD success and failure cases, artifact identity and immutable acceptance definition, scope, stopping point, permitted effects and delivery predicate. Hash the method text, source contract and definition. Preserve original references; a hash pinned inside a self-authored plan is not trusted until compared with the canonical record. Ralph operates within one assigned item only.

## 3. Statechart

Start from observed review count and current writer. Model bounded review, independent involvement, correction, terminal recovery, evidence before delivery, owner integration before cleanup and cancellation. Check with an installed bounded model checker; include a deliberately unsafe mutation to test that an invariant is meaningful. Keep model assumptions, output, configuration and counterexample. A successful abstract model is not an execution proof.

## 4. Actors

Resolve role, person/process identity, exact selected model and prior involvement separately. Confirm independent review actually differs from the author and, where required, model family. An unconfigured reviewer or historical recovery actor is an unavailable assignment. A role map is not an installed session setting or permission to spawn.

## 5. Graph

Valid transitions and ordinary review/QA findings continue automatically under the pinned contract; rejection enters bounded correction without a human stage approval. Human decisions are limited to material undefined product choices, new authority, review-budget exhaustion handoff, and the owner-only merge. A hold for missing evidence is not permission to improvise. This is a design requirement, not installed continuation.

Shared persisted invariants across adapters, not a universal crew pipeline: actor identities, involvement and review budgets survive retries, resume and relabel; one fenced writer epoch owns each write; receipts are bound to the exact artifact commit; cancellation rejects late results; effect intents use an idempotent outbox so retry after a crash cannot duplicate an effect; missing evidence blocks. A model's yes/no response neither authorizes a transition nor validates evidence.

Save one versioned file with stable plan/unit/node IDs, observed artifact and baseline heads, method/contract/map hashes, actor roles and model IDs, writer epoch, consumed review budget and previous involvement. Each edge names a required *future* artifact-bound receipt, not an existing receipt. New unit path: contract, implement, review1, QA1, delivery. Review1/QA1 rejection: one correction then review2 and QA2. Review2/QA2 rejection: explicit writing transfer and terminal recovery. A terminal acceptance can reach delivery, but never review or QA. Exhausted resume starts in recovery. Unresolved or ambiguous results enter preserved stop. Delivery waits for owner integration before cleanup; learning is optional and off the critical path. Save no triggers, schedules or active flag. Absence of auto-start settings does not prevent manual execution.

## 6. Guards

Use the [adapter capability matrix](./GUARDS.md#adapter-capability-matrix) and [framework bypass matrix](./GUARDS.md#framework-bypass-matrix) for each platform. A proposed integration is one trusted execution service with narrow typed submit/advance/evidence/cancel/status operations, never arbitrary shell and never a merge operation. Persist actor involvement, review reservations, writer and cancellation epochs, exact artifact head, evidence provenance and effect IDs atomically; check at dispatch, before each effect and when admitting results. Ordinary failures follow predefined recovery automatically. Require an authenticated owner exact-head integration receipt before lease reconciliation. These are requirements, not installed guards; task-scoped supported authorizations reduce friction but do not silently bypass host or tool approvals. A trusted local runner may use only installed supported tools. If no safe route exists, the saved graph is plan-only and offers no enforcement. Static schema and model tests are not runtime guard tests; positive automatic continuation remains required but unproven until a separately authorized runtime test.

The static validator checks graph shape and plan fields. Before actual execution, an independent runtime boundary still needs durable state, atomic counters, reviewer-involvement and writer-epoch checks, trusted step receipts, effect outbox, event continuation, cancellation reconciliation, owner integration and exact cleanup eligibility. Boolean graph conditions do not authorize effects. Missing runtime negative tests remain missing, not satisfied by schema tests.

## 7. Verify and return

Validate both saved examples and all negative plan cases. Read supported status/delivery observations before and after; absence of delivery IDs or task-store transitions supports only *no execution observed*, not a universal no-execution guarantee. Render a visual chart only through an available approved renderer; otherwise say no visual layout check. Return plan ID/path, source/method/contract/model hashes, real and missing actors, gaps, activation prerequisites and stop. Claim autonomy only after a permitted live task actually completes rejection/correction when applicable, independent review, QA and verified delivery without repeated owner nudges. Human merge wait is ordinary; unexplained idle time is not.
