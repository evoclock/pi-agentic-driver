// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// janus HTTP surface (§5): POST /evaluate, GET /healthz, GET /readyz,
// GET /version. Binds 127.0.0.1 ONLY (H4) — the bind address is not
// configurable by design. No auth beyond loopback: it is a local tool.
//
// Review fixes #5 and #10:
//   - Content-Type is parsed properly (RFC 9110): `application/json` with
//     parameters such as `charset=utf-8` is accepted; a missing header,
//     malformed type, or any non-JSON type is rejected with validation_error.
//   - An oversized body is drained and answered with a structured JSON
//     validation_error whenever safely possible.
//   - Every error body uses a FIXED public message; internal error text
//     (including `error.message` from unexpected exceptions) never reaches
//     an HTTP caller.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { JANUS_VERSION, QUESTION_SCHEMA_VERSION, RESPONSE_SCHEMA_VERSION, type JanusConfig } from "./config.js";
import { TYPESAFE_SDK_VERSION, ProviderChain } from "./providers.js";
import { Evaluator, buildProviderChain, type EvaluateResponse } from "./evaluate.js";
import { SingleFlight } from "./single_flight.js";
import { DailyBudget } from "./budget_breaker.js";
import { AuditLog } from "./audit.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface JanusService {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function validationBody(message: string): Record<string, unknown> {
  return { error: "validation_error", message, request_id: "n/a" };
}

/**
 * Parse a Content-Type header per RFC 9110 and decide whether the body is
 * JSON. Returns the accepted type or a fixed public rejection reason.
 */
export function parseJsonContentType(header: string | undefined):
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "not-json" } {
  if (header === undefined) return { ok: false, reason: "missing" };
  // type = token "/" token *( OWS ";" OWS parameter )
  const match = /^\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\/([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*(?:;.*)?$/.exec(header);
  if (match === null) return { ok: false, reason: "malformed" };
  const type = `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
  if (type !== "application/json") return { ok: false, reason: "not-json" };
  return { ok: true };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    // Over-limit bodies are DRAINED (chunks discarded, stream consumed) so
    // the structured 413 JSON response can still be delivered safely
    // (review fix #10). A hard runaway ceiling destroys the connection.
    const RUNAWAY_BYTES = 64 * 1024 * 1024;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overLimit) rejectPromise(new BodyTooLargeError());
      else resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (total > RUNAWAY_BYTES) req.destroy();
      if (!overLimit) rejectPromise(error);
    });
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

export function createJanusService(
  config: JanusConfig,
  evaluator: Evaluator,
  readiness: () => Promise<{ ready: boolean; reason?: string }>,
): JanusService {
  const server = createServer((req, res) => {
    void handleRequest(req, res, config, evaluator, readiness);
  });
  // Loopback only, by construction (H4). There is no bind-address option.
  server.listen(config.port, "127.0.0.1");

  return {
    server,
    port: config.port,
    stop: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: JanusConfig,
  evaluator: Evaluator,
  readiness: () => Promise<{ ready: boolean; reason?: string }>,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /healthz") {
      sendJson(res, 200, { status: "ok", version: JANUS_VERSION });
      return;
    }

    if (route === "GET /readyz") {
      const keyState = await readiness();
      if (keyState.ready) {
        sendJson(res, 200, { status: "ready", version: JANUS_VERSION });
      } else {
        sendJson(res, 503, {
          status: "not_ready",
          version: JANUS_VERSION,
          // Fixed public reason only (review fix #5).
          reason: keyState.reason ?? "no provider credential resolvable",
        });
      }
      return;
    }

    if (route === "GET /version") {
      sendJson(res, 200, {
        janus: JANUS_VERSION,
        typesafeSdk: TYPESAFE_SDK_VERSION,
        questionSchema: QUESTION_SCHEMA_VERSION,
        responseSchema: RESPONSE_SCHEMA_VERSION,
        providers: config.providers.map((p) => p.id),
        defaultModel: config.defaultModel,
      });
      return;
    }

    if (route === "POST /evaluate") {
      // Content-Type must be a properly parsed application/json (parameters
      // such as charset are allowed) — review fix #10.
      const contentType = parseJsonContentType(req.headers["content-type"]);
      if (!contentType.ok) {
        const reason =
          contentType.reason === "missing"
            ? "content-type header is required and must be application/json"
            : contentType.reason === "malformed"
              ? "content-type header is malformed"
              : "content-type must be application/json";
        sendJson(res, 400, validationBody(reason));
        return;
      }
      let body: unknown;
      try {
        const raw = await readBody(req);
        if (raw.length === 0) {
          sendJson(res, 400, validationBody("request body is required"));
          return;
        }
        body = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          // Structured JSON even for oversized bodies, when safely possible.
          sendJson(res, 413, validationBody(
            `request body exceeds ${MAX_BODY_BYTES} bytes`,
          ));
          return;
        }
        // Fixed message: the JSON parse error text is not echoed.
        sendJson(res, 400, validationBody("request body is not valid JSON"));
        return;
      }
      const outcome: EvaluateResponse = await evaluator.handle(body);
      sendJson(res, outcome.status, outcome.payload);
      return;
    }

    sendJson(res, 404, validationBody(`unknown route ${route}; see GET /version for the endpoint contract`));
  } catch {
    // Internal error text never reaches the caller (review fix #5).
    sendJson(res, 500, {
      error: "degraded",
      message: "internal error",
      request_id: "n/a",
    });
  }
}

/** Wire the default service from a loaded config (production path). */
export function buildService(config: JanusConfig): JanusService {
  const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
  audit.start();
  const chain = buildProviderChain(config);
  const evaluator = new Evaluator({
    config,
    singleFlight: new SingleFlight(config.maxConcurrent),
    budget: new DailyBudget(
      config.dailyTokenCeiling,
      config.dailyCostCeilingUsd,
      config.costPerMtokenUsd,
    ),
    audit,
    chain,
  });
  const service = createJanusService(config, evaluator, () => chain.readiness());
  const stop = service.stop;
  return {
    ...service,
    stop: () => {
      audit.stop();
      return stop();
    },
  };
}

/** Entry point: `npx tsx janus/server.ts` (dev) or launchd (label user.janus). */
export function main(): void {
  const configPath = process.env.JANUS_CONFIG_PATH;
  const { config, warnings } = loadConfig(configPath || undefined);
  for (const warning of warnings) console.error(`janus: ${warning}`);
  const service = buildService(config);
  service.server.on("listening", () => {
    console.error(`janus: listening on 127.0.0.1:${config.port} (loopback only)`);
    console.error(`janus: audit log at ${config.audit.path === "stdout" ? "stdout" : `${config.audit.path}.jsonl`}`);
  });
  const shutdown = () => {
    void service.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

import { loadConfig } from "./config.js";

/** Direct-run entrypoint: `npx tsx janus/server.ts`. */
export function runIfMain(invokedPath: string): void {
  if (!invokedPath.endsWith("server.ts")) return;
  main();
}

if (process.argv[1] && process.argv[1].endsWith("janus/server.ts")) {
  main();
}
