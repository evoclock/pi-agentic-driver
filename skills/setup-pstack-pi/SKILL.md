---
name: setup-pstack-pi
description: Configure and verify owner-selected Pi development and independent-review roles in one project-local map without changing Pi defaults. Use only on an explicit role-setup request.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Set up pstack roles for Pi

This P45 mapping adapts Lauren Tan's live `setup-pstack` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md` and `assets/pstack-model-roles.v1.example.json`. **This `/skill:setup-pstack-pi` is the sole packaged role-setup route.** It owns one project-local map; no previous skill, alternate writer or duplicate same-name loader is required.

The Cursor original enumerates `Task`-subagent slugs, picks `unlimited`/`large`/`medium`/`small` effort, keeps per-role model-family overrides and panels, allows `auto`/`inherit-parent`, and writes an always-applied `~/.cursor/rules/pstack-models.mdc`. Those defaults, fixed providers, alias/family fallbacks, fan-out and reasoning ladder are **not** a Pi role registry or permission to add models. The approved Pi contract has only owner-selected, distinct `development` and `independent-review` exact identities in the **project-local** `.pi/pstack-model-roles.v1.json`. Additional worker/panel roles, effort budgets and route capacity need separately chosen Pi identities and an approved extension of that contract; this port cannot silently squeeze the Cursor role list into two values or claim the budget knob works. If the owner asks about cost, show the requested task budget and available Pi reasoning controls as **choices** after verifying actual session support; do not mutate the Pi default model or rewrite a role on an assumed effort suffix.

On an explicit setup request, find the Git repository root and read its existing `.pi/pstack-model-roles.v1.json`, if present. The bundled example gives the schema only; its nulls are **not configured roles**. Ask the owner to choose or confirm exact `provider/modelId` identities for `development` and `independent-review`. Check that both identities are distinct, resolvable in the intended Pi environment (the owner's `/model` picker can help), and allowed by the task's model/data route. If availability cannot be verified, leave the role unconfigured rather than guessing.

Preview the exact before/after JSON and destination for owner approval. Only after the owner approves the contents and location, write **only** the project-local map; preserve unrelated state, unknown keys and earlier choices unless separately approved for migration. Read the result back and validate `schema: "agentic-driver.pstack-model-roles.v1"`, two nonempty exact identities and distinctness. Keep project-specific choices out of public packages. Pi does not read this map as a setting: it is data for skill role lookups, not a credential, dispatcher or execution grant. An unavailable role or model leaves dependent work blocked, with `pstack role <role> is not configured at .pi/pstack-model-roles.v1.json; run /skill:setup-pstack-pi` when the role is missing or malformed. No guessed fallback, `auto`, parent inheritance, provider install, Pi default change, independent review or worker spawn follows from this file.

After successful setup, report only what was configured, actually verified and still unsupported; the new choices apply only to future role lookups, not to a running agent automatically. If a project-local real app verifier is absent, an approved loaded `create-verification-skill-pi` can be offered **once**, not generated, launched or registered on setup authority. Pi package registration and real Pi loading are separate owner-held gates.

- **Positive BDD:** Given an owner-selected development/reviewer pair and a permitted Pi identity/data route, when this loaded skill previews and writes the explicitly approved project-local map, then readback shows two distinct available identities without changing Pi defaults or granting effects.
- **Refusal BDD:** Given an unavailable setup resource, invalid/missing identity, absent model/data grant, unsupported effort/panel request or no owner approval, when a config write or reviewer use would depend on it, then leave the map unchanged and label that step `blocked`/`unrun`; do not invent a provider slug, `auto` fallback, worker or review pass.

A discoverable P45 leaf is not a configured Pi profile, a model-availability check or a live reviewer journey.
