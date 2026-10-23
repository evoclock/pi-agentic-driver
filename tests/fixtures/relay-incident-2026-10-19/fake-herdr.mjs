#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(argv) + "\n");
const send = (result) => process.stdout.write(JSON.stringify(result));
if (argv[0] === "workspace" && argv[1] === "list") send({ workspaces: [{ label: process.cwd().split("/").at(-1), workspace_id: "w1" }] });
else if (argv[0] === "pane" && argv[1] === "list") send({ panes: [{ workspace_id: "w1", cwd: process.cwd() }] });
else if (argv[0] === "agent" && argv[1] === "list") send({ agents: [] });
else if (argv[0] === "tab" && argv[1] === "create") send({ result: { root_pane: { pane_id: "w1:p1" }, tab: { tab_id: "w1:t1" } } });
else if (argv[0] === "agent" && argv[1] === "start") send({ result: { type: "agent_started", argv, agent: { name: argv[2], agent: "pi", pane_id: "w1:p1", cwd: process.cwd(), launch_pending: false, interactive_ready: true } } });
else if (argv[0] === "agent" && argv[1] === "get") send({ result: { type: "agent", agent: { name: argv[2], agent: "pi", pane_id: "w1:p1", cwd: process.cwd(), launch_pending: false, interactive_ready: true } } });
else if (argv[0] === "pane" && argv[1] === "get") send({ result: { type: "pane", pane: { pane_id: argv[2], cwd: process.cwd() } } });
else process.exitCode = 1;
