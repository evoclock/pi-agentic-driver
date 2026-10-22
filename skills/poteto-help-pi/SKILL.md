---
name: poteto-help-pi
description: Answer a user's question about which reviewed pstack-to-Pi method, role setup, playbook or principle fits without starting the task. Use explicitly when the user asks for skill or setup help.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Help with the pstack-to-Pi route

Adapted from Lauren Tan's `poteto-help` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT), including its `references/prompting.md` and `references/recipes.md`. Help answers are **not** requests to start work. Answer, give one prompt the user could send, and link the actual source used. For an explicit work request, hand off to the **loaded, owner-approved** working method instead of answering it as help; loading this file never starts a task, worker or app. Read `../how/WORKFLOW_BOUNDARIES.md`.

## Find their need without guessing resource state

Use the question and current conversation. If still unclear, ask **one** multiple-choice question: set up roles; start a non-trivial task; choose a skill or principle; fix a run; make the method your own. Answer only the chosen section. Before advising a command, inspect the **current Pi session's** available `/skill:<name>` command/resource diagnostics and the actual skill's `SKILL.md` (or state that it could not be checked). A repository file, source pin, temporary offline discovery and planning table do **not** prove the Pi session loaded it. If the required port is missing, say so and do not offer its command as executable. Show the exact repo-local file used as evidence; the upstream public snapshot, if needed, is `https://github.com/cursor/plugins/blob/99743e9c151c8537cbbf1f98bb38f34ef3368453/pstack/` plus its relative path, **not** an assumed moving `main` copy. Do not expose private repository contents publicly just because a public upstream URL exists.

## Set up, cost and verification

The port's `/skill:setup-pstack-pi` uses the project role map, not a Cursor configuration file. If role configuration matters, check that file's schema, exact `development` and different `independent-review` model identities and actual session/data route; if missing, report `pstack role <role> is not configured in the project role map; run /skill:setup-pstack-pi`. There is **no default, `auto` or parent-model fallback** for a missing role. Ask **once per conversation** whether the owner wants to configure approved roles now or later when setup, cost or model choice affects the answer; combine this with the one clarification question if necessary. Answer the substantive question either way. More reviewers/workers cost tokens; reduce only within the approved task and role map, never by swapping models silently. A missing project-local `verify-*` or app harness means no verified scripted user journey; suggest loaded `/skill:create-verification-skill-pi` if that is what the user needs, but do not generate or launch an app from a help request. Setup order: (1) ask the owner to register only reviewed resources in the approved private Pi package/profile route **at the later integration gate**, not on a help turn; (2) use loaded `/skill:setup-pstack-pi` for owner-selected roles without changing the Pi default; (3) choose an approved small task with a pass/fail check and a loaded method. Check actual Pi session resource diagnostics after registration; no installation, `/add-plugin`, Cursor Custom Mode key chord or same-session persistence is promised. Pi package registration and Pi loading are separate owner-held gates.

## Route by the real request, not a static command catalogue

A non-trivial **approved** task can use a loaded `/skill:poteto-mode-pi` method; a casual question or explicit opt-out should not. The current draft is not the stock Cursor Custom Mode and does not automatically remain active every turn. The draft `/loop-until-done` command is not Cursor `/loop` and does not grant unattended effects. For help wording use: goal, pass/fail check, observable proof, known facts, actual constraints; omit a hand-written skill sequence and label hypotheses as guesses. For a read-only question offer a loaded `how-pi` (mechanics), `why-pi` (rationale, **only if present**), or `teach-pi` (plain combined explanation, **only if present**). For a review, distinguish `interrogate-pi` (within the diff), `blast-radius-pi` (downstream risk), and `no-comments-pi` (targeted comment review). `arena-pi` repeats the same brief and compares alternatives; `swarm-pi` splits independent slices only if loaded and approved. Other source methods have their own individually reviewed Pi ports; read each before recommending it. A `principle-*` directory or a named playbook is **not** by itself a loaded Pi slash command or permission to run a workflow. Name the loaded leaf and the specific decision it would change. Do not list the whole planned P01–P54 set as installed.

Check the actual loaded resource **before offering any command**. Use this routing index as a question map, **not** an installed-command list; the `-pi` form applies only where that exact name is loaded, and `setup-pstack` retains its existing Pi name. For every suggestion, read that specific skill first.

| User's need | Candidate source method to check |
| --- | --- |
| Rigorous non-trivial task; ambiguous brief; goal restatement | `poteto-mode-pi`; `figure-it-out-pi`; `in-your-own-words-pi` or `sharpen-pi` |
| How code works; why it has this shape; plain teaching | `how-pi`; `why-pi`; `teach-pi` |
| Context from named prior work; only this chat since the last user message | `recall-pi`; `ketchup-pi` |
| Blast radius, types/design, multiple same-brief attempts | `blast-radius-pi`; `architect-pi`; `arena-pi` |
| Independent slices or declared race; skeptical diff review | `swarm-pi`; `interrogate-pi` |
| Failing test first; TS rules; comment-only review | `tdd-pi`; `typescript-best-practices-pi`; `no-comments-pi` |
| Writing, plain restatement, benchmark vetting | `technical-writing-pi`; `unslop-pi`; `bro-pi`; `benchmark-checklist-pi` |
| Create/maintain real app verification route | `create-verification-skill-pi`; `maintain-verification-skill-pi` |
| Decision trail; model roles; personalized method | `show-me-your-work-pi`; `setup-pstack`; `automate-me-pi` |
| Repeated mistake; lesson from finished work; bot UI | `correct-pi`; `reflect-pi`; `make-bot-ui-pi` |

Close calls: `how` traces mechanics, `why` investigates reasons and `teach` explains their combined result; `arena` compares same-brief candidates, `swarm` partitions independent slices; `interrogate` reviews the artifact, `blast-radius` tests breakage outside it; `recall` needs owner-approved named history, `ketchup` stays inside this chat; `architect` settles a design shape, it never grants implementation. No named method is available until its **actual Pi command** resolves.

Source playbook phrases map to intentions, **not** extra Pi slash commands: “babysit/check on this PR” → review status or move to merge-ready **only within the approved private forge route**; “land the stack” → **owner-held merge**, no agent execution; “take over this branch” → scoped session pickup; “pause safely” → preserve state/evidence; “plan multi-phase work” → plan/checkpoints, not code; “full autopilot” or “stack them, don't ship” → proposals requiring a bounded task, capacity and owner-granted effects; “run the eval” → blinded skill evaluation with approved candidates. A current `poteto-mode-pi` draft does **not** implement all stock playbooks: check the live loaded method's documented capability and say `unrun` when absent. Cursor Plan Mode, `/loop`, `/create-skill` and `cursor-team-kit`'s `/deslop`, `control-cli` and `control-ui` are not Pi/pstack commands. Principles are one-rule leaves, not a new slash playbook; check that the named leaf loaded and state the decision it changes.

For a run that went wrong, first distinguish missing command, missing role, unverified runtime, disputed design and failed real check. Respond with the **smallest specific next check** and an actual path, not a new worker, a broad transcript search, a stock install, a secret request, a PR or a restart. Personal-method requests may point to a loaded `automate-me-pi`, `reflect-pi` or `correct-pi` after checking their separate history/data and edit grants; avoid mining chats or rewriting skills on a help turn. If a port-local personalization guide does not exist, label it absent and cite the public pinned `pstack/docs/guide/09-make-it-yours.md` only as background, not as Pi instructions. A desktop-control route and product work are separate topics.

## Reply

Lead with the answer, then **at most one** tailored example prompt (in a short code block if useful), then the actual loaded skill/guide file path that supports it or a clearly labelled public upstream permalink. Keep it short unless asked for a map. If a resource, role or verified behavior is absent, say **blocked** or **unrun** and give the next permissible owner choice. Never claim that answering help invoked a skill, launched a mode or caused a task to run.

- **Positive BDD:** Given a user asking which method fits and an inspected Pi resource list, when this help skill answers, then it recommends only a loaded fitting method with its real name, one tailored prompt and a source link, without starting the work.
- **Refusal BDD:** Given an unregistered port, missing role map, no app harness or an ambiguous help question, when the request reaches that gap, then it names the missing prerequisite (or asks one combined choice question), does not promise stock Cursor commands, default models, proof or effects, and does not treat a temporary Pi discovery check as Pi loading.
