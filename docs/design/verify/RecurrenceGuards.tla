-------------------------- MODULE RecurrenceGuards --------------------------
EXTENDS Integers, Sequences, FiniteSets
CONSTANTS Disabled, Separate, MaxRuntime
\* 0 guarded; 1..8 original controls; 9 inventory; 10 implementation tests;
\* 11 remove contract; 12 unproven refresh; 13 cap edit;
\* 14/15 stale inventory after merge/new model; 16 stale tests after merge.
\* 17 unproven added test input; 18 removal of a locked test input.
\* controls abstracts frozen inputs: 1 original inputs, 2 added contract, 3 added test.
VARIABLES phase, headroom, tools, terms, config, lockedConfig, fresh, override,
          controls, lockedControls, caps, history,
          generation, inventoryAt, testsAt, registered, lastChange,
          holder, started, age, queue, visible, reported
inputs == <<headroom, tools, terms, override>>
configuration == <<config, lockedConfig, controls, lockedControls, caps, history>>
checks == <<generation, inventoryAt, testsAt, registered, lastChange>>
lockVars == <<holder, started, age, queue, visible, reported>>
workflow == <<phase, inputs, configuration, checks, fresh>>
vars == <<workflow, lockVars>>
Workers == {1, 2}
AfterBaseline == {"baseline", "run", "push", "ci", "review"}
AfterRun == {"run", "push", "ci", "review"}
AfterPush == {"push", "ci", "review"}
Init == /\ phase = "edit"
        /\ headroom \in BOOLEAN /\ tools \in BOOLEAN /\ terms \in BOOLEAN
        /\ fresh \in BOOLEAN /\ override \in BOOLEAN
        /\ config = 0 /\ lockedConfig = 0
        /\ controls = {1} /\ lockedControls = {1} /\ caps = 1 /\ history = <<>>
        /\ generation = 0 /\ inventoryAt = -1 /\ testsAt = -1
        /\ registered = FALSE /\ lastChange = "none"
        /\ holder = 0 /\ started = 0 /\ age = 0
        /\ queue = <<>> /\ visible = {} /\ reported = {}
Baseline == /\ phase = "edit" /\ phase' = "baseline"
            /\ lockedConfig' = config /\ lockedControls' = controls
            /\ UNCHANGED <<inputs, config, controls, caps, history, checks, fresh, lockVars>>
EditConfig == /\ config < 2
              /\ (phase = "edit" \/ (phase = "baseline" /\ Disabled = 4))
              /\ config' = config + 1
              /\ UNCHANGED <<phase, inputs, lockedConfig, controls, lockedControls,
                             caps, history, checks, fresh, lockVars>>
AddContract == /\ phase = "baseline" /\ controls = {1} /\ config < 2
               /\ controls' = {1, 2} /\ config' = config + 1
               /\ UNCHANGED <<phase, inputs, lockedConfig, lockedControls, caps,
                              history, checks, fresh, lockVars>>
AddTestInput == /\ phase = "baseline" /\ 3 \notin controls /\ config < 2
                /\ controls' = controls \cup {3} /\ config' = config + 1
                /\ UNCHANGED <<phase, inputs, lockedConfig, lockedControls, caps,
                               history, checks, fresh, lockVars>>
RemoveTestInput == /\ phase = "baseline" /\ Disabled = 18 /\ 3 \in lockedControls
                   /\ controls' = controls \ {3}
                   /\ UNCHANGED <<phase, inputs, config, lockedConfig, lockedControls,
                                  caps, history, checks, fresh, lockVars>>
Refresh == /\ phase = "baseline" /\ config # lockedConfig /\ Len(history) < 2
           /\ lockedControls \subseteq controls /\ caps = 1
           /\ lockedConfig' = config /\ lockedControls' = controls
           /\ history' = Append(history, [old |-> lockedControls, new |-> controls,
                                          proven |-> Disabled # 12 /\ ~(Disabled = 17 /\ 3 \in controls),
                                          reason |-> Disabled # 12])
           /\ UNCHANGED <<phase, inputs, config, controls, caps, checks, fresh, lockVars>>
RemoveContract == /\ phase = "baseline" /\ Disabled = 11 /\ controls # {}
                  /\ controls' = {}
                  /\ UNCHANGED <<phase, inputs, config, lockedConfig, lockedControls,
                                 caps, history, checks, fresh, lockVars>>
EditCap == /\ phase = "baseline" /\ Disabled = 13 /\ caps = 1 /\ caps' = 2
           /\ UNCHANGED <<phase, inputs, config, lockedConfig, controls,
                          lockedControls, history, checks, fresh, lockVars>>
Run == /\ phase = "baseline"
       /\ (headroom \/ Disabled = 1) /\ (tools \/ Disabled = 2)
       /\ (terms \/ Disabled = 3)
       /\ (config = lockedConfig \/ Disabled = 4)
       /\ phase' = "run"
       /\ UNCHANGED <<inputs, configuration, checks, fresh, lockVars>>
Register == /\ ~registered /\ registered' = TRUE
            /\ UNCHANGED <<phase, inputs, configuration, generation, inventoryAt,
                           testsAt, lastChange, fresh, lockVars>>
CheckInventory == /\ registered /\ inventoryAt # generation
                  /\ inventoryAt' = generation
                  /\ UNCHANGED <<phase, inputs, configuration, generation, testsAt,
                                 registered, lastChange, fresh, lockVars>>
CheckImplementation == /\ phase = "run" /\ testsAt # generation
                       /\ testsAt' = generation
                       /\ UNCHANGED <<phase, inputs, configuration, generation,
                                      inventoryAt, registered, lastChange, fresh, lockVars>>
\* A main merge or newly added model invalidates prior inventory and test samples.
\* Targeted controls first require an already-checked old head, avoiding a
\* counterexample that merely skips every check from the initial state.
NewRequirements(kind) ==
    /\ generation = 0 /\ phase # "review"
    /\ (Disabled \in {14, 15, 16} => inventoryAt = generation /\ testsAt = generation)
    /\ generation' = 1 /\ registered' = FALSE /\ lastChange' = kind
    /\ phase' = "baseline" /\ fresh' = FALSE
    /\ UNCHANGED <<inputs, configuration, inventoryAt, testsAt, lockVars>>
MergeMain == NewRequirements("merge")
AddModel == NewRequirements("model")
CatchUp == /\ ~fresh /\ fresh' = TRUE
           /\ UNCHANGED <<phase, inputs, configuration, checks, lockVars>>
Advance(from, to) == /\ phase = from /\ phase' = to
                     /\ UNCHANGED <<inputs, configuration, checks, fresh, lockVars>>
Push == /\ ((registered /\ inventoryAt = generation) \/ Disabled = 9
             \/ (Disabled = 14 /\ lastChange = "merge")
             \/ (Disabled = 15 /\ lastChange = "model"))
        /\ (testsAt = generation \/ Disabled = 10
             \/ (Disabled = 16 /\ lastChange = "merge"))
        /\ Advance("run", "push")
Review == /\ (fresh \/ Disabled = 5 \/ (Disabled = 7 /\ override))
          /\ Advance("ci", "review")
\* Separate slots never enter the shared queue. A functioning timeout supervisor
\* is assumed; this safety model does not prove OS kill delivery or fairness.
Enqueue(w) == /\ ~Separate /\ w # holder /\ w \notin visible
              /\ w \notin {queue[i] : i \in 1..Len(queue)}
              /\ queue' = Append(queue, w)
              /\ visible' = IF Disabled = 6 THEN visible ELSE visible \cup {w}
              /\ reported' = IF Disabled = 6 THEN reported ELSE reported \cup {w}
              /\ UNCHANGED <<workflow, holder, started, age>>
Acquire == /\ holder = 0 /\ Len(queue) > 0
           /\ holder' = Head(queue) /\ queue' = Tail(queue)
           /\ visible' = visible \ {Head(queue)}
           /\ reported' = reported \ {Head(queue)}
           /\ started' = 1 /\ age' = 0 /\ UNCHANGED workflow
Tick == /\ holder # 0 /\ age < MaxRuntime + 1
        /\ IF age < MaxRuntime \/ Disabled = 8
              THEN /\ age' = age + 1 /\ UNCHANGED <<holder, started>>
              ELSE /\ holder' = 0 /\ started' = 0 /\ age' = 0
        /\ UNCHANGED <<workflow, queue, visible, reported>>
Release == /\ holder # 0 /\ holder' = 0 /\ started' = 0 /\ age' = 0
           /\ UNCHANGED <<workflow, queue, visible, reported>>
Next == Baseline \/ EditConfig \/ AddContract \/ AddTestInput \/ RemoveTestInput
        \/ Refresh \/ RemoveContract \/ EditCap
        \/ Run \/ Register \/ CheckInventory \/ CheckImplementation \/ MergeMain
        \/ AddModel \/ CatchUp \/ Push \/ Advance("push", "ci") \/ Review
        \/ (\E w \in Workers : Enqueue(w)) \/ Acquire \/ Tick \/ Release
Spec == Init /\ [][Next]_vars
NoRunWithoutCapHeadroom == phase \in AfterRun => headroom
NoGateWithMissingTool == phase \in AfterRun => tools
NoAddedBannedTermAnywhere == phase \in AfterRun => terms
NoConfigChangeAfterLock ==
    /\ 1 \in controls /\ caps = 1 /\ lockedControls \subseteq controls
    /\ (phase \in AfterRun => config = lockedConfig /\ controls = lockedControls)
    /\ \A i \in 1..Len(history) : history[i].old \subseteq history[i].new
          /\ history[i].proven /\ history[i].reason
StaleNeverReviewed == phase = "review" => fresh
VisibleBoundedLock ==
    /\ visible = {queue[i] : i \in 1..Len(queue)} /\ reported = visible
    /\ Len(queue) = Cardinality(visible) /\ holder \notin visible
    /\ (holder # 0 => started = 1 /\ age <= MaxRuntime)
    /\ (Separate => holder = 0 /\ queue = <<>>)
NoPushedUnregisteredModel == phase \in AfterPush => registered /\ inventoryAt = generation
NoPushWithoutCurrentImplementationTests == phase \in AfterPush => testsAt = generation
=============================================================================
