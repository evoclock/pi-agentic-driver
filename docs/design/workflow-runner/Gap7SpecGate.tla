--------------------------- MODULE Gap7SpecGate ---------------------------
\* G7 spec-first gate. PAD invokes the statechart skill; it adds no
\* generator and no second path. The skill workflow is how SPEC.tla
\* and the cfg are written (the reader's agreed rules as INVARIANTs).
\* G7 then runs scripts/statechart SPEC.tla --config --view --out at
\* the pinned revision: TLC must pass the safe cfg and each unsafe
\* cfg must break its named rule, and the command emits chart.mmd.
\* Dispatch stays closed until a human has confirmed the current
\* chart digest. If that digest changes, the run parks for
\* confirmation again. Invariant checking is mandatory in every run:
\* by default it happens in G8 (each invariant mapped to tests). It
\* also runs here, before dispatch, when the instruction says so.
EXTENDS Naturals
CONSTANTS GateGuard, CompleteGuard, DigestGuard, DeriveGuard,
          ConfirmGuard, ChartGuard, EarlyCheckGuard
VARIABLES specDigest, verdict, checkedDigest, checks, dispatched,
          verdictAtDispatch, checkedAtDispatch, specAtDispatch, stackFrom,
          chartDigest, confirmedDigest, confirmedAtDispatch, chartAtDispatch,
          earlyOk, earlyAtDispatch
vars == <<specDigest, verdict, checkedDigest, checks, dispatched,
          verdictAtDispatch, checkedAtDispatch, specAtDispatch, stackFrom,
          chartDigest, confirmedDigest, confirmedAtDispatch, chartAtDispatch,
          earlyOk, earlyAtDispatch>>
Verdicts == {"none", "pass", "counterexample", "incomplete"}
Accepted == verdict = "pass" \/ (~CompleteGuard /\ verdict = "incomplete")
GateOpen == ~GateGuard \/
  (specDigest # 0 /\ Accepted
   /\ (~DigestGuard \/ checkedDigest = specDigest)
   /\ (~ConfirmGuard \/ confirmedDigest # 0)
   /\ (~ChartGuard \/ confirmedDigest = chartDigest \/ confirmedDigest = 0)
   /\ (~EarlyCheckGuard \/ earlyOk))
Init == /\ specDigest \in {0, 1} /\ verdict = "none" /\ checkedDigest = 0
        /\ checks = 0 /\ dispatched = FALSE /\ verdictAtDispatch = "none"
        /\ checkedAtDispatch = 0 /\ specAtDispatch = 0 /\ stackFrom = 0
        /\ chartDigest = 0 /\ confirmedDigest = 0
        /\ confirmedAtDispatch = 0 /\ chartAtDispatch = 0
        /\ earlyOk \in BOOLEAN /\ earlyAtDispatch = FALSE
\* The pinned SPEC.tla, cfg, or view is added or edited.
Edit == /\ specDigest < 2 /\ ~dispatched
        /\ specDigest' = specDigest + 1
        /\ UNCHANGED <<verdict, checkedDigest, checks, dispatched,
                       verdictAtDispatch, checkedAtDispatch, specAtDispatch,
                       stackFrom, chartDigest, confirmedDigest,
                       confirmedAtDispatch, chartAtDispatch, earlyOk,
                       earlyAtDispatch>>
\* Invoke the statechart skill on the current pinned bytes. A finished
\* run (safe cfg clean or an unsafe cfg that breaks a named rule)
\* produces a chart digest of the spec that was run.
RunSkill == /\ specDigest # 0 /\ checks < 3 /\ ~dispatched
            /\ \E o \in {"pass", "counterexample", "incomplete"}:
                 /\ verdict' = o
                 /\ chartDigest' = specDigest
            /\ checkedDigest' = specDigest /\ checks' = checks + 1
            /\ UNCHANGED <<specDigest, dispatched, verdictAtDispatch,
                           checkedAtDispatch, specAtDispatch, stackFrom,
                           confirmedDigest, confirmedAtDispatch,
                           chartAtDispatch, earlyOk, earlyAtDispatch>>
\* A human confirms the current chart (the pinned digest in spec.json).
Confirm == /\ ~dispatched /\ chartDigest # 0
           /\ confirmedDigest' = chartDigest
           /\ UNCHANGED <<specDigest, verdict, checkedDigest, checks,
                          dispatched, verdictAtDispatch, checkedAtDispatch,
                          specAtDispatch, stackFrom, chartDigest,
                          confirmedAtDispatch, chartAtDispatch, earlyOk,
                          earlyAtDispatch>>
\* Invariant tests required in G7 by the instruction have passed.
EarlyPass == /\ ~dispatched /\ ~earlyOk
             /\ earlyOk' = TRUE
             /\ UNCHANGED <<specDigest, verdict, checkedDigest, checks,
                            dispatched, verdictAtDispatch, checkedAtDispatch,
                            specAtDispatch, stackFrom, chartDigest,
                            confirmedDigest, confirmedAtDispatch,
                            chartAtDispatch, earlyAtDispatch>>
Dispatch == /\ ~dispatched /\ GateOpen
            /\ dispatched' = TRUE /\ verdictAtDispatch' = verdict
            /\ checkedAtDispatch' = checkedDigest /\ specAtDispatch' = specDigest
            /\ stackFrom' \in IF DeriveGuard THEN {checkedDigest} ELSE {0, 1, 2}
            /\ confirmedAtDispatch' = confirmedDigest
            /\ chartAtDispatch' = chartDigest
            /\ earlyAtDispatch' = earlyOk
            /\ UNCHANGED <<specDigest, verdict, checkedDigest, checks,
                           chartDigest, confirmedDigest, earlyOk>>
Next == Edit \/ RunSkill \/ Confirm \/ EarlyPass \/ Dispatch \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ specDigest \in 0..2 /\ verdict \in Verdicts /\ checkedDigest \in 0..2
          /\ checks \in 0..3 /\ dispatched \in BOOLEAN /\ verdictAtDispatch \in Verdicts
          /\ checkedAtDispatch \in 0..2 /\ specAtDispatch \in 0..2 /\ stackFrom \in 0..2
          /\ chartDigest \in 0..2 /\ confirmedDigest \in 0..2
          /\ confirmedAtDispatch \in 0..2 /\ chartAtDispatch \in 0..2
          /\ earlyOk \in BOOLEAN /\ earlyAtDispatch \in BOOLEAN
NoDispatchWithoutCheckedSpec == dispatched => checkedAtDispatch # 0
NoDispatchOnUnprovenSpec == dispatched => verdictAtDispatch = "pass"
NoStaleSpecDispatch == dispatched => checkedAtDispatch = specAtDispatch
DispatchUsesCheckedStack == dispatched => stackFrom = checkedAtDispatch
NoDispatchWithoutConfirmedChart == dispatched => confirmedAtDispatch # 0
NoStaleChartDispatch ==
  dispatched /\ confirmedAtDispatch # 0 => confirmedAtDispatch = chartAtDispatch
NoDispatchWithoutEarlyChecks == dispatched => earlyAtDispatch
=============================================================================
