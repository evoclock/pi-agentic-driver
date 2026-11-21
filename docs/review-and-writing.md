# Review and writing

Model-fidelity views already use Bowerbird for validation and HTML/SVG rendering. The pinned 0.3.0 release adds TLA+/TLC verify and composition/click-through diagramming; migrating workflow-runner TLC and rebuilding diagrams are separate follow-ups.

`code_phage` reviews a stated goal before implementation. It finds prior art from the repository inventory, binds requirements to proposed files and tests, and flags scope drift. Complexity and duplication are diagnostic signals, not rejection thresholds. The tool is advisory; it never mutates or authorizes work.

`agentic_aidr` reviews prose for clarity, simplicity, brevity and humanity. Plain-language and STE-informed modes are optional. An apply action needs confirmation; a review never writes.

The `decision-to-spec` skill drafts one private, bounded assignment from a direct owner decision or a sourced quoted relay. It checks existing behavior, asks consequential questions, chooses observable acceptance and records a stop point. `agentic_decision_evidence` structures the stated source but does not verify identity. `agentic_relay_check_request` checks the recorded action scope without granting authority. No skill description is a runtime permission guard.

## Code review and planning

## Code review and planning

*Extensions that review, route, and control what an agent does.*


The `code_phage` tool reviews a proposed change against a stated goal before the agent
writes or commits code. Give it a goal, candidate files, accepted
requirements, and test paths. It will:

- **Find prior art structurally.** It matches exported symbols, function
  signatures, and dependency imports against a repository inventory, so the
  agent reuses an existing abstraction instead of writing a parallel version.
  Word overlap alone never counts. When prior art informs the result, the
  implementation records its source, version, and license.
- **Bind an implementation budget.** Goal, requirements, write set, and tests
  become one reviewable budget. Coverage checks flag requirements nothing
  binds and tests nothing covers.
- **Measure diagnostic signals.** Cognitive and cyclomatic complexity, line
  counts, duplication, module-level mutable state, dependencies, test burden.
  These are signals for human judgment, never rejection thresholds.
- **Redirect scope drift.** It names the files that support no accepted
  requirement and recommends the smallest coherent write set. The deletion
  test guards justified complexity: what would fail if we removed this?
- **Stay advisory.** It never mutates files, creates tasks, grants authority,
  or blocks work. Every result says `advisoryOnly: true`.

Concept credit: Matty Stratton, "Cognitive Complexity" (2024-09-20, concept
only, no code copied); `flake8-cognitive-complexity` 0.1.0, MIT (concept
only, not a runtime dependency).



Plans stay close to the work. They do not become board work by accident. The tasks skill gives Pi a familiar session list. It adds an owner-approved way to keep selected tasks in the durable `TASKS.md` board.

- **Keep the working list simple.** Use `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate` as usual. Set an optional P0–P3 session priority; ranked open work appears first, unranked work keeps ID order, and completed work appears last. Priority does not authorize board dispatch. The widget and footer stay live as tasks change.
- **Keep the Claude-like view.** `/tasks` provides descriptions, active forms, and internal-task markers without mutating the plan.
- **Make durable work deliberate.** `TaskPromote` never runs automatically. It previews the exact cards and destination before the owner confirms.
- **Keep authority clear.** The trusted board writer creates and updates `TASKS.md`. The skill does not bypass it.
- **Make migration gentle.** Existing task files remain readable. Moving to the driver-owned skill does not strand current plans.

The result is a clean handoff from a session plan to durable work. Selected tasks can survive the session, appear on the shared board, and become available for controlled dispatch when ready. A session priority is not copied into a board card without an owner-approved board action.



The `decision-to-spec` skill turns a decision into one reviewable planning
brief. Invoke `/skill:decision-to-spec` or ask for the workflow explicitly.
Pi can load the skill description on its own; loading is not evidence of a
decision and is not permission to draft.

- **Source the decision.** The brief records either your direct instruction
  or a relay that quotes your exact words with where and when you gave them.
  A bare approval claim or an unsourced quote is not decision evidence.
  `agentic_decision_evidence` structures the stated source; it verifies no
  identity.
- **Relay private approvals.** A configured relayer can record your exact
  answer, the question it answers, its source, channel, time, and bounded
  scope. `agentic_relay_check_request` is a read-only preflight; each action
  checks the record again. A relay attests that the configured relayer recorded
  your words; it does not prove identity or authorize merges or publication.
  See `docs/relay-authority.md`.
- **Settle what matters first.** The skill inspects the inventory, existing
  behavior and the affected driver capabilities, then asks one round of
  decisions that could change acceptance, scope, ownership, review or stop
  conditions, each with a recommendation.
- **Make outcomes observable.** Success and meaningful failure are written as
  Given/When/Then, with the highest feasible existing test seam and the
  reason it would catch a broken implementation.
- **Bound the work.** Owner, author, an independent standards and boundary
  reviewer, and an exact-artifact acceptance reviewer; exact paths and
  effects, the model, data and runtime route, exclusions, and a stop point.
  Implementation needs an identified Treehouse lease; drafting does not.

The output is a private planning brief for the requester, **not** a dispatch
record. It cannot approve a merge, release, deletion or force-push, write a
board card, create an issue, or change a provider route. Unresolved
decisions stay explicit instead of becoming assumed requirements.

Concept credit: Matt Pocock's `grill-with-docs`, `to-spec` and
domain-modeling skills, MIT (question-framing patterns only, no text
copied).

## Writing clearly

## Writing clearly

*AI;DR (AI; Didn't Read) keeps technical writing clear without flattening the
writer's voice.*


The `agentic_aidr` tool reviews the last assistant response, supplied prose, or a
Markdown file. It checks four principles:

- **Clarity.** Each sentence carries one useful idea.
- **Simplicity.** Clutter, pompous phrases, and needless jargon go.
- **Brevity.** Fewer words when they carry the same meaning.
- **Humanity.** An authentic human voice stays.

The `simple` and `ste` modes add an ASD-STE100-informed profile: sentence
length, direct word choice, precise verbs, and clear requirements,
permissions, abilities, and conditions. It targets 20 words per procedural
sentence and 25 per descriptive one, and returns the rule and an example for
each finding.

The profile is advisory. It does not include the licensed ASD-STE100
approved-word dictionary and does not certify conformance. Check final text
against the licensed specification and your project terminology list.

AI;DR also flags dense paragraphs, suggests bullets when they reduce working
memory load, and supports plain-language and analogy modes. Review is
read-only. An explicit file apply action shows a git diff and writes the
exact replacement only after native confirmation. Release 0.4.2 adds controlled
inputs, atomic replacement, drift checks, and exact write verification.
