import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const model = JSON.parse(readFileSync(new URL('../docs/state-machines/codex-boundary/guard-model.v1.json', import.meta.url), 'utf8'));
const guardFile = process.env.PAD_GUARD_MUTANT_PATH || resolve('scripts/enforcement/attended_authority_guard.js');
const { classifyBashCommand } = await import(pathToFileURL(guardFile).href);
const commFile = process.env.PAD_ACK_MUTANT_PATH || resolve('scripts/enforcement/herdr_communication_pi.js');
const { executeHerdrPromptExchange } = await import(pathToFileURL(commFile).href);
const dispatchFile = process.env.PAD_DISPATCH_MUTANT_PATH || resolve('scripts/enforcement/herdr_async_dispatch_pi.js');
const { runWorkerJourney } = await import(pathToFileURL(dispatchFile).href);
const tla = readFileSync(new URL('../docs/state-machines/codex-boundary/AckHandoff.tla', import.meta.url), 'utf8');
const tlaSet = (name) => tla.match(new RegExp(name + ' == \\{([^}]+)\\}', 's'))?.[1].match(/"[^"]+"/g)?.map((item) => item.slice(1, -1));
const modes = tlaSet('FailureModes');
const preModes = tlaSet('PreModes');
const uncertainModes = tlaSet('UncertainModes');
const unresponsiveReasons = tlaSet('UnresponsiveReasons');
assert.equal(preModes?.length, 4, 'the TLA+ preflight set must be replayable');
assert.equal(model.schema, 'pad.codex-boundary.guard-model.v1');
assert.equal(modes?.length, 9, 'the TLA+ refusal set must be replayable');
assert.equal(uncertainModes?.length, 4, 'the TLA+ uncertain set must be replayable');
assert.ok(unresponsiveReasons?.length > 0, 'the TLA+ dispatch reprompt guard must be replayable');
const guardTraces = [
  ...model.allowedCommands.map((command) => ({ command, allowed: true })),
  ...model.searchHeads.flatMap((head) => model.safePaths.map((path) => ({ command: head + ' ' + path, allowed: true }))),
  ...model.searchHeads.flatMap((head) => model.unsafePaths.map((path) => ({ command: head + ' ' + path, allowed: false }))),
  ...model.searchHeads.flatMap((head) => model.safePaths.flatMap((path) => model.unsafeSuffixes.map((suffix) => ({ command: head + ' ' + path + ' ' + suffix, allowed: false })))),
  ...model.opaqueLaunchers.map((command) => ({ command, allowed: false })),
  ...model.counterexamplesFromRR5.map((command) => ({ command, allowed: false })),
  ...model.gitConfigForms.flatMap((form) => model.gitLaunchKeys.map((key) => ({ command: form.replace('{key}', key), allowed: false }))),
  ...model.environmentLaunchers.map((command) => ({ command, allowed: false })),
  ...model.scriptOperands.map((command) => ({ command, allowed: false })),
  ...model.allowedNearMisses.map((command) => ({ command, allowed: true })),
];

// Why: the decision table generates the product of search forms, paths and executable options, so a new path class cannot silently take the safe branch.
test('model-generated guard traces enforce the bounded no-launch decision table', () => {
  assert.ok(guardTraces.length >= 70, 'model must enumerate multiple independent input axes');
  for (const trace of guardTraces) {
    const observed = classifyBashCommand(trace.command);
    if (trace.allowed) assert.equal(observed.destructive, false, trace.command);
    else assert.equal(observed.forbidden, true, trace.command);
  }
});

// Why: RR6 found Git launch keys accepted with other case, after -C or --no-pager, through config set/-f/--config-env, through Git or ripgrep environment variables, and shell script operands without a .sh suffix.
test('RR6 Git, environment and script-operand counterexamples are refused', () => {
  for (const command of model.counterexamplesFromRR6) {
    assert.equal(classifyBashCommand(command).forbidden, true, command);
  }
  for (const command of model.allowedNearMisses) {
    assert.equal(classifyBashCommand(command).forbidden, undefined, command);
  }
});

const echoReport = (echoed) => 'synthetic history\n' + echoed + '\n[WORKER_REPORT_BEGIN]\nsynthetic report\n[WORKER_REPORT_END]\n';

// Each TLA+ FailureModes element names one fault after a returned prompt; the
// fake otherwise supplies a valid report, so only that fault can refuse.
const expectedPostCodes = {
  'kind-missing': 'agent_mismatch', 'kind-unsupported': 'agent_mismatch', 'kind-empty': 'unexpected_result',
  'kind-switched': 'agent_mismatch', 'status-invalid': 'status_invalid', 'status-blocked': 'role_blocked',
  'read-failed': 'herdr_process_failed', 'read-timeout': 'process_timeout', 'report-missing': 'report_missing',
};

function postPromptProcess(mode, calls, roleRoot = process.cwd()) {
  let reads = 0;
  let echoed = '';
  return async ({ argv }) => {
    const action = argv[1];
    calls.push(action);
    if (action === 'get') return { code: 0, stdout: JSON.stringify({ type: 'agent_info', agent: {
      name: argv[2] || 'worker', agent: 'pi', status: 'idle', cwd: roleRoot, repository: roleRoot,
    } }) };
    if (action === 'read') {
      reads += 1;
      if (reads % 2 === 1) return { code: 0, stdout: 'synthetic history' };
      if (mode === 'read-failed') return { code: 1, stderr: 'synthetic read failure' };
      if (mode === 'read-timeout') return { internalFailure: 'timeout' };
      return { code: 0, stdout: mode === 'report-missing' ? 'synthetic history\n' + echoed + '\n' : echoReport(echoed) };
    }
    if (action === 'prompt') {
      echoed = String(argv[3] ?? '');
      const agent = { name: argv[2] || 'worker', agent: 'pi', status: 'done', cwd: roleRoot, repository: roleRoot };
      if (mode === 'kind-missing') agent.agent = null;
      if (mode === 'kind-unsupported') agent.agent = 'opencode';
      if (mode === 'kind-empty') agent.agent = '';
      if (mode === 'kind-switched') agent.agent = 'claude';
      if (mode === 'status-invalid') agent.status = 'not-a-status';
      if (mode === 'status-blocked') agent.status = 'blocked';
      return { code: 0, stdout: JSON.stringify({ type: 'agent_prompted', agent }) };
    }
    throw new Error('unexpected synthetic transport action');
  };
}

const exchange = (runProcess) => executeHerdrPromptExchange(
  { action: 'prompt', role: 'worker', prompt: 'synthetic', timeoutMs: 1000 },
  { cwd: process.cwd() }, { runProcess },
);

// Why: each refusal trace comes from the checked TLA+ mode set and must distinguish a returned prompt from a pre-prompt denial; a valid report elsewhere keeps one mode from masking another's missing check.
test('TLA+ acknowledgement modes replay against fake Herdr', async () => {
  assert.deepEqual(Object.keys(expectedPostCodes).sort(), [...modes].sort(), 'every TLA+ refusal mode needs an expected code');
  const completeCalls = [];
  const complete = await exchange(postPromptProcess('complete', completeCalls));
  assert.equal(complete.ok, true, 'AckComplete must be reachable with the same fake');
  assert.equal(completeCalls.filter((action) => action === 'prompt').length, 1);
  for (const mode of modes) {
    const calls = [];
    const result = await exchange(postPromptProcess(mode, calls));
    assert.equal(result.ok, false, mode);
    assert.equal(result.code, expectedPostCodes[mode], mode);
    assert.equal(calls.filter((action) => action === 'prompt').length, 1, mode);
    assert.equal(result.deliveryState, 'unattributed', mode);
    assert.match(result.reason, /^a prompt was sent;/, mode);
  }
});

// Why: the TLA+ pre-refusal transitions must never be mistaken for a returned prompt acknowledgement, including a non-Codex kind change between the two observations.
test('TLA+ preflight traces never claim a send', async () => {
  const expectedPre = {
    'first-codex': ['codex_readback_unavailable', ['get']],
    'second-codex': ['codex_readback_unavailable', ['get', 'read', 'get']],
    'kind-changed-before': ['agent_kind_changed', ['get', 'read', 'get']],
    'read-failed-before': ['report_scope_unavailable', ['get', 'read']],
  };
  assert.deepEqual(Object.keys(expectedPre).sort(), [...preModes].sort());
  for (const mode of preModes) {
    const calls = [];
    let gets = 0;
    const pre = await exchange(({ argv }) => {
      calls.push(argv[1]);
      if (argv[1] === 'get') {
        gets += 1;
        const kind = mode === 'first-codex' || (mode === 'second-codex' && gets === 2) ? 'codex'
          : mode === 'kind-changed-before' && gets === 2 ? 'claude' : 'pi';
        return { code: 0, stdout: JSON.stringify({ type: 'agent_info', agent: { name: 'worker', agent: kind, status: 'idle', cwd: process.cwd() } }) };
      }
      if (argv[1] === 'read') return mode === 'read-failed-before'
        ? { code: 1, stderr: 'synthetic snapshot failure' } : { code: 0, stdout: 'synthetic history' };
      throw new Error('preflight must not hand off');
    });
    assert.equal(pre.deliveryState, undefined, mode);
    assert.equal(pre.code, expectedPre[mode][0], mode);
    assert.doesNotMatch(pre.reason, /^a prompt was sent;/, mode);
    assert.deepEqual(calls, expectedPre[mode][1], mode);
  }
});

// Why: a failed prompt invocation is uncertain, so every TLA+ UncertainModes trace, including a stalled prompt whose role advanced to idle, must be marked unknown and never retried.
test('TLA+ uncertain prompt traces are marked unknown', async () => {
  const expectedUncertain = {
    transport: 'prompt_handoff_uncertain', 'stalled-advanced': 'prompt_stalled',
    'stalled-unknown': 'prompt_delivery_unknown', 'stalled-recovery-failed': 'prompt_delivery_unknown',
  };
  assert.deepEqual(Object.keys(expectedUncertain).sort(), [...uncertainModes].sort());
  for (const mode of uncertainModes) {
    const calls = [];
    let gets = 0;
    const result = await exchange(({ argv }) => {
      calls.push(argv[1]);
      if (argv[1] === 'get') {
        gets += 1;
        if (gets === 3 && mode === 'stalled-recovery-failed') return { code: 1, stderr: 'synthetic recovery failure' };
        return { code: 0, stdout: JSON.stringify({ type: 'agent_info', agent: {
          name: 'worker', agent: 'pi', cwd: process.cwd(),
          status: gets === 3 && mode === 'stalled-unknown' ? 'working' : 'idle',
          state_change_seq: gets === 3 && mode === 'stalled-advanced' ? 9 : 1,
        } }) };
      }
      if (argv[1] === 'read') return { code: 0, stdout: 'synthetic history' };
      if (argv[1] === 'prompt') return mode === 'transport'
        ? { code: 1, stderr: 'synthetic failure' }
        : { code: 2, stdout: JSON.stringify({ error: { code: 'agent_prompt_stalled' } }) };
      throw new Error('unexpected synthetic transport action');
    });
    assert.equal(result.code, expectedUncertain[mode], mode);
    assert.equal(result.deliveryState, 'unknown', mode);
    assert.match(result.reason, /may have been sent|delivery is unknown/, mode);
    assert.equal(calls.filter((action) => action === 'prompt').length, 1, mode);
  }
});

// Why: NoRepromptAfterReturn. Autonomous dispatch re-prompted the same role after a returned prompt whose report read timed out; no post-prompt refusal may lead to a second prompt.
test('dispatch never re-prompts after any TLA+ post-prompt refusal', async () => {
  const root = process.cwd();
  for (const mode of modes) {
    const calls = [];
    const journey = await runWorkerJourney(
      { action: 'dispatch', role: 'worker', stepPrompt: 'synthetic', autonomy: 'autonomous', model: 'test-model', cast: { roles: ['worker'], models: { worker: 'test-model' } } },
      { mode: 'tui', hasUI: true, cwd: root, ui: { confirm: async () => true } },
      { enableAutonomy: true, runProcess: postPromptProcess(mode, calls, root),
        taskStore: { list: () => [{ id: '1', status: 'pending' }] },
        spawnReplacement: async ({ role }) => ({ ok: true, role, repository: root }) },
    );
    assert.equal(calls.filter((action) => action === 'prompt').length, 1, mode + ' ' + JSON.stringify(journey.steps));
    assert.ok(!journey.steps.some((step) => step.status === 'replaced' || step.handoff), mode);
  }
});
