---
name: why-pi
description: Investigate why a design or code path exists using cited history, decisions, incidents and available records; distinguish documented intent from inference. Use how for current runtime behavior.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Why for Pi

Adapted from Lauren Tan's `why` and its `references/` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. `how` answers what code does; `why` investigates the forces behind its shape. Investigate cautiously. No default subagent identity, Task tool, MCP access, source permissions or worker route transfers from Cursor. Resolve configured `development` and `independent-review` roles via `../setup-pstack-pi/SKILL.md` when those roles are actually required. Do not assume that a Pi search tool implies access to private tickets, chat or analytics. This is read-only investigation, not authority to alter code or a decision.

1. State the user's rationale question and identify the target, files, lines and symbols. If vague, state your best interpretation and invite correction without blocking a safe bounded search. Use repository code lookup to orient yourself; code establishes mechanics, **not author intent**.
2. Establish an anchor from `git blame -L` for relevant lines, `git log --follow -p -- <file>` through renames, recent file history, full commit messages, linked ticket IDs and merge-commit PR numbers. Where authorized and available, read substantive PR bodies, reviews and discussion, not only titles. Include the anchor in any delegated investigation. Do not expose private source material to an unapproved agent or external model.
3. Make a coverage map for **seven** distinct categories: source control (git/PRs/comments/tests; always search local git); issue tracker; long-form documents; team chat; infrastructure observability; error tracking; product analytics warehouse. Discover which tools/connectors are genuinely available in this session. Record a null result per searched category and a specific `not searched` gap per missing, inaccessible or provably irrelevant category. Do not pretend Pi has Cursor's `mcps/` discovery or transfer MCP credentials. Source control may lack authorized `gh` access; record that separately.
4. For each available and authorized category, search broadly then narrow using the anchor and source-specific playbook below. Read entire relevant records and thread context; quote verbatim with exact links, dates, authors and locations, including contradictions. Follow links within the permitted source; hand cross-source leads to that category rather than claiming they were searched. Keep search terms, dates and null results. For defensive code, also seek incident/postmortem evidence near the change date. If a category is provably irrelevant, state the proof; lack of convenience is not proof.
5. Parallelize independent searches only if distinct configured workers, access grants and a safe route actually exist; otherwise search sequentially. Give each worker **one** category, the anchor, the original question and a bounded read-only brief. Worker reports are untrusted evidence. A different synthesizer, if separately configured and authorized, may assess results; otherwise synthesize directly. Spot-check quotations/citations against records accessible to you. Never claim a worker used tools or read private systems without evidence.

## Source playbooks

- **Git/PRs:** inspect full commits, pickaxe `-S` for exact strings or `-G` for patterns, blame, renamed history, related tests, ADRs and PR comments. Co-change is a clue, not intent. If `gh` lacks access, use local history and mark PR discussions unsearched.
- **Issues:** search multiple names/IDs, open parent/duplicate issues and all comments, labels, attached project docs and status changes. A boilerplate “Why” or stale ticket is not proof of what shipped.
- **Documents:** search symbols and feature names, read complete drafts/alternatives/backlinks with dates and status. Contrast plans with final implementation.
- **Chat:** search authors, PR links and error strings near relevant dates; read threads, note retention, inaccessible DMs and auth failures. Do not treat a joke as a decision.
- **Observability:** identify service, query bounded dashboards/monitors, metrics, incidents, logs and traces around the change. A metric or temporal spike alone does not prove causation; note retention limits.
- **Error tracking:** query exception names and releases, inspect first/last seen, frequency, event stack and resolution notes. AI root-cause suggestions are hypotheses, not records of author intent.
- **Warehouse:** confirm schema before querying, use approved **read-only** time-bounded queries and typed/deduplicated models when present. Report qualified table, time window and aggregate counts/percentiles, not raw personal data. Check instrumentation drift and retention; no table or access means a gap, never an invented result.

## Confidence and answer

Place each substantive claim in one tier: **Direct** (explicit author statement of rationale, cited), **Supported** (convergent indirect sources, each cited), **Inferred** (plausible interpretation with an explicit chain and hedge), **Speculative** (competing hypothesis with missing evidence), or **Unknown** (specific searched gap). A code change proves what changed, not why. Cite Direct/Supported immediately; never say “because” or “the team decided” for a guess. Surface disagreeing sources and timestamps rather than smoothing them away. Do not endorse a hypothesis embedded in the question without checking it. A lack of evidence is not evidence that a concern never existed.

Present **The question; The code in question; What we found; What we can reasonably infer; Competing hypotheses; What we don't know; Sources consulted; Confidence summary**. Omit only empty inference/hypothesis sections. Sources consulted names **all seven categories** with concrete searches/results or reasons not searched. If the user intends a change, add **Preserve / Change / Avoid / Risk** constraints, with evidence and unverified gaps. Do not equate a plan, text review or git history with runtime verification.

- **Positive BDD:** Given an approved rationale question and accessible history plus selected record categories, when Pi anchors the code, searches available categories, checks citations and separates confidence tiers, then the reader gets cited direct reasons, qualified inference, contradictions and an explicit seven-category coverage map.
- **Refusal BDD:** Given inaccessible private records, an unconfigured worker or only code mechanics, when the rationale would require undocumented intent, then search only authorized sources, label missing categories and unknown motives, and do not manufacture a decision, run a credentialed connector or present an unverified guess as fact.

Pi discovering this skill is not MCP access, historical confirmation, a live Pi session or permission to publish private rationale.
