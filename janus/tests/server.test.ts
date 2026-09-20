// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// HTTP surface tests: loopback bind, endpoint contract, JSON error shape,
// and the GET routes. The SDK is mocked; no live gateway calls.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJanusService, type JanusService } from "../janus/server.js";
import { Evaluator } from "../janus/evaluate.js";
import { SingleFlight } from "../janus/single_flight.js";
import { DailyBudget } from "../janus/budget_breaker.js";
import { AuditLog } from "../janus/audit.js";
import { testConfig, mockChain } from "./helpers.js";

async function listenOnRandomPort(): Promise<{ service: JanusService; base: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "janus-server-test-"));
  const config = testConfig({
    port: 0,
    audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 },
  });
  const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
  audit.start();
  const evaluator = new Evaluator({
    config,
    singleFlight: new SingleFlight(4),
    budget: new DailyBudget(0, 0, 0.5),
    audit,
    chain: mockChain({ answers: { q: { type: "boolean", probability: 0.95 } } }) as never,
  });
  const service = createJanusService(config, evaluator, async () => ({ ready: true }));
  await new Promise<void>((resolvePromise) => service.server.on("listening", resolvePromise));
  const address = service.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    service,
    base,
    cleanup: async () => {
      await service.stop();
      audit.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("binds loopback only", async () => {
  const { service, cleanup } = await listenOnRandomPort();
  try {
    const address = service.server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(address.address, "127.0.0.1");
  } finally {
    await cleanup();
  }
});

test("GET /healthz returns ok", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
  } finally {
    await cleanup();
  }
});

test("GET /version returns janus, AI SDK, schema versions, and allowlist", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/version`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.janus, "0.1.0");
    assert.equal(body.typesafeSdk, "0.6.0");
    assert.equal(body.questionSchema, "janus.question-schema.v2");
    assert.deepEqual(body.providers, ["typesafe-direct"]);
  } finally {
    await cleanup();
  }
});

test("POST /evaluate happy path returns verdict with request_id", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "s", questions: [{ type: "boolean", name: "q", question: "q" }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { request_id: string; verdict: Record<string, unknown> };
    assert.ok(body.request_id.length > 0);
    assert.deepEqual(body.verdict, { q: { type: "boolean", probability: 0.95, passed: true } });
  } finally {
    await cleanup();
  }
});

test("POST /evaluate invalid JSON is validation_error", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "validation_error");
  } finally {
    await cleanup();
  }
});

test("unknown route is 404 with the taxonomy shape", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "validation_error");
  } finally {
    await cleanup();
  }
});

test("POST /evaluate without content-type is validation_error (review fix #10)", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/evaluate`, {
      method: "POST",
      body: JSON.stringify({ state: "s", questions: [] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "validation_error");
    assert.match(body.message, /content-type/);
  } finally {
    await cleanup();
  }
});

test("POST /evaluate with malformed content-type is validation_error (review fix #10)", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/evaluate`, {
      method: "POST",
      headers: { "content-type": "not a valid type;;;" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "validation_error");
  } finally {
    await cleanup();
  }
});

test("POST /evaluate with non-JSON content-type is validation_error (review fix #10)", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/evaluate`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "validation_error");
  } finally {
    await cleanup();
  }
});

test("POST /evaluate accepts application/json with parameters (charset) (review fix #10)", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    const res = await fetch(`${base}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ state: "s", questions: [{ type: "boolean", name: "q", question: "q" }] }),
    });
    assert.equal(res.status, 200);
  } finally {
    await cleanup();
  }
});

test("oversized body returns structured JSON 413 (review fix #10)", async () => {
  const { base, cleanup } = await listenOnRandomPort();
  try {
    // 9 MB body against the 8 MB cap, sent with a JSON content-type.
    const big = "x".repeat(9 * 1024 * 1024);
    const res = await fetch(`${base}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: big, questions: [{ type: "boolean", name: "q", question: "q" }] }),
    });
    assert.ok([400, 413].includes(res.status));
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "validation_error");
  } finally {
    await cleanup();
  }
});

test("GET /readyz reports readiness from the provider chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "janus-server-test-"));
  try {
    const config = testConfig({
      port: 0,
      audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 },
    });
    const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
    audit.start();
    const evaluator = new Evaluator({
      config,
      singleFlight: new SingleFlight(4),
      budget: new DailyBudget(0, 0, 0.5),
      audit,
      chain: mockChain({ answers: { q: { type: "boolean", probability: 0.95 } } }) as never,
    });
    const service = createJanusService(config, evaluator, async () => ({
      ready: false,
      reason: "no provider credential resolvable (checked: typesafe-direct)",
    }));
    await new Promise<void>((resolvePromise) => service.server.on("listening", resolvePromise));
    const address = service.server.address();
    assert.ok(address && typeof address === "object");
    const res = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { reason: string };
    assert.match(body.reason, /no provider credential resolvable/);
    assert.ok(!/sk-|test-key/i.test(body.reason), "no key fragments in the public reason");
    await service.stop();
    audit.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("internal evaluator crash returns a fixed public degraded message (review fix #5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "janus-server-test-"));
  try {
    const config = testConfig({
      port: 0,
      audit: { path: join(dir, "audit"), maxBytes: 1024 * 1024, retentionDays: 90 },
    });
    const audit = new AuditLog(config.audit.path, config.audit.maxBytes, config.audit.retentionDays);
    audit.start();
    const evaluator = new Evaluator({
      config,
      singleFlight: new SingleFlight(4),
      budget: new DailyBudget(0, 0, 0.5),
      audit,
      chain: {
        evaluate: async () => {
          throw new Error("SECRET sk-live-abc123 internal stack trace detail");
        },
        readiness: async () => ({ ready: true, providers: [] }),
      } as never,
    });
    const service = createJanusService(config, evaluator, async () => ({ ready: true }));
    await new Promise<void>((resolvePromise) => service.server.on("listening", resolvePromise));
    const address = service.server.address();
    assert.ok(address && typeof address === "object");
    const res = await fetch(`http://127.0.0.1:${address.port}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "s", questions: [{ type: "boolean", name: "q", question: "q" }] }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "gateway_unavailable");
    assert.equal(body.message, "provider evaluation failed");
    assert.ok(!body.message.includes("SECRET"), "internal error text must never reach the caller");
    await service.stop();
    audit.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
