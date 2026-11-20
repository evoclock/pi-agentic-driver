// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only
// Host-local endpoint: supply a trusted board path, never accept paths from requests.
import { resolve } from "node:path";
import { createMachineCommands } from "./enforcement/machine_commands_pi.js";
import { createModelFidelityCommands } from "./enforcement/model_fidelity_commands.mjs";
import { createMachineRest, serveMachineMcp } from "./enforcement/machine_transports_pi.js";
import { openRouterStore, closeRouterStore } from "./enforcement/router_store_pi.js";
import { openDurableDriver } from "./enforcement/durable_driver_pi.js";

const evidenceOnly = process.argv.slice(3).join(' ') === '--commands model-fidelity' || process.env.PAD_MACHINE_COMMANDS === 'model-fidelity';
const boardPath = process.env.PAD_MACHINE_BOARD;
if (!evidenceOnly && (!boardPath || !resolve(boardPath).endsWith("/TASKS.md"))) throw new Error("PAD_MACHINE_BOARD must name the host's TASKS.md");
const routerStore = evidenceOnly ? null : openRouterStore({ dbPath: process.env.PAD_MACHINE_ROUTER_DB || null });
const driver = evidenceOnly || !process.env.PAD_MACHINE_RUN_DIR ? null : await openDurableDriver({ directory: resolve(process.env.PAD_MACHINE_RUN_DIR) });
const commands = evidenceOnly ? createModelFidelityCommands() : createMachineCommands({ boardPath: resolve(boardPath), routerStore, durable: driver && { driver } });
const mode = process.argv[2];
if (mode === "mcp") serveMachineMcp(commands);
else if (mode === "rest") {
  const rest = createMachineRest(commands);
  const address = await rest.listen(Number(process.env.PAD_MACHINE_PORT ?? 0));
  console.log(JSON.stringify({ host: address.address, port: address.port }));
} else throw new Error("expected mcp or rest");
process.once("exit", () => { closeRouterStore(routerStore); void driver?.close(); });
