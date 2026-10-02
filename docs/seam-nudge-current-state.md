# SEAM/NUDGE reconciliation and restart reference

**As of:** driver `origin/main` `5244e49` (PR #105), 2026-10-02. **Status:** #40 unfinished; N1 unavailable; recovery not activated. This document preserves the actionable findings of `GLM53FLASH_SEAM_AUDIT_40_v1` (2026-09-26, audit base `9011163`) **and** work and failures discovered since. The audit was read-only, before PRs #100–104. Its historical statements are not current-state assertions. Recheck main and upstream capabilities before implementing. The ratified design is the local-only `.private-planning/SPEC_TASK43_NUDGE.md` v3.4 (design, not proof of implementation); `.private-planning/TASKLIST_2026-09-26.md` contains the older task ordering. Neither private file should be copied into public source by accident.

## Fast status

- **Phase 1 landed:** PR #101 (`f643890`) merged the disabled NUDGE classifier, reason state, ledger, config/validation, defaults and tests, including trusted-executable capability probing. Its pure modules do not wire the journey, deliver a nudge or grant authority. PR #100 supplied the codebase inventory generator, schema and optional commit gate; the audit's “inventory absent” was true **then**, not now.
- **Phase 2 foundation landed, not Phase 2 activation:** PR #102 (`dc9e2c2`) merged a private exact-evidence store contract; PR #103 (`da6d3ac`) merged Pi-host private-root, TUI-only `/agentic-recovery-evidence` review; PR #104 (`70ee08c`) merged observational session-task capture and a sanitized driver-owned result projection. None attaches a recovery action to a verified authorization or writes journey evidence. The review UI is privacy confinement, **not identity authentication**.
- **Phase 2 journey remains:** no accepted ladder integration, SAFE extraction/frozen posture, durable unknown-delivery identity lock, complete receipt references, or authenticated source-specific recovery authorization. A local attempt was independently rejected; see below. Normal session dispatch remains operational and should not silently gain recovery authority.
- **Phase 3 N1 remains blocked:** installed Herdr 0.9.1 does not provide a dedicated `herdr agent nudge`. `prompt` and `send-keys` are not substitutes. We opened [Herdr Ideas discussion #4848](https://github.com/herdrdev/herdr/discussions/4848) with the owner's approved, signed proposal. N1 delivery is parked pending upstream response. No live nudge or recovery is authorized by this document.
- **Pre-task confirmed replacement guard landed:** PR #105 (`5244e49`) refuses the confirmed-default replacement prompt/spawn when pulse fails before task selection, preserving autonomous and post-task legacy routes. This closes one unsafe path, **not** SAFE replacement or N1.
- **Follow-on:** #47 worker-delivery reliability closes against the reconciled journey, not the rejected branch. #65 Pulse verification, a missed Vogelkop dev TS-baseline promotion, and the paused 1.0.0 release are separate tracks. Release cutoff is owner-selected when work resumes; no automatic release after #40.

## Historical audit: ancestry and exclusions

The 2026-09-26 audit found `merge-base(nudge-recovery, main)`, `merge-base(seam-v3, main)`, and `merge-base(nudge-recovery, seam-v3)` all at `b2d7e51` (v0.9.3). Neither sibling is an ancestor of the other or current main. The former held two unique hardening commits and the latter 19 commits, including unrelated TASK33 Jev gate and older unified-tasks work. The audit's lease was a clean detached worktree at `9011163`; it ran offline tests in a scratch clone, not live dispatch. Its inventory-absence finding predates PR #100. **Never wholesale-merge either branch.**

| Historical branch material | Current treatment |
|---|---|
| `nudge_*_pi.js`, disabled defaults and unit tests | Reconciled, ported and merged by PR #101. Includes `nudge-recovery` strict reason-code and config/classifier taxonomy hardening, with the trusted probe fix. Do not re-port duplicates. |
| `seam-v3` session-task core/tests | Do not overwrite main's newer task promotion and provenance. The audit identified older `d0bbfda` versus main's `bac278c` after PR #84; PR #104 adds further provenance. `tasks-unified-v1` @ `aa15c9f` was a separate follow-up, not a #40 merge payload. |
| `seam-v3` communication rewrite | Do not overwrite PR #99's newer async prompt/delivery receipt contract (`2f7297b`). |
| TASK33 Jev gate/router, branch README/PROVENANCE/package variants/extensions/tasks.ts | Out of #40 scope; no incidental merge. Jev may later select optional readable context but must not erase exact evidence or decide authority. |
| Branch journey ladder and replacement | Historical behavioral examples and tests only; reconcile with current main's session journey, dispatch/communication contracts and existing replacement behavior. |

## Audit behavior inventory, reconciled item by item

“Module exists” means no journey wiring. “Partial” is not permission to run recovery. Historical file/line references below belong to the audit's `seam-v3`/`nudge-recovery` snapshot; they can drift.

| Audit item / spec | What the audit established at `9011163` | State at `70ee08c`; required evidence before calling it complete |
|---|---|---|
| **N1, §3.1:** modal-isolated nudge, `delivered | rejected-before-delivery | unknown` | Branch had a fail-closed `nudge_transport_unavailable` stub and probe; Herdr 0.9.1 had no `agent nudge`. Branch dispatch-seam tests (24) checked rejected-before-delivery. | Probe/config are merged, N1 still upstream-blocked. Require dedicated framed channel, stable machine-readable receipt, modal-isolation/race tests and driver transport tests. Never route through prompt or terminal keys. |
| **N2, §3.3:** no prompt relaxation/raw send-keys | Both audit main and branches avoided driver send-keys; branch ladder rejected shortcuts. | Preserve prohibition. `test_public_extension_set.mjs` is a surface check, not proof of N1 delivery. |
| **N3, §2/§5:** total ordered state classifier and stuck reasons | Branch classifier handled complete, gone, blocked, working, stalled/unknown, idle, done-without-report; historical classifier tests 17 passed. Main only classified limited dispatch eligibility. | `nudge_classifier_pi.js` merged and unit-tested; `runWorkerJourney` does **not** consume it per poll. Preserve complete/gone precedence, malformed observation errors and one classification per poll when wiring. |
| **4, §5.1–5.2:** nonrepeating messages/reason state | Branch computed distinct attempt messages/hashes; strict reason-code validation was a `nudge-recovery` fix. Historical reason-state tests 10 and ledger tests 26–29 passed. | Reason-state/ledger modules merged; no journey-issued nudge, varied message progression or action persistence. A new nudge requires new evidence/content, never a byte-identical resend of uncertain delivery. |
| **5, §7:** exact config, caps, probe/operational validation | `seam-v3` used a capability probe, `nudge-recovery` an owner-facing `--upstream-capability-verified` flag; probe branch had 23 config tests versus 20. | PR #101 chose trusted-executable probe plus strict taxonomy hardening and disabled defaults. The audit's *variant choice* is resolved for Phase 1; actual upstream availability is not. A positive flag alone is not a capability. |
| **6, §2:** ready/blocked/stalled observed per poll | Branch tracked sequence freeze and natural thresholds; branch async-dispatch tests (30) included threshold/freeze cases. Main's pulse had only ready/blocked eligibility. | Classifier code exists, but current journey does not call it as a NUDGE poll loop. Keep ordinary workerPulse behavior distinct from any new observation path. |
| **7, §6:** two-phase ledger, canonical digests, bounded revert anchor, nontruncating mandatory receipt | Branch ledger serialization would fail closed instead of main's `[WORKER_JOURNEY_REPORT_TRUNCATED]`; historical ledger tests covered recomputation and revert anchor. | Ledger module and private exact-evidence store exist. **No journey ledger writes or references yet.** A requested pre-entry must persist before action. Do not blanket-replace legacy receipt truncation without a reviewed compatibility decision; mandatory recovery references must survive intact. |
| **8, §8:** unknown-delivery single-identity lock | Branch retained an in-journey lock; PR #99 main had async receipt states but no journey identity lock. | Still needs durable, lifecycle-aware cross-journey lock; failed terminal persistence is ambiguous, not permission to resend. The process-local async receipt store does not itself meet this requirement. |
| **9, §5.2–5.3:** SAFE extraction and contained frozen replacement | Branch had `assessSafeExtraction` and frozen-posture checks; main had a different progress-credited gap-analysis replacement. Historical extraction tests ran but did not prove compatibility on main. | Not accepted or integrated. Must prove snapshot schema, attribution, exclusive write transfer, frozen scope/autonomy/containment and exact **sent** replacement brief; reject UNSAFE or unattributable state. Do not stack two replacement philosophies. |
| **10, §5.3–5.4:** N+1 repeated-reason systemic park and demonstrated futility | Branch had loop-over-futility precedence and tests. | Reason-state primitives exist but journey park/futility wiring is missing. Preserve precedence and evidence if integrated. |
| **11, §2/§8:** submit once, read-only poll, no resend, identity lock | Branch had its own engine; main journey remained blocking per step despite PR #99 transport receipt plumbing. Highest-risk engine conflict in audit. | Still unresolved on current main. Adapt to PR #99's submit/poll/read semantics, not old branch communication. Delivery state must not be inferred from timeout, idle or worker-authored prose. |
| **12, §3.2:** one-time upstream brief | Skeleton existed in spec but no standalone approved artifact. | Still requires a bounded brief and owner's approval **before** sending to maintainers. N1 integration waits for upstream capability and acceptance fixtures. |

Audit test numbers are **historical offline evidence**, not proof that these behavior rows run in today's journey. The PR #104 whole-branch review and coordinator's 93 focused tests covered session provenance and dispatch regression, not end-to-end NUDGE recovery.

## Newer contract and rejection findings (not in the original audit)

### Evidence ownership and pre-entry rule

Driver owns the ledger/store/digest format; hosts supply private roots and a review route. `docs/recovery-evidence-store.md` defines exact requested and terminal records, verification of SHA-256/size/identity/predecessor, quota refusal rather than eviction, and the limits of hashes. A pointer is a retrieval/integrity reference, **not** authorization, delivery confirmation or a tamper-proof signature. The owner accepted the rule that a **new evidence-backed action stops if its requested pre-entry cannot be saved**. After an action, failure to persist a terminal record leaves ambiguous delivery: retain lock and do not blindly retry. No evidence deletion/retention policy is approved yet; store-full blocks new recovery actions until review. `scripts/enforcement/recovery_evidence_review_pi.js` provides private TUI reading, not identity authentication.

### Rejected journey branch: preserve review evidence, not code authority

The local unpushed `feat/recovery-journey-ledger` history (`3f7f6eb`, `62c05eb`, `3f064d0`, `a835c37`) must not be described as merged or auditable recovery. Independent review found: initial actions despite failed prewrites; an unsent spawn brief recorded as sent; invented direct authorization for session/board work; no durable cross-journey lock; changed report overflow semantics; and unproven SAFE extraction/frozen posture. Later local fixes narrowly addressed prewrite failure and ultimately refused unattestable evidence-backed handoff, without solving authorization or the remaining hazards. “Legacy unchanged” was also overstated: no-root replacement prompt gained timestamp/journey ID. Do not keep layering fixes on this branch; start future slices at main and retain history for comparison.

### Provenance is observation, not permission

PR #104 captures session task content locally for drift checks; task-list environment override mismatches are reported, not silently attributed to the host session. Coordinator-facing driver-owned identity fields use `taskDisplayId` (SHA-256 display pseudonym), including steps, progress and receipt identity. This **breaks** the earlier raw `taskId` result fields, as detailed in `docs/worker-dispatch-evidence-contract.md`. The full capture remains local; raw ID/subject still reach the worker prompt for `TaskGet`. Worker-authored `report`, `error`, `gapAnalysis` and the report portion of a marked receipt can echo private task content verbatim. Tokens are deterministic and guessable; neither display IDs nor capture digests confer secrecy or authority. There is no new confirmation required to observe provenance.

### Authority boundaries discovered after the audit

The spec speaks of original direct instruction, session task or board claim/envelope as authority, but it does **not** prove that current journey code has frozen, verified, source-specific authorization for every route. Session tasks are mutable working memory writable within a session; their capture/hash cannot approve recovery. Trusted board `TaskPromote` and claim/envelope have separate owner-confirmed/writer verification boundaries; board claim and session journey are not yet a connected authorization path. Independent Zai review rejected a second recovery-admission envelope: reuse existing trusted boundaries rather than mint parallel authority. This does **not** mean all session tasks must be promoted or that a board claim magically authorizes recovery. For each journey source, trace the actual frozen scope, operation classes, autonomy/containment posture and revalidation point; **if absent, stop recovery** while ordinary dispatch continues as before. A bridge is a possible outcome of this trace, not an assumed next feature.

## Decisions, unresolved choices and stopping rules

| Topic from audit §6 / later review | Current standing |
|---|---|
| Config variant | Phase 1 merged trusted capability probing and strict taxonomy, disabled by default. No owner-facing bypass flag substitutes for real upstream probe. |
| Receipt truncation | Audit recommended global fail-closed throw. **Not accepted as a blanket change.** Mandatory recovery references cannot truncate; preserve unrelated legacy contract unless owner explicitly accepts a change. Exact evidence lives in private store. |
| Replacement semantics | Spec favors SAFE extraction and frozen contained replacement over unconstrained progress-credit replacement. No approved journey implementation yet; retain main's normal legacy behavior until a reviewed reconciliation. |
| Engine direction | PR #99 async receipt plumbing is the baseline; Phase 2 requires a reviewed journey-level submit/read-only-poll and lock. #47 closure follows verified behavior. No wholesale branch engine import. |
| Authority | No second admission store, no hash-as-authorization, no automatic promotion of all session tasks. Read-only source map first; owner chooses only an actually missing route. |
| Upstream brief / N1 | Brief approval and proven modal isolation still pending; no `prompt`/`send-keys` fallback. |
| `tasks-unified-v1` @ `aa15c9f` | Separate review if still needed against current main, never incidental to #40. |
| Release / host work | 1.0.0 remains paused until owner resumes and sets cutoff; no tag/install/build/publication. #65 verification and Vogelkop dev baseline are separate. |

**Next bounded action:** produce a read-only, file-and-function-backed map for **each actual** journey source from origin through verified authority, scope and lifecycle revalidation. Mark unknowns explicitly. Then choose the smallest Phase 2 slice that can be safely authorized. Do not revive rejected code, perform live recovery, send upstream brief, merge or publish on the strength of this document.

## Upstream Herdr discussion and possible resolutions

**Public proposal:** [Send guidance to blocked agents without answering dialogs, Herdr Ideas #4848](https://github.com/herdrdev/herdr/discussions/4848), posted with the owner's approval and signed “Cheers, Julen.” It requests a dedicated agent-message operation independent of terminal input, `delivered | rejected-before-delivery | unknown` outcomes, blocked-dialog isolation, explicit prompt races and adversarial tests. The message says Julen can help test if needed. There is **no commitment from Herdr yet**; check the discussion for a reply before acting.

Herdr 0.9.1 docs (`docs/next/website/src/content/docs/agent-automation.mdx`) say `agent prompt` submits terminal text plus Enter and rejects an agent already classified `blocked`; `agent send-keys` is interactive UI input. In upstream `src/app/api/agents.rs`, `queue_agent_prompt` checks `Blocked` then queues input through the PTY. Herdr [#2788](https://github.com/herdrdev/herdr/issues/2788) documented dialog-answer risk, fixed for detected blocked agents by [PR #2790](https://github.com/herdrdev/herdr/pull/2790). [Open issue #4641](https://github.com/herdrdev/herdr/issues/4641) documents a residual unknown-state dialog hazard. [Issue #4823](https://github.com/herdrdev/herdr/issues/4823) proposed a delivery hook for custom agents and was closed with direction to use Ideas; it is adjacent, not N1. A search of issues and PRs found no dedicated N1 implementation. A read-only v0.9.1 checkout exists at `scratch/herdr-readonly` in the local driver checkout; no Herdr code was edited or installed.

| Herdr response | Next decision, not automatic action |
|---|---|
| Maintainers support the contract and invite a contribution | With owner approval, use a dedicated Herdr fork/worktree to implement and independently review an agent-native isolated channel and delivery envelope. Test working and blocked agents, adversarial modal text, unknown delivery, ordering and capability probing. Do not publish/merge/install without the applicable owner gates. Then integrate driver N1 with disabled defaults until proven. |
| Maintainers intend to implement it | Track their issue/PR and wait for a reviewed release plus compatibility tests before enabling the driver. No `prompt`/`send-keys` workaround. |
| Maintainers reject a generic channel or recommend a specific agent integration | Assess a separately reviewed agent-native channel per supported agent, with the same modal isolation and delivery semantics; unsupported agent/host combinations reject before delivery. Ask owner whether to invest in that narrower route. |
| No reply yet | N1 remains parked. Offline classifier/ledger tests remain valid; do not repeatedly build replacement or journey facades to simulate live nudge availability. |

## Branch and worktree register (local-only, check before cleanup)

| Branch or location | Status / instruction |
|---|---|
| `docs/seam-nudge-current-reference` (Treehouse evidence `/1`) | This reference, rebased on PR #105; **local and unpushed**. Original audit structured archival transcription at `.private-planning/GLM53FLASH_SEAM_AUDIT_40_v1.md` in the real checkout is git-ignored and contains the full historical tables. |
| `docs/selected-task-journey-contract` (Treehouse evidence `/7`, `cff24c6`) | Local proposed selected-task submit/observe contract, **not delivered**. Keep only as design/review evidence; its launch gate is NO. |
| `feat/recovery-journey-ledger` (`3f7f6eb`, `62c05eb`, `3f064d0`, `a835c37`) | **Rejected, unpushed.** Do not merge or extend; review evidence only. |
| `feat/confirmed-recovery-replacement` (`a0ee228`, Treehouse evidence `/2`) | **Rejected, unpushed.** Unwired injected gate did not establish trusted authority, SAFE extraction or lock. |
| `feat/durable-identity-lock` (`20f0ad2`, `ab75ce0`, Treehouse evidence `/4`) | **Rejected, unpushed.** Journey-entry key is not cross-journey task identity; ambiguous release hazards remained. |
| `zai-selected-task-journey` (`956335a`, `3efcfa3`) | **Unpushed; unsafe original commit remains in local history.** Sol removed the feature; net diff is only refusal test and inventory. Do not push this history or claim a feature. |
| `feat/selected-task-trusted-boundary` (Treehouse evidence `/8`, at main) | Empty exploratory branch after Sol proved existing evidence-root environment resolver alone is not a trusted model-facing storage binding. No candidate implementation. |
| `seam-v3`, `nudge-recovery` | Old divergent siblings from v0.9.3; prior-art only, never wholesale merge. |
| Driver `origin/main` | PRs #100–105 merged. PR #105 stops confirmed replacement before task selection. No Phase 2 journey recovery activated. |

Some listed worktrees remain leased to their historical roles; **do not destroy rejected worktrees without preserving review evidence or checking dirty state**. The main checkout has unrelated dirty changes and a git-ignored private-planning directory; preserve them. Release 1.0.0 remains owner-paused, README draft remains uncommitted in its separate driver worktree, and this handover does not change those gates.

## Where to verify before continuing

- Design: local-only `.private-planning/SPEC_TASK43_NUDGE.md` v3.4 §§2–9; historical `GLM53FLASH_SEAM_AUDIT_40_v1` report in the task conversation; older ordering `.private-planning/TASKLIST_2026-09-26.md`. The audit's line numbers and codebase inventory absence are **not** current.
- NUDGE primitives: `scripts/enforcement/nudge_{classifier,reason_state,ledger,config,validate}_pi.js`, `.agentic-driver/nudge.defaults.json`, `tests/test_nudge_*.mjs` (PR #101).
- Current journey/transport: `scripts/enforcement/herdr_async_dispatch_pi.js`, `herdr_async_seam_pi.js`, `herdr_communication_pi.js`, `extensions/herdr-dispatch.ts`; `tests/test_herdr_async_{dispatch,seam}.mjs` and `tests/test_herdr_communication.mjs`.
- Evidence: `scripts/enforcement/recovery_evidence_store_pi.js`, `recovery_evidence_review_pi.js`, `docs/recovery-evidence-store.md`, `tests/test_recovery_evidence_{store,review}.mjs` (PRs #102–103).
- Provenance and claims: `extensions/task-store-adapter.ts`, `scripts/enforcement/session_tasks_core_pi.js`, `task_board_core_pi.js`, `docs/worker-dispatch-evidence-contract.md`, `tests/test_task_store_adapter.mjs` and `tests/test_board_claim_bridge.mjs` (PR #104 plus earlier board work). Compare to live `origin/main` before relying on this snapshot.
