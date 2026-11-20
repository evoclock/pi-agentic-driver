import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const runtimeUrl = new URL('../scripts/enforcement/linux_microvm_checks_runtime.js', import.meta.url);
const runtime = existsSync(runtimeUrl) ? await import(runtimeUrl.href) : null;

// Why: G8 core ships the authenticated interface, not the deferred live Linux backend.
test('core production guest drivers cannot load, probe or execute a live backend', async () => {
  assert.ok(runtime, 'authenticated guest adapter interface must exist');
  const drivers = runtime.productionChecksDrivers({profile:'/nonexistent-profile'});
  assert.equal(typeof drivers.loadRequest, 'function');
  assert.equal(await drivers.loadTarget(), null);
  assert.equal(await drivers.probe({}, {}), null);
  await assert.rejects(drivers.run({}, {}), /checks-runner-unavailable/);
});
