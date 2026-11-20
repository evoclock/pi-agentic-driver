import test from 'node:test';
import assert from 'node:assert/strict';
import { executeHerdrCommunication, registerHerdrCommunicationInterface, resetHerdrDeliveriesForTests } from '../scripts/enforcement/herdr_communication_pi.js';
import { guardToolCall } from '../scripts/enforcement/attended_authority_guard.js';

const root = process.cwd();
const paneId = 'wW:p6';
const tabId = 'wW:t6';
const role = 'claude';
// The observed 0.9.1 Claude Code pane is unnamed. Only a unique tab label
// and matching live pane readback may supply its role.
function fixture({ kind = 'claude', cwd = root, labels = [{ label: role, tab_id: tabId, root_pane_id: paneId }], ackKind = kind, status = 'idle' } = {}) {
  const calls = [];
  const state = { kind, status };
  const pane = () => ({ pane_id: paneId, tab_id: tabId, name: null, agent: state.kind,
    agent_session: { agent: state.kind, source: `herdr:${state.kind}`, kind: 'id' },
    agent_status: state.status, cwd });
  const runProcess = async ({ argv }) => {
    calls.push(argv);
    if (argv[0] === 'tab') return { code: 0, stdout: JSON.stringify({ tabs: labels }) };
    if (argv[0] === 'pane') return { code: 0, stdout: JSON.stringify({ pane: pane() }) };
    if (argv[1] === 'get') return { code: 1, stdout: JSON.stringify({ error: { code: 'agent_not_found' } }) };
    if (argv[1] === 'read') return { code: 0, stdout: 'ordinary terminal output, no Pi report marker' };
    if (argv[1] === 'prompt') return { code: 0, stdout: JSON.stringify({ type: 'agent_prompted', agent: { ...pane(), agent: ackKind, agent_session: { agent: ackKind, source: `herdr:${ackKind}`, kind: 'id' }, agent_status: 'working', status: 'working' } }) };
    if (argv[1] === 'wait') return { code: 0, stdout: JSON.stringify({ type: 'agent_waited', agent: { ...pane(), agent: ackKind, agent_session: { agent: ackKind, source: `herdr:${ackKind}`, kind: 'id' }, status: 'idle' } }) };
    throw new Error(`unexpected fake argv ${argv.join(' ')}`);
  };
  return { runProcess, calls, state };
}
test.beforeEach(() => resetHerdrDeliveriesForTests());

// Why: a real-shaped unnamed Claude pane should resolve only through a unique labeled tab and read-back.
test('Claude Code fixture resolves via label, matching pane and trusted repository', async () => {
  const f = fixture();
  const result = await executeHerdrCommunication({ action: 'get', role }, { cwd: root }, f);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.observation.agentKind, 'claude');
  assert.ok(f.calls.some((argv) => argv[0] === 'pane' && argv[2] === paneId));
});

// Why: a fake Claude submit is a handoff, not a completed answer; unmarked terminal text is never attributed.
test('fake Claude submit receipts and delivery remain unverified without a correlated report', async () => {
  const f = fixture();
  const receipt = await executeHerdrCommunication({ action: 'submit', role, prompt: 'Review this bounded change', timeoutMs: 1000 }, { cwd: root }, f);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.nonAuthorizing, true);
  assert.equal(f.calls.filter((argv) => argv[1] === 'prompt').length, 1);
  const delivery = await executeHerdrCommunication({ action: 'delivery', deliveryId: receipt.deliveryId }, { cwd: root }, f);
  assert.notEqual(delivery.deliveryState, 'answered');
  assert.equal(f.calls.filter((argv) => argv[1] === 'prompt').length, 1);
});

// Why: a kind outside the allowlist or a mismatched prompt acknowledgment must not pass readback.
test('unsupported kind and kind-changing acknowledgment are refused', async () => {
  assert.equal((await executeHerdrCommunication({ action: 'get', role }, { cwd: root }, fixture({ kind: 'shell' }))).code, 'agent_mismatch');
  const result = await executeHerdrCommunication({ action: 'submit', role, prompt: 'brief', timeoutMs: 1000 }, { cwd: root }, fixture({ ackKind: 'codex' }));
  assert.equal(result.code, 'delivery_unconfirmed', JSON.stringify(result));
  assert.equal(result.deliveryState, 'unknown');
});

// Why: a queued Claude brief must never be sent after the labeled pane switches cleanly to Codex.
test('queued Claude delivery refuses a switched Codex pane before sending', async () => {
  const f = fixture({ status: 'working' });
  const queued = await executeHerdrCommunication({ action: 'submit', role, prompt: 'queued review', timeoutMs: 1000 }, { cwd: root }, f);
  assert.equal(queued.deliveryState, 'queued', JSON.stringify(queued));
  f.state.kind = 'codex'; f.state.status = 'idle';
  const attempted = await executeHerdrCommunication({ action: 'delivery', deliveryId: queued.deliveryId }, { cwd: root }, f);
  assert.equal(attempted.code, 'agent_mismatch', JSON.stringify(attempted));
  assert.equal(attempted.deliveryState, 'queued');
  assert.equal(f.calls.filter((argv) => argv[1] === 'prompt').length, 0);
});

// Why: pane identity, not a role label, must refuse sending a brief to the caller's own pane or tab.
test('own pane and tab identity are denied regardless of role label', async () => {
  const previousPane = process.env.HERDR_PANE_ID;
  const previousTab = process.env.HERDR_TAB_ID;
  try {
    process.env.HERDR_PANE_ID = paneId;
    delete process.env.HERDR_TAB_ID;
    const ownPane = fixture();
    assert.equal((await executeHerdrCommunication({ action: 'submit', role, prompt: 'no self', timeoutMs: 1000 }, { cwd: root }, ownPane)).code, 'self_target_denied');
    assert.equal(ownPane.calls.filter((argv) => argv[1] === 'prompt').length, 0);
    delete process.env.HERDR_PANE_ID;
    process.env.HERDR_TAB_ID = tabId;
    assert.equal((await executeHerdrCommunication({ action: 'get', role }, { cwd: root }, fixture())).code, 'self_target_denied');
  } finally {
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousPane;
    if (previousTab === undefined) delete process.env.HERDR_TAB_ID; else process.env.HERDR_TAB_ID = previousTab;
  }
});

// Why: a label collision or cwd outside trusted repositories must never permit a handoff.
test('ambiguous label and repository mismatch refuse fake Claude pane', async () => {
  const duplicate = fixture({ labels: [{ label: role, tab_id: tabId, root_pane_id: paneId }, { label: role, tab_id: 'wW:t7', root_pane_id: 'wW:p7' }] });
  assert.equal((await executeHerdrCommunication({ action: 'get', role }, { cwd: root }, duplicate)).code, 'ambiguous_target_role');
  assert.equal((await executeHerdrCommunication({ action: 'get', role }, { cwd: root }, fixture({ cwd: '/untrusted/repository' }))).code, 'repository_mismatch');
});

// Why: fleet guard blocks raw Herdr shell control while the same fake Claude submit uses the bounded tool route.
test('fleet guard denies raw Herdr and permits a fake Claude submit through the registered route', async () => {
  const raw = await guardToolCall({ toolName: 'bash', input: { command: 'herdr agent prompt claude dangerous' } }, { cwd: root });
  assert.equal(raw?.block, true);
  const registered = []; const pi = { registerTool: (tool) => registered.push(tool) };
  registerHerdrCommunicationInterface(pi);
  assert.equal(registered.length, 1);
  assert.equal(await guardToolCall({ toolName: registered[0].name, input: { action: 'submit', role, prompt: 'fake' } }, { cwd: root }), undefined);
  const f = fixture();
  const fake = await executeHerdrCommunication({ action: 'submit', role, prompt: 'fake review', timeoutMs: 1000 }, { cwd: root }, f);
  assert.equal(fake.ok, true, JSON.stringify(fake));
  assert.equal(fake.nonAuthorizing, true);
});

// Why: introducing non-Pi comms must reuse exactly one guarded tool registration.
test('tool registration remains single for the same Pi host', () => {
  const names = []; const pi = { registerTool: (tool) => names.push(tool.name) };
  registerHerdrCommunicationInterface(pi); registerHerdrCommunicationInterface(pi);
  assert.deepEqual(names, ['agentic_herdr_communication']);
});
