# Task board and Pulse

`TASKS.md` is the canonical board. `board.md` is a derived view and cannot authorize work. The trusted writer creates card IDs, validates fields and records the human instruction. An agent report cannot mark a card done.

An automation policy must name eligible roles and repositories, contained placement, concurrency, expiry and risk ceiling. Without a valid policy, automated dispatch refuses. `agentic_kanban_pulse` checks capacity without claiming, or runs an interactive capacity-filling batch with confirmation. Its policy actions enable, disable and configure only on a direct current-turn request.

`agentic_kanban_board_dispatch` claims one eligible card and creates a single-use envelope bound to card, repository, starting revision, assigned branch, allowed paths, stop point and expiry. Consuming the envelope releases the claim, not the card's done state. Altered, expired or reused envelopes refuse.

External clients use `agentic-driver.board-claim-request.v2` with `claimFromBoardRequest`. Receipts use `agentic-driver.board-claim-receipt.v2`; route digests use `agentic-driver.board-claim-route.v2`; async transport receipts use `agentic-driver.async-transport.receipt.v2`. Older contract names are refused. The session-task journey does not mint board envelopes.

## Board and Pulse deep dive


Keep planned work in canonical `TASKS.md`. You can read it directly or use
the generated `board.md` view in Obsidian. Agents use the same canonical
record through natural-language board tools.

You can tell an agent to add, edit, move, block, propose, close, or remove a
card. The trusted writer assigns its ID, checks its fields, records your
instruction, and protects its dispatch provenance.

Agents cannot invent additional work or complete a card on their own. An
agent report is evidence for your review. Only your clear instruction or
direct board action completes the card.

For automated work, you set an explicit policy for the board. It defines:

- allowed roles and repositories;
- contained placement;
- the maximum concurrent work;
- the policy expiry; and
- the risk ceiling.

Without a valid policy, automated dispatch is refused.

The `agentic_kanban_board_dispatch` tool claims the highest-priority eligible card. It
creates a single-attempt assignment envelope that binds the card, repository,
starting revision, assigned branch, allowed paths, stopping point, expiry, and
interaction profile.

Blocked, altered, expired, reused, or unauthorized assignments fail closed.
Board Pulse handles board assignment with full route evidence. The session
worker journey does not claim board cards or mint board envelopes.

Consuming an envelope releases the claim. It does not mark the card done.

External board clients submit `agentic-driver.board-claim-request.v2` to
`claimFromBoardRequest`. Receipts use `agentic-driver.board-claim-receipt.v2`,
route digests use `agentic-driver.board-claim-route.v2`, and asynchronous
transport receipts use `agentic-driver.async-transport.receipt.v2`. Clients
must use these names; prior request, receipt, and route contracts are rejected,
with no compatibility aliases. Unsupported request schemas fail closed.
Workspace capabilities live at
`.agentic-driver/capabilities.json`; route seats and providers use `board-`
and `board-router` identities.

Claims and envelopes are kept in authenticated state beside `TASKS.md`. The
derived `board.md` view shows active claims but never becomes an authority
source.

The `agentic_kanban_pulse` tool checks the board for ready work and available capacity.
A check only reports which work is ready to run. It does not claim cards.

Interactive host work needs explicit policy and one native confirmation for
the batch. Automated work requires containment and never falls back to the
host.

Coming next:

- contained Pulse execution through an approved isolation boundary;
- expanded external board support for the shared card fields; and
- our own Obsidian plugin for canonical `TASKS.md`.


- **project status and state review.** Read-only projections of workspace Git
  state, formal records, and task-state health.
- **role-lane routing and warm sessions.** Separate lanes handle
  implementation, planning, and review, and the router prefers a warm session
  so context and cache survive across tasks. Route affinity is an
  optimisation, never authority: an incompatible lane yields an explicit
  review-required result, never silent model substitution.
- **task-ledger integration.** Agents read and act within the task ledger's
recorded state; a board projection never grants authority.
