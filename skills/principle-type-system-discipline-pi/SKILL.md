---
name: principle-type-system-discipline-pi
description: For an approved typed boundary or function signature, model distinct semantic primitives and variants, parse external data once and derive owned shapes from authoritative schemas. Use explicitly before adding typed code.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Type system discipline

Adapted from Lauren Tan's **pinned live** `principle-type-system-discipline` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. The live source differs from the preserved installed body, so preserve the live brand/boundary/schema rules rather than silently substituting older examples. Compiler types help reject impossible states, mismatched primitives and unhandled variants **inside typed code**; a type is not runtime validation, containment or authorization. For TypeScript syntax consult a reviewed `typescript-best-practices-pi` only when it actually loads, not a planned command.

For an approved model or signature, give distinct semantic values distinct types: a `UserId` and `OrderId` may both be strings, but a branded intersection/newtype can prevent swapping them. Validate input at creation; downstream code may trust the typed value **only when every relevant outside caller passed the actual parser**. Treat RPC, JSON, IPC, CLI, config, environment and database rows as untyped until an explicit boundary parser validates and narrows them. Name invalid-input errors and exercise both accepted and rejected values at the actual entry; do not assume a compiler checked an external payload. If a union represents a finite set of legal variants, require an exhaustive typed decision and check that adding a variant reveals unhandled code rather than falling into a silent default.

Where a protocol buffer, OpenAPI/GraphQL schema, migration, design-token file or another reviewed artifact **owns** a shape, derive the program type from it rather than maintain a second hand-written definition. Inspect ownership, generator prior art and update path before introducing generated code; no dependency install or schema migration is granted by this principle. Prefer a domain model that eliminates redundant special-case handling, but keep load-bearing runtime guards until actual ingress parsing and caller coverage are proved. If no schema exists or a file is out of scope, name the gap rather than inventing authority or rewriting every caller.

- **Positive BDD:** Given an approved typed domain with a real external input and authoritative shape where present, when Pi brands distinct IDs, parses accepted/invalid data at entry and checks finite variants exhaustively, then mismatched semantics and new unhandled cases fail at type/test seams while real invalid input is rejected at runtime.
- **Refusal BDD:** Given unverified outside callers, absent schema ownership, no edit/parser grant or only compile-time evidence of external validation, when a guard is removed or a generated type is proposed, then leave the boundary intact, mark that step `blocked`/`unrun` and do not claim types alone protect runtime behavior.

This Pi skill is not a runtime parser test, installed generator or the Pi session session proof.
