// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only
// Two local transports, one dispatch table. The host constructs the commands.
import { createServer } from "node:http";
import { createInterface } from "node:readline";

export function invokeMachine(commands, name, input) {
  if (typeof name !== "string" || !Object.hasOwn(commands, name)) {
    return { ok: false, status: "invalid-input", code: "invalid-input", reason: "unknown command" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: "invalid-input", code: "invalid-input", reason: "object arguments required" };
  }
  try {
    return Promise.resolve(commands[name](input)).catch((error) => ({ ok: false, status: error?.code ?? "needs-reconciliation", code: error?.code ?? "needs-reconciliation", reason: String(error?.message ?? error).slice(0, 256) }));
  } catch (error) {
    return { ok: false, status: error?.code ?? "needs-reconciliation", code: error?.code ?? "needs-reconciliation", reason: String(error?.message ?? error).slice(0, 256) };
  }
}

export function createMachineRest(commands) {
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const host = req.headers.host ?? "";
    if (!/^127\.0\.0\.1:\d+$/.test(host) || req.headers.origin || req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403); res.end(JSON.stringify({ ok: false, code: "local-only" })); return;
    }
    const name = req.url?.startsWith("/commands/") ? req.url.slice(10) : "";
    if (req.method !== "POST" || !Object.hasOwn(commands, name)) {
      res.writeHead(404); res.end(JSON.stringify({ ok: false, code: "not-found" })); return;
    }
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64 * 1024) throw new Error("request too large");
      }
      const result = await invokeMachine(commands, name, JSON.parse(body));
      res.writeHead(result?.ok === false ? 400 : 200);
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(400); res.end(JSON.stringify({ ok: false, code: "invalid-input" }));
    }
  });
  return { listen(port = 0) { return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(server.address()); });
  }); }, close() { return new Promise((resolve) => server.close(resolve)); }, server };
}

const COMMAND_FIELDS = Object.freeze({
  "journey.finish": { envelopeId: "string", reason: "string" },
  "journey.start": { role: "string", stepPrompt: "string" },
  "board.claim": { role: "string" },
  "board.complete": { cardId: "string", authority: "object" },
  "board.cancel": { cardId: "string", authority: "object" },
  "board.reopen": { cardId: "string", authority: "object" },
  "run.invoke": { requestId: "string", goal: "string" },
  "run.abort": { runId: "string" },
  "run.reconcile": { runId: "string", evidence: "object" },
  "run.record-receipt": { runId: "string", stepId: "string", requestKey: "string", receipt: "object" },
  "reservation.verify": { envelopeId: "string" },
  "reservation.abandon": { envelopeId: "string", idempotencyKey: "string" },
  "reservation.expire": { envelopeId: "string", idempotencyKey: "string" },
  "reservation.confirmed-missing": { envelopeId: "string", idempotencyKey: "string" },
});

export async function machineMcpMessage(commands, message) {
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentic-driver-machines", version: "1" },
  } };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: Object.keys(commands).map((name) => ({ name,
    description: `Host machine command ${name}`, inputSchema: { type: "object",
      properties: Object.fromEntries(Object.entries(COMMAND_FIELDS[name] ?? {}).map(([key, type]) => [key, { type }])),
      required: Object.keys(COMMAND_FIELDS[name] ?? {}), additionalProperties: true } })) } };
  if (message.method === "tools/call") {
    const { name, arguments: input } = message.params ?? {};
    const result = await invokeMachine(commands, name, input);
    return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: result?.ok === false } };
  }
  if (message.id === undefined) return null;
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } };
}

export function serveMachineMcp(commands, input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input });
  lines.on("line", async (line) => {
    try {
      const reply = await machineMcpMessage(commands, JSON.parse(line));
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    } catch { output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`); }
  });
  return lines;
}
