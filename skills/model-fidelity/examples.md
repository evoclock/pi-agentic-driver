# Worked cases for the first-slice CLI

These examples are caller-owned workflow steps, not checker proofs. External bot and External bot can invoke the same local process with stdin closed. They read the JSON result and branch on exit code, `status`, `findings`, and `diagrams`. No prompt, worker, or hidden interaction is required.

## Protocol: build despite an unproven step

Put a valid `model-fidelity.plan.v1` in `plans/original.json` with `currentGenerationRule` saying that an old clearance cannot affect a replacement. Declare `ApplyClearedEffect` in a `model-fidelity.design.v1` and list the design and its local model/config dependencies in `designRefs`. If the action has no supported action map, `prepare` returns `missing-action-map` for that ID. The caller also records `unproven-all-at-once-step` when the model collapses an observation and later effect without evidence that reassignment cannot occur between them. This last finding is a caller assessment, **not** a diagnosis emitted by today's CLI.

Request `requests/prepare.json`:

```json
{"schema":"model-fidelity.request.v1","requestId":"proto-prepare-1","unitId":"proto","attemptId":"attempt-1","operation":"prepare","payload":{"mode":"protocol","planRef":"plans/original.json","designRefs":["designs/candidate.json","<caller-owned-model>","<caller-owned-safe-config>"]}}
```

Run `node scripts/model_fidelity.mjs prepare --json requests/prepare.json`. Capture the returned `planId` and `bundleId`. The built candidate and its actual test results come from the caller's ordinary workflow, not this command. For changed bytes, prepare a *new* attempt citing the frozen `planId`. Then request `diagram` with the captured bundle ID and a new request ID:

```json
{"schema":"model-fidelity.request.v1","requestId":"proto-diagram-1","unitId":"proto","attemptId":"attempt-1","operation":"diagram","payload":{"bundleId":"BUNDLE_ID"}}
```

Run `node scripts/model_fidelity.mjs diagram --json requests/diagram.json`, replacing `BUNDLE_ID` with the actual returned ID. Use `read` with `payload: {"artifactId": "VIEW_ARTIFACT_ID"}` to inspect a returned published view ID. Do not invent either ID. Lifecycle and results views may render. Action-map and fault-window are explicitly unavailable in this slice. The caller delivers the change with the missing-map and unproven-step findings, unchecked property list, absent runtime evidence and diagrams; it never calls an unimplemented `evaluate` command or claims the model passed TLC.

A supported shortcut is a generation-conditional write that checks the authoritative generation and applies the effect in the same operation, *provided every reassignment uses that authority*. Review that concrete operation and its crash behavior independently. A token remembered before an uncoordinated external write does not meet the same rule. If the evidence is missing, keep the shortcut as an assumption and deliver with a gap.

## Light statechart and render failure

For an ordinary screen flow, use `mode: "light"` and `designRefs: []` initially. `prepare` returns `partial`, `no-design-yet`, `continuation: "continue"`, and lifecycle/results view records. Action-map and fault-window are `not-applicable`, not silently omitted. Light mode does not assess implementation correspondence. If the renderer fails, the view record says `unavailable`, retains source/text or placeholder artifacts and emits `diagram-unavailable`; report that coverage gap and still deliver. The caller should fix the renderer in a later attempt, not suppress the finding.

For exit 2 or 3, read the single typed error object and preserve the attempt. If the process dies without JSON, mark the call interrupted and inspect stored artifacts before any new request. Neither case is a model approval gate.
