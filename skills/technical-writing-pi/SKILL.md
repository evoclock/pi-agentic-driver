---
name: technical-writing-pi
description: Write or review an approved technical document using one Diátaxis mode, clear reader-facing sentences and unambiguous terminology. Use explicitly for a scoped guide, explanation, reference or tutorial.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Technical writing for Pi

Adapted from Lauren Tan's `technical-writing` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. This skill combines **Diátaxis mode, Google developer style, STE-informed instructions and Global English syntax**; the rules serve the reader rather than a mechanical sentence limit. Writing does not grant public publication, document scope, product-copy changes or permission to reveal internal evidence. An actually loaded `unslop-pi` can polish a draft; if absent, apply plain wording directly and do not claim invocation.

## Choose one document mode

Ask whether the reader is learning or doing work, and whether the content guides **action or understanding**. Pick one mode for the document: **tutorial** (learning by doing; say what will be built and show an early visible result at each step), **how-to** (competent reader's task, direct steps and conditional forks), **reference** (dry, complete lookup facts mirroring actual code/options/errors), or **explanation** (one bounded why question with evidence, alternatives and clearly supported opinion). Split and link incompatible modes rather than insert reference tables into a tutorial or persuasion into a how-to. PR copy and commit messages need brevity and clarity, not a Diátaxis document mode; public copy also follows the owner message gate and omits internal identities, commands, evidence paths and development history.

## Write to the reader

Cut words without a job, choose short everyday words and prefer the codebase's **actual** symbol, path, flag or command over a renamed synonym. Explain a necessary pattern the first time. Vary sentence length deliberately; one thought per sentence does not mean every sentence must be clipped. Explanation may weigh trade-offs, while reference states checked facts without opinion. Use “you” and present tense where appropriate, name actors, give a condition **before** the action, put the common case before exceptions and write procedures as commands. Never call a step “easy”, “simply” or “quickly” to mask its prerequisites. Use informative sentence-case headings, one h1, no skipped levels, numbered sequences and parallel bullets with a complete lead-in. Keep code/real paths exact and UI labels distinct; indent code snippets with tabs when following this source standard. Validate every count, tree or option against the actual revision and include a safe regeneration instruction when a count must be maintained, rather than repeating an earlier inventory.

For STE-informed steps, aim for one instruction per sentence, usually under about 20 words; for descriptive sentences prefer about 25 when clarity allows. Move a warning before its risky action and use articles so the target is unambiguous. Give each action one consistent name. For Global English, place “only” and “not” beside what they modify; shorten noun stacks, resolve pronouns with a real noun, keep verbs and structural words, disambiguate “and”/“or”, and favor periods over em dashes or semicolons. Avoid `a/b`, “(s)”, idioms and unexplained metaphors. Do not make a sentence worse merely to meet a style count: fix its structure or leave a clear exception. Keep examples, links and code excerpts within approved data scope. Use descriptive links rather than “click here”. Product UI strings follow the product's separate copy route.

If an abstraction word obscures an action, propose the concrete replacement to the owner with a small diff; do **not** edit a shared `unslop` catalog on this skill's authority. Keep an explanation human and specific, not a checklist of bans. Review the final document at its real destination for the declared mode, factual paths, useful headings, runnable authorized steps and accidental private/public leakage. No automatic install or script execution follows from an example command in documentation.

- **Positive BDD:** Given an approved audience, facts and document destination, when Pi selects one mode and checks reader-facing steps, terminology and real examples at the target revision, then the document serves its purpose without ambiguity or unfounded claims.
- **Refusal BDD:** Given missing audience/source facts, conflicting modes, an unapproved public destination or unavailable writing skill, when a document or PR body would assert unsupported details, then mark those claims `blocked`/`unrun`, keep private material private and do not publish or invent results.

A Pi-discoverable writing skill is not an authored user manual, approved public copy or live Pi documentation check.
