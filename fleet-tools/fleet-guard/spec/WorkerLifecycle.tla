---------------------------- MODULE WorkerLifecycle ----------------------------
(* The life of one Grackle Pi worker, as fleet-guard.mjs drives it.             *)
(* Every guard in fleet-guard.mjs is an enabling condition of one action below  *)
(* or one invariant. The check table is in README.md.                           *)
EXTENDS Naturals

CONSTANTS
  Workers,      \* Grackle's workers (tabs labelled with a Grackle role)
  Protected,    \* the subset of Workers whose tab sits in a protected workspace
  ForeignTabs,  \* tabs owned by other bots
  Macs,
  Grant,        \* Macs whose ledger holds a spawn grant (driver authorizeApproval)
  Herdr,        \* Macs whose herdr the driver trusts
  Root          \* Macs with the repo root (~/repos/<repo> on the MacBook, ~/<repo> on the mini)

Spawnable == Grant \cap Herdr \cap Root

Phases == {"new", "leased", "spawned", "briefed", "pending", "working", "reported", "returned", "closed"}
AfterWork == {"working", "reported", "returned", "closed"}

VARIABLES
  phase,     \* lifecycle state of each worker
  host,      \* the Mac a worker was routed to
  idle,      \* the worker's agent status is idle/done
  brief,     \* "none" | "issued" | "pending" (promptSent:false, in the pending store) | "delivered"
  report,    \* "none" | "noid" (report lacks the delivery id) | "withid"
  saved,     \* the report is saved under reports/
  dirt,      \* slot state at report time: "clean" | "asgrep" (lone .asgrep/) | "dirty" (dirty, unpushed or foreign-busy)
  slot,      \* "none" | "leased" | "returned" | "kept"
  tabOpen,   \* every tab, Grackle's and foreign
  closedOn   \* the Mac whose herdr closed a worker's tab

vars == <<phase, host, idle, brief, report, saved, dirt, slot, tabOpen, closedOn>>
Tabs == Workers \cup ForeignTabs

Init ==
  /\ phase = [w \in Workers |-> "new"]
  /\ host = [w \in Workers |-> "none"]
  /\ idle = [w \in Workers |-> FALSE]
  /\ brief = [w \in Workers |-> "none"]
  /\ report = [w \in Workers |-> "none"]
  /\ saved = [w \in Workers |-> FALSE]
  /\ dirt = [w \in Workers |-> "clean"]
  /\ slot = [w \in Workers |-> "none"]
  /\ tabOpen = [t \in Tabs |-> TRUE]
  /\ closedOn = [w \in Workers |-> "none"]

\* preflight: route to a Mac where the driver can actually spawn, then lease a Treehouse slot there.
Lease(w, m) ==
  /\ phase[w] = "new" /\ m \in Spawnable
  /\ phase' = [phase EXCEPT ![w] = "leased"]
  /\ host' = [host EXCEPT ![w] = m]
  /\ slot' = [slot EXCEPT ![w] = "leased"]
  /\ UNCHANGED <<idle, brief, report, saved, dirt, tabOpen, closedOn>>

Spawn(w) ==
  /\ phase[w] = "leased"
  /\ phase' = [phase EXCEPT ![w] = "spawned"]
  /\ UNCHANGED <<host, idle, brief, report, saved, dirt, slot, tabOpen, closedOn>>

\* The agent finishes booting or its previous turn.
BecomeIdle(w) ==
  /\ phase[w] \in {"spawned", "briefed", "pending"} /\ ~idle[w]
  /\ idle' = [idle EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<phase, host, brief, report, saved, dirt, slot, tabOpen, closedOn>>

Brief(w) ==
  /\ phase[w] = "spawned"
  /\ phase' = [phase EXCEPT ![w] = "briefed"]
  /\ brief' = [brief EXCEPT ![w] = "issued"]
  /\ UNCHANGED <<host, idle, report, saved, dirt, slot, tabOpen, closedOn>>

\* submit: the driver delivers to an idle worker (promptSent:true); a busy one answers promptSent:false.
Deliver(w) ==
  /\ brief'  = [brief EXCEPT ![w] = "delivered"]
  /\ phase'  = [phase EXCEPT ![w] = "working"]
  /\ idle'   = [idle EXCEPT ![w] = FALSE]
  /\ report' = [report EXCEPT ![w] = "none"]
  /\ UNCHANGED <<host, saved, dirt, slot, tabOpen, closedOn>>

Submit(w) ==
  /\ phase[w] = "briefed"
  /\ IF idle[w]
       THEN Deliver(w)
       ELSE /\ brief' = [brief EXCEPT ![w] = "pending"]
            /\ phase' = [phase EXCEPT ![w] = "pending"]
            /\ UNCHANGED <<host, idle, report, saved, dirt, slot, tabOpen, closedOn>>

\* submit retry / --drain: only a pending brief, only once the worker is idle.
Retry(w) ==
  /\ phase[w] = "pending" /\ brief[w] = "pending" /\ idle[w]
  /\ Deliver(w)

\* The worker ends its turn with a report, which may or may not carry the delivery id.
Work(w) ==
  /\ phase[w] = "working"
  /\ \E r \in {"noid", "withid"}, d \in {"clean", "asgrep", "dirty"}:
       /\ report' = [report EXCEPT ![w] = r]
       /\ dirt' = [dirt EXCEPT ![w] = d]
  /\ phase' = [phase EXCEPT ![w] = "reported"]
  /\ idle' = [idle EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<host, brief, saved, slot, tabOpen, closedOn>>

\* finish refuses a report without the delivery id; the waiter sends a fix brief instead.
FixBrief(w) ==
  /\ phase[w] = "reported" /\ report[w] = "noid"
  /\ phase' = [phase EXCEPT ![w] = "briefed"]
  /\ brief' = [brief EXCEPT ![w] = "issued"]
  /\ UNCHANGED <<host, idle, report, saved, dirt, slot, tabOpen, closedOn>>

\* finish step 1: a done/idle worker whose report carries the delivery id gets it saved.
SaveReport(w) ==
  /\ phase[w] = "reported" /\ idle[w] /\ report[w] = "withid" /\ ~saved[w]
  /\ saved' = [saved EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<phase, host, idle, brief, report, dirt, slot, tabOpen, closedOn>>

\* finish step 2: a lone .asgrep/ is the only dirt fleet-guard removes.
RemoveAsgrep(w) ==
  /\ phase[w] = "reported" /\ saved[w] /\ dirt[w] = "asgrep"
  /\ dirt' = [dirt EXCEPT ![w] = "clean"]
  /\ UNCHANGED <<phase, host, idle, brief, report, saved, slot, tabOpen, closedOn>>

\* finish step 3: treehouse return, never --force, only a clean slot; anything else is kept.
ReturnSlot(w) ==
  /\ phase[w] = "reported" /\ saved[w] /\ report[w] = "withid" /\ dirt[w] = "clean"
  /\ slot' = [slot EXCEPT ![w] = "returned"]
  /\ phase' = [phase EXCEPT ![w] = "returned"]
  /\ UNCHANGED <<host, idle, brief, report, saved, dirt, tabOpen, closedOn>>

KeepSlot(w) ==
  /\ phase[w] = "reported" /\ saved[w] /\ report[w] = "withid" /\ dirt[w] = "dirty"
  /\ slot' = [slot EXCEPT ![w] = "kept"]
  /\ phase' = [phase EXCEPT ![w] = "returned"]
  /\ UNCHANGED <<host, idle, brief, report, saved, dirt, tabOpen, closedOn>>

\* finish step 4: herdr tab close on the Mac fleet-guard runs on, for exactly this worker's tab,
\* never in a protected workspace, never a foreign tab.
CloseTab(t, m) ==
  /\ t \in Workers /\ t \notin Protected
  /\ phase[t] = "returned" /\ tabOpen[t]
  /\ m = host[t]
  /\ tabOpen' = [tabOpen EXCEPT ![t] = FALSE]
  /\ closedOn' = [closedOn EXCEPT ![t] = m]
  /\ phase' = [phase EXCEPT ![t] = "closed"]
  /\ UNCHANGED <<host, idle, brief, report, saved, dirt, slot>>

Terminal(w) ==
  \/ phase[w] = "closed"
  \/ phase[w] = "returned" /\ w \in Protected
  \/ phase[w] = "new" /\ Spawnable = {}

Done == (\A w \in Workers : Terminal(w)) /\ UNCHANGED vars

Next ==
  \/ \E w \in Workers, m \in Macs : Lease(w, m)
  \/ \E w \in Workers : Spawn(w)
  \/ \E w \in Workers : BecomeIdle(w)
  \/ \E w \in Workers : Brief(w)
  \/ \E w \in Workers : Submit(w)
  \/ \E w \in Workers : Retry(w)
  \/ \E w \in Workers : Work(w)
  \/ \E w \in Workers : FixBrief(w)
  \/ \E w \in Workers : SaveReport(w)
  \/ \E w \in Workers : RemoveAsgrep(w)
  \/ \E w \in Workers : ReturnSlot(w)
  \/ \E w \in Workers : KeepSlot(w)
  \/ \E t \in Tabs, m \in Macs : CloseTab(t, m)
  \/ Done

Fairness ==
  /\ \A w \in Workers : WF_vars(BecomeIdle(w))
  /\ \A w \in Workers : WF_vars(Submit(w))
  /\ \A w \in Workers : WF_vars(Retry(w))

Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK ==
  /\ phase \in [Workers -> Phases]
  /\ host \in [Workers -> Macs \cup {"none"}]
  /\ idle \in [Workers -> BOOLEAN]
  /\ brief \in [Workers -> {"none", "issued", "pending", "delivered"}]
  /\ report \in [Workers -> {"none", "noid", "withid"}]
  /\ saved \in [Workers -> BOOLEAN]
  /\ dirt \in [Workers -> {"clean", "asgrep", "dirty"}]
  /\ slot \in [Workers -> {"none", "leased", "returned", "kept"}]
  /\ tabOpen \in [Tabs -> BOOLEAN]
  /\ closedOn \in [Workers -> Macs \cup {"none"}]

\* A slot is only handed back (or kept) after the worker's report is saved.
NoReturnBeforeReport == \A w \in Workers : slot[w] \in {"returned", "kept"} => saved[w]

\* A returned slot was clean: nothing was forced past dirt, unpushed commits or a foreign process.
NoForceReturn == \A w \in Workers : slot[w] = "returned" => dirt[w] = "clean"

\* Every brief is delivered or pending; nothing counts as working on a brief it never got.
BriefNeverLost == \A w \in Workers :
  /\ phase[w] \in {"briefed", "pending"} \cup AfterWork => brief[w] \in {"issued", "pending", "delivered"}
  /\ phase[w] = "pending" => brief[w] = "pending"
  /\ phase[w] \in AfterWork => brief[w] = "delivered"

\* Done means a saved report carrying the delivery id (provenance), slot handled, tab closed only after.
NoFakeDone == \A w \in Workers :
  /\ phase[w] \in {"returned", "closed"} => (saved[w] /\ report[w] = "withid")
  /\ ~tabOpen[w] => (saved[w] /\ slot[w] \in {"returned", "kept"})

\* Only Grackle's own unprotected tabs close, and only on the Mac they run on.
NoForeignClose ==
  /\ \A f \in ForeignTabs : tabOpen[f]
  /\ \A p \in Protected : tabOpen[p]
  /\ \A w \in Workers : closedOn[w] \in {"none", host[w]}

\* Spawns happen only where the driver can spawn: grant, trusted herdr, repo root.
SpawnOnlyWhereDriverCan == \A w \in Workers : phase[w] # "new" => host[w] \in Spawnable

\* Liveness: every brief is eventually delivered.
BriefEventuallyDelivered == \A w \in Workers : (brief[w] \in {"issued", "pending"}) ~> (brief[w] = "delivered")
================================================================================
