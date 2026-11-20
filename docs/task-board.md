# Task board and Pulse

`TASKS.md` is the canonical board. `board.md` is a derived view and cannot authorize work. The trusted writer creates card IDs, validates fields and records the human instruction. An agent report cannot mark a card done.

An automation policy must name eligible roles and repositories, contained placement, concurrency, expiry and risk ceiling. Without a valid policy, automated dispatch refuses. `agentic_kanban_pulse` checks capacity without claiming, or runs an interactive capacity-filling batch with confirmation. Its policy actions enable, disable and configure only on a direct current-turn request.

`agentic_kanban_board_dispatch` claims one eligible card and creates a single-use envelope bound to card, repository, starting revision, assigned branch, allowed paths, stop point and expiry. Consuming the envelope releases the claim, not the card's done state. Altered, expired or reused envelopes refuse.

External clients use `agentic-driver.board-claim-request.v2` with `claimFromBoardRequest`. Receipts use `agentic-driver.board-claim-receipt.v2`; route digests use `agentic-driver.board-claim-route.v2`; async transport receipts use `agentic-driver.async-transport.receipt.v2`. Older contract names are refused. The session-task journey does not mint board envelopes.
