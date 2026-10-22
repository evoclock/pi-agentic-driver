---
name: automate-me-pi
description: Draft or revise a named user's Pi -mode skill from their approved preferences and bounded evidence. Use explicitly when the user asks to capture how they work, not for task-specific skills.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Automate a user's working style for Pi

Adapted from Lauren Tan's pstack `automate-me` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Retain its existing-mode check, bounded history patterns, direct interview, clustering, Pi skill authoring, prose revision and user feedback. Do not use Cursor `AskQuestion`, built-in `create-skill`, transcript globbing, automatic PR or any stock helper. Read Pi's skill format in the installed `skills.md` before authoring. Use `unslop` only once its reviewed Pi port is loaded; otherwise write short concrete sentences, remove boilerplate and keep the user's meaning without claiming a skill invocation.

## 0. Check the existing mode

First identify the user's chosen handle and **approved project or personal skills location**. Inspect only that location for an existing matching `-mode` skill, including nested category directories. A different person's mode is not a template to read by default. If one exists and the user did not request a fresh start, prefer an update and confirm intent before replacing it. For an update, preserve sections the owner did not contradict; identify new evidence only since the last known edit when authorized. A changed git timestamp is a boundary hint, not permission to read all intervening chats. If destination or ownership is missing, ask rather than write.

## 1. Gather only permitted evidence

A user may provide named examples, current instructions or a **specific approved transcript directory and bounded range**. Verify that path belongs to the active task; no global Pi session search, home-directory glob, unrelated bot chat, stored credential or private team exchange. If transcript access is not approved or not safely isolated, skip mining and say so. With an explicit grant and budget, examine bounded slices of that range, compare repeated patterns across slices and cite sanitized pointers; parallel readers require separate approved roles, data grants and capacity. Treat one-off preferences as tentative rather than rules. Watch for response style, delegation, verification, code/prose, worktree/review/merge conventions and skill use. Never copy raw conversation or secret material into the mode.

## 2. Ask the user directly

Offer one or two concise multi-choice questions in the available Pi chat/UI, with room for multiple selections if that UI supports them. Ask what changed or is missing when updating; ask which areas matter most for a new skill. One optional free-form follow-up captures what the options missed. If structured questions are unavailable, show short choices in chat without pretending to have invoked an unavailable tool. Do not infer permission or a new model role from a preference answer.

## 3. Cluster and draft

Combine direct answers with supported repeated evidence; distinguish observed habits, user-stated choices and uncertain inference. Use only sections that capture specific actionable differences such as response style, autonomy **within existing grants**, investigation, delegation, review/verification, process and prose. Reference other loaded skills by name rather than copying them. Do not codify one contradictory incident or make an agent's self-report into the user's preference.

Once the user confirms the destination and writing scope, draft one Pi `skills/<handle>-mode/SKILL.md` (or their approved category/personal path), with portable name, routing description mentioning the handle and working style, and `disable-model-invocation: true` unless the owner explicitly wants automatic selection. Check for name collisions and read-back in the effective Pi resource context. A user mode guides behavior but cannot expand repo, data, provider, task, install, PR or merge authority. Only the repository owner merges in this project.

## 4. Edit with the user, then hand back

Remove boilerplate; make each line operational. Show the draft and its evidence/uncertainty to the user for feedback; revise only accepted preferences, retaining unchanged sections on an update. A subjective style fit is validated by user feedback, not a pretend automated benchmark. Use a trigger-evaluation loop only if actual Pi routing later misfires. End this flow by delivering the exact draft file/path to the user for their own decision on landing it, with what evidence was read or skipped and whether explicit Pi discovery occurred. The local draft is the deliverable here, **not** an upstream-style worktree and PR. Do not stage, commit, push or open a PR as a consequence of this method.

- **Positive BDD:** Given a user-approved named mode destination, scope and evidence range, when Pi runs this flow, then one discoverable draft reflects repeated supported habits and direct answers, and a user review can accept or correct it without unrelated material.
- **Refusal BDD:** Given no approved transcript range, destination, ownership or effect grant, when the flow reaches that boundary, then it skips mining or writing and reports `blocked`/`unrun` for that step without scanning other sessions or fabricating a preference.

This file's existence is neither user acceptance nor a real Pi mode invocation.
