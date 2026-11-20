// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daybreakBluePayload, registerDaybreakBlue } from '../scripts/enforcement/daybreak_blue_pi.js';

// Public checkouts do not ship the private model list. Tests already name the
// entitling model and export it to the hook when the local config is absent.
if (!process.env.PAD_DAYBREAK_MODELS) {
  process.env.PAD_DAYBREAK_MODELS = 'gpt-6-sol';
}

const model = (id, provider = 'openai-codex') => ({ id, provider });
const body = (id, extras = {}) => ({ model: id, store: false, include: ['reasoning.encrypted_content'], instructions: 'test', ...extras });
// The repository Pi SDK devDependencies install on CI; missing packages fail the tests.
// These imports never open auth files or a network connection.
const runnerPath = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js', import.meta.url);
const providerPath = new URL('../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js', import.meta.url);

// Why: outgoing body model controls the entitlement even when a virtual session model differs.
test('only Codex-shaped 6-sol receives Daybreak; every other request loses inherited cyber', () => {
  assert.deepEqual(daybreakBluePayload(body('gpt-6-sol')).access_programs, { cyber: 'daybreak_blue' });
  const providerShaped = { model: 'gpt-6-sol', store: false, include: ['reasoning.encrypted_content'], input: [] };
  assert.deepEqual(daybreakBluePayload(providerShaped).access_programs, { cyber: 'daybreak_blue' });
  assert.equal(daybreakBluePayload(body('gpt-6.1-sol')), undefined);
  assert.equal(daybreakBluePayload(body('gpt-6-sol', { include: [] })), undefined);
  for (const id of ['gpt-6.1-sol', 'other']) {
    assert.deepEqual(daybreakBluePayload(body(id, { access_programs: { cyber: 'daybreak_blue', other: true } })).access_programs, { other: true });
  }
  assert.deepEqual(daybreakBluePayload({ model: 'gpt-6-sol', access_programs: { cyber: 'daybreak_blue' } }), { model: 'gpt-6-sol' });
  assert.deepEqual(daybreakBluePayload(body('gpt-6.1-sol', { access_programs: 'invalid' })), body('gpt-6.1-sol'));
});

// Why: mismatched ctx.model, a router, or an earlier handler must not change the outgoing-body decision.
test('registered handler uses request body, not ctx.model, and strips earlier cyber', () => {
  let hook;
  registerDaybreakBlue({ on(name, callback) { assert.equal(name, 'before_provider_request'); hook = callback; } });
  assert.equal(hook({ payload: body('gpt-6-sol') }, { model: model('virtual', 'router') }).access_programs.cyber, 'daybreak_blue');
  assert.deepEqual(hook({ payload: body('gpt-6.1-sol', { access_programs: { cyber: 'daybreak_blue' } }) }, { model: model('gpt-6-sol') }), body('gpt-6.1-sol'));
});

// Why: Pi's actual runner must sanitize earlier edits and reveal that later handlers can still override the body.
test('installed Pi runner pipeline handles earlier, router, and later handlers', async () => {
  const { ExtensionRunner } = await import(runnerPath.href);
  const named = (path, handlers) => ({ path, handlers: new Map([['before_provider_request', handlers]]) });
  const early = named('earlier', [({ payload }) => ({ ...payload, model: 'gpt-6.1-sol', access_programs: { cyber: 'daybreak_blue' } })]);
  const ours = [];
  registerDaybreakBlue({ on(name, fn) { assert.equal(name, 'before_provider_request'); ours.push(fn); } });
  const pad = named('pad', ours);
  const makeRunner = extensions => {
    const runner = new ExtensionRunner(extensions, {}, process.cwd(), {}, {});
    runner.getModel = () => model('virtual', 'router');
    return runner;
  };
  const stripped = await makeRunner([early, pad]).emitBeforeProviderRequest(body('gpt-6-sol'));
  assert.equal(stripped.model, 'gpt-6.1-sol');
  assert.equal(stripped.access_programs, undefined);
  const routed = await makeRunner([pad]).emitBeforeProviderRequest(body('gpt-6-sol'));
  assert.equal(routed.access_programs.cyber, 'daybreak_blue');
  const later = named('later', [({ payload }) => ({ ...payload, access_programs: { cyber: 'daybreak_blue' } })]);
  const overridden = await makeRunner([early, pad, later]).emitBeforeProviderRequest(body('gpt-6-sol'));
  assert.equal(overridden.model, 'gpt-6.1-sol');
  assert.equal(overridden.access_programs.cyber, 'daybreak_blue', 'later-handler risk remains visible');
});

// Repository Pi SDK provider (the Pi CLI bundles equivalent code), intercepted at fetch.
// No auth or network: synthetic JWT and fake response. Missing SDK fails in CI.
for (const id of ['gpt-6-sol', 'gpt-6.1-sol']) {
  // Why: deliberately inspect the bytes passed by the installed provider to HTTP.
  test(`installed Pi provider outgoing HTTP body ${id} (deliberate-break)`, async () => {
    const { stream } = await import(providerPath.href);
    const token = ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account' } })).toString('base64url'), 'fake'].join('.');
    let captured;
    const fakeFetch = async (_url, init) => {
      let bytes = init.body;
      if (typeof bytes !== 'string') {
        const zlib = await import('node:zlib');
        bytes = zlib.zstdDecompressSync(bytes).toString('utf8');
      }
      captured = JSON.parse(bytes);
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fake","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const agent = { ...model(id), api: 'openai-codex-responses', baseUrl: 'https://example.invalid', headers: {}, reasoning: false, contextWindow: 10000, maxTokens: 1000, input: ['text'], output: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const request = stream(agent, { messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'hi', timestamp: Date.now() }] }, { apiKey: token, transport: 'sse', fetch: fakeFetch, onPayload: (requestBody) => daybreakBluePayload(id === 'gpt-6.1-sol' ? { ...requestBody, access_programs: { cyber: 'daybreak_blue' } } : requestBody) });
    try { await request.result(); } catch { /* Response parser is not the subject; captured fetch body is. */ }
    assert.ok(captured, 'real provider must reach fake HTTP transport');
    if (id === 'gpt-6-sol') assert.equal(captured.access_programs?.cyber, 'daybreak_blue');
    else assert.equal(captured.access_programs?.cyber, undefined, 'deliberate break: standard model must not carry Daybreak');
  });
}
