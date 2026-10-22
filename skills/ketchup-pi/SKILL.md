---
name: ketchup-pi
description: Catch the user up on what changed in this chat since their last message, with plain words, checked facts and only real owner action items. Use explicitly for a brief in-chat catch-up.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Ketchup for Pi

Adapted from Lauren Tan's pstack `ketchup` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). This is a **read-only reply**, not `bro-pi`'s last-answer restatement, an all-project status survey or permission to update a report. Borrow the short plain voice from `bro-pi` only if that reviewed skill is loaded; otherwise use short everyday sentences without jargon. Never claim its invocation solely from this reference.

Identify the **last actual user message in this chat** before the catch-up request. Notifications, worker reports and assistant messages do not move that boundary. Use only the accessible conversation since it and authorized current state of the exact PR, CI run or agent already touched here. If the user-message boundary or current external state is not available, say what cannot be checked; do not search unrelated Pi sessions or invent an update. Keep this turn read-only: no app/job start, code or task mutation, public comment, screenshot generation or network check outside the existing grant.

For each meaningful change, say what it means to the user, not how many commands ran. Correct a mistaken count against source evidence when necessary. Separate done, still running, failed and not checked. An owner action item is only a decision, approval, access or irreversible step the user owns; work the agent can finish is not an owner action. Carry forward real outstanding owner choices even if raised before the last message, but never manufacture one. Give each owner choice its recommendation and the consequence of no answer. If nothing changed and no owner choice waits, say that and stop.

Open with the number of owner actions, or say none. Keep prose well under 150 words excluding helpful visuals. When an existing screenshot/video shows a visible change, embed it only if its real artifact is accessible; if none exists, say no screenshot and describe the visible change without fabricating a screen. Draw at most a small six-box/eight-words-per-box diagram **from checked facts** when relationships are clearer than sentences; do not draw a status list. Give one short outcome line per thing the user asked about, no duplicated facts, then at most three lines that change their understanding. Put owner actions last. If a choice needs comparison, show options with gain and cost, including the current state; when existing embedded screenshots already show the options, annotate them instead of drawing a duplicate visual. An irreversible unasked step gets one action line, not a visual. Link only real artifacts and omit hashes, internal paths, commands and build counts unless the user needs them to decide.

- **Positive BDD:** Given this chat's last user boundary and authorized current state, when `/skill:ketchup-pi` is invoked, then a concise checked catch-up distinguishes outcomes, owner-only actions and unrun work without repeating or inventing facts.
- **Refusal BDD:** Given no reliable boundary, unapproved private history, missing external state or absent visual artifacts, when invoked, then mark those facts unknown or the check `unrun` and answer only from accessible evidence, without scanning chats, performing effects or inventing a picture.

A discoverable skill is not evidence of a real catch-up or an approved owner action.
