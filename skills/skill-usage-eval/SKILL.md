---
name: skill-usage-eval
description: "Use when evaluating skill loads and missed skill use in a bounded session corpus; not for enforcing agent compliance."
---

# Skill usage eval

Work only on explicitly approved session directories and dates. Review the data-sharing boundary before sending transcripts to an external provider. Do not include raw transcripts or credentials in a report or commit.

1. Inventory the available skill packs. Read their `SKILL.md` descriptions, including packs outside PAD.
2. Exclude harness sessions, then split conversations at user task turns. Only a successful tool read of a `SKILL.md` counts as a load; catalog mentions in a system prompt do not.
3. Fit each segment's conversation in order with short tool-result notes. Ask the configured decisions provider whether each available skill was needed and, if loaded, whether its steps were followed. Use deterministic parsing for the load fact. Reject incomplete or malformed answers.
4. Run a 20-session hand-check against independent reading. Compare precision and recall for each provider before recommending a default.
5. Review the JSON and per-skill Markdown table, including skipped counts and provider identity. Rank routing or description changes by missed-use count without applying them in this evaluation.

For the daily Pi step, after approving the session-sharing boundary, run `node scripts/skill_usage_eval.mjs --dual --since 24h --out "$HOME/.local/share/skill-usage" --label-sample 20` from the installed package root. Read the JSON stdout `output` and `running` fields. Use no key prefix or shell key-loading wrapper. The CLI uses nonempty `OPENAI_API_KEY` / `TYPESAFE_API_KEY` values first, then the OS secret store (macOS Keychain or Linux libsecret). Store names come from `secrets.openai` / `secrets.typesafe` in the local `pad-user.v1` config. If the store supplies no key, only an explicitly set `OPENAI_API_KEY_FILE` / `TYPESAFE_API_KEY_FILE` permits reading a file, with a variable-only warning. Implicit home key files are ignored, with an existence-only warning when present. No usable source means a public error without tool output or credential contents. Never include keys in arguments or report text. See `docs/skill-usage-eval.md` for the External bot/External bot workflow contract, labeling, and scheduler examples.

For the legacy single-provider evaluation, run `node scripts/skill_usage_eval.mjs --limit 20 --out .scratch/skill-usage/report` using the same OpenAI environment-or-file loading. A Jev comparison uses `node scripts/skill_usage_eval.mjs --jev --limit 20 --out .scratch/skill-usage/jev` using the same TypeSafe environment-or-file loading. The CLI writes JSON and Markdown reports without interactive prompts. Keep private session content and reports out of commits. See `docs/skill-usage-eval.md` for coverage limits; the handcheck scorer ships in the package, while its evidence fixtures require a repository checkout.

## Scheduled jobs

Linux libsecret's `secret-tool` requires the account's session bus. Scheduled jobs must provide `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`; only these two variables are forwarded. A systemd user service normally has them; plain cron usually does not. Keychain lookups from launchd agents need the account's login session. Do not log the scheduler environment or try to unlock stores automatically.

## Migrate an existing key file

1. Locate the existing `~/.<name>_key` privately. Never print the value or put it in shell arguments or history.
2. On macOS, run `security add-generic-password -s <OPENAI_KEYCHAIN_SERVICE> -a <OPENAI_KEYCHAIN_ACCOUNT> -w` and enter the existing value at the prompt. On Linux, run `secret-tool store --label=<LABEL> service <OPENAI_KEYCHAIN_SERVICE> account <OPENAI_KEYCHAIN_ACCOUNT>` and supply the value through stdin or the prompt. No value belongs on argv.
3. Put the service/account names, not values, in `secrets.openai` in the local `<USER_CONFIG>` (`pad-user.v1`). Use `secrets.typesafe` and the corresponding names for TypeSafe.
4. Unset the corresponding API-key and API-key-file variables, then verify with `node scripts/skill_usage_eval.mjs --sessions <APPROVED_SESSION_DIR> --limit 1 --out <PRIVATE_OUTPUT_DIR>`. For TypeSafe, add `--jev`; the single-provider command otherwise verifies OpenAI. Approve transcript sharing first. Require CLI success without a file-fallback warning.
5. After successful verification, remove the legacy file with `rm -- <LEGACY_KEY_FILE>`. Retain it privately if verification fails.

Valid config plus a store hit still wins over an explicit file. Broken or unreadable config permits only the explicitly selected file fallback, with its existing warning; without that fallback, it fails closed.

## Limits

- Model probability is an estimate, not proof of necessity or compliance. The 0.7 threshold requires validation on hand-labeled examples.
- Large histories are fitted by truncating older turns; segments that cannot fit fail closed. Tools' results are omitted from the scoring state, which may hide step evidence.
- The parser supports Pi JSONL transcripts. Harness exclusion is heuristic; inspect false exclusions. Linux sessions can be streamed through `--sessions -` from an approved host; the Linux skill catalog is not discovered remotely.
- Catalog discovery is shallow. A skill's description is a proxy for its procedure; duplicate skill names across packs are reported separately.
- Refusals, fitting errors, and malformed responses skip the affected segment with a recorded failure count. Missing keys or authorization failures stop the run. No fallback silently changes providers or turns missing answers into negative scores.
