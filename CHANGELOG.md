# Changelog

Release dates below come from the read-only npm registry `time` record for `@evoclock/pi-agentic-driver` (checked 2026-10-22). Version 2.0.0 is proposed, not published.

## 2.0.0 (unreleased)

- Rename `claimFromVogelkopRequest` to `claimFromBoardRequest` without an alias.
- Migrate `vogelkop.board-claim-request.v1` to `agentic-driver.board-claim-request.v2`, `vogelkop.board-claim-receipt.v1` to `agentic-driver.board-claim-receipt.v2`, `vogelkop.board-claim-route.v1` to `agentic-driver.board-claim-route.v2`, and `vogelkop.async-transport.receipt.v1` to `agentic-driver.async-transport.receipt.v2`. Legacy request schemas are refused; update producers and consumers together.
- Move the workspace capability registry from `.vogelkop/capabilities.json` to `.agentic-driver/capabilities.json`. Route identity now uses `board-<alias>` and `board-router`.
- Preserve the packaged decision-to-spec skill already shipped in 1.1.2; do not package the private worker-repository registry.

## 1.1.2 (2026-10-11)

- Published package included `skills/decision-to-spec/SKILL.md` and excluded `config/herdr-worker-repositories.v1.json`.

## 1.1.1 (2026-10-03)

- Published maintenance release. Registry timestamp: 17:40:59 UTC.

## 1.1.0 (2026-10-03)

- Published minor release. Registry timestamp: 13:55:31 UTC.

## 1.0.0 (2026-10-02)

- Published major release. Registry timestamp: 16:54:13 UTC.
