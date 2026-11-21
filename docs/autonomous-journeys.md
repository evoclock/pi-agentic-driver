# Autonomous journeys

This is the archived 3.1.8 description, retained to explain the cast, stuck-agent handling and morning report. It is not the 3.2.0 tool contract: no hidden autonomy or automatic replacement is promised by `agentic_worker_dispatch`.


Dispatch a worker journey that runs end to end while you are away. The
journey proceeds through steps without pausing for confirmation, replaces
agents that get stuck, and records everything in one report you read when
you come back.

Autonomy is entered by your words alone. Say "run these overnight end to
end" or "don't wait for me" and the journey runs in autonomous mode. Say
"do these two things" and it runs in the normal mode, pausing for you
between steps. The mode is recorded in the report either way.

`agentic_worker_dispatch` observes coordinator session tasks through a
read-only task store; dispatch no longer fails for lack of that store.

[304 more lines in file. Use offset=801 to continue.]Interactive steps require native confirmation. Autonomous journeys follow
the session's existing autonomy semantics. Board cards in canonical
`TASKS.md` are assigned by Board Pulse and `agentic_kanban_board_dispatch`,
which own the route evidence needed for claims and envelopes. The session
journey never claims board cards.

### The cast

You name the agents for the journey, and that list becomes the standing
permission. If the implementer gets stuck at 3am, a replacement spawns
automatically: same role, same model, both in the list you authorized.
If a task needs an agent you didn't name, the attempt is recorded and that
thread stops. Nothing outside your list can appear while you sleep.

The cast is frozen at dispatch and never grows. It can only shrink in
practice (roles finishing their work), never widen.

### When agents get stuck

A stuck agent doesn't block the journey. The journey detects the stall,
spawns a replacement from the cast, and the replacement starts with a
mandatory gap analysis: read the task spec, inspect the repository, consult
the journey history, and state what remains before resuming. The replacement
must show that the remaining work is smaller than what its predecessor left.
If it can't, the journey stops that role and continues with the others.

### The morning report

One block tells you what happened: the terminal state, each step's outcome,
every replacement with its gap analysis and progress judgment, and any
denials. Every claim is tied to a receipt or a report excerpt. No prose
narrative to reconstruct; you read the report and know exactly where things
stand.

For current behavior, use guarded spawn and scoped worker abort. A queued brief and a stall observation do not establish completion or authorize a replacement.
