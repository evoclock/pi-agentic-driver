import test from 'node:test';
import assert from 'node:assert/strict';
import { executeHerdrCommunication, resetHerdrDeliveriesForTests } from '../scripts/enforcement/herdr_communication_pi.js';
const root = process.cwd();
const agent = (extra = {}) => ({ name: 'worker', agent: 'pi', status: 'idle', repository: root, pane_id: 'w7:p10', ...extra });
const json = (type, a) => ({ code: 0, stdout: JSON.stringify({ type, agent: a }) });

// Why: idle alone is not native proof that the input endpoint has initialized.
test('ready is a closed native observation, not an idle inference', async () => {
  for (const ready of [true, false, undefined]) {
    const result = await executeHerdrCommunication({ action: 'ready', role: 'worker' }, { cwd: root }, {
      runProcess: async ({ argv }) => argv[0] === 'tab' ? { code: 0, stdout: '{"tabs":[]}' } : json('agent_info', agent({ interactive_ready: ready, launch_pending: false })),
    });
    if (ready === true) assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.inputReady === true, ready === true);
    assert.equal(result.authorityCreated, false);
  }
  const closed = await executeHerdrCommunication({ action: 'ready', role: 'worker', command: 'bad' }, { cwd: root });
  assert.equal(closed.code, 'closed_parameters');
});

// Why: a full current echoed handoff can confirm input before the model finishes a report.
test('delivery exposes positive input receipt only after the full current echo', async () => {
  resetHerdrDeliveriesForTests();
  let sent = ''; let echo = false;
  const options = { runProcess: async ({ argv }) => {
    if (argv[0] === 'tab') return { code: 0, stdout: '{"tabs":[]}' };
    if (argv[1] === 'get') return json('agent_info', agent());
    if (argv[1] === 'prompt') { sent = argv[3]; return json('agent_prompted', agent()); }
    if (argv[1] === 'read') return { code: 0, stdout: `history\n${echo ? sent : ''}` };
    throw new Error('unexpected fake call');
  } };
  const delivery = await executeHerdrCommunication({ action: 'submit', role: 'worker', prompt: 'bounded brief', timeoutMs: 1000 }, { cwd: root }, options);
  assert.equal(delivery.ok, true);
  const query = () => executeHerdrCommunication({ action: 'delivery', role: 'worker', deliveryId: delivery.deliveryId }, { cwd: root }, options);
  assert.notEqual((await query()).inputReceived, true);
  echo = true;
  const received = await query();
  assert.equal(received.inputReceived, true);
  assert.equal(received.deliveryState, 'delivered');
  assert.equal(received.authorityCreated, false);
});
