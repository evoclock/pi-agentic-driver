// Host-runnable, read-only source mutation controls. Every copy is temporary.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const controls = [
{"name":"exit-gate-required","target":"workflow_runner_core.mjs","pattern":"verified receipt does not advance","old":"if (exitRequired(w, s) && !checksPassed(w, s))","replacement":"if (false)","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-fresh-commit","target":"workflow_runner_core.mjs","pattern":"evidence from an earlier commit","old":"s.exit.binding.commit === s.pending?.commit","replacement":"true","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-nonempty","target":"workflow_runner_exit.mjs","pattern":"no repo defaults and no design checks","old":"if (!checks.length) return { park: 'checks-undeclared' }","replacement":"if (false) return { park: 'checks-undeclared' }","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-invariant-coverage","target":"workflow_runner_exit.mjs","pattern":"an invariant without a covering","old":"if (uncovered.length)","replacement":"if (false)","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-frozen-source","target":"workflow_runner_exit.mjs","pattern":"worker commit that weakens","old":"show(w.revision, '.driver/exit-checks.json')","replacement":"show('HEAD', '.driver/exit-checks.json')","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-zero-tests","target":"workflow_runner_exit.mjs","pattern":"a test command that observes zero","old":"return fail('zero-tests','checks-zero-tests')","replacement":"return fail('fail','checks-failed')","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-tree-unchanged","target":"workflow_runner_exit.mjs","pattern":"a check that modifies tracked files","old":"if (after.head !== request.commit || after.dirty || request.outputs && !outputSnapshotMatches(request.repo,request.commit,request.outputs))","replacement":"if (false)","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-no-done-with-gaps","target":"workflow_runner_core.mjs","pattern":"a step never advances while","old":"(s.exit.gaps?.gapSet?.length ?? 0) === 0","replacement":"true","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-no-progress-park","target":"workflow_runner_exit.mjs","pattern":"same gap set for noProgressLimit","old":"staleStreak >= noProgressLimit","replacement":"false","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-ceiling-park","target":"workflow_runner_exit.mjs","pattern":"hitting the safety ceiling","old":"passes + 1 >= safetyCeiling","replacement":"false","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-gaps-in-prompt","target":"workflow_runner_dispatch.mjs","file":"test_workflow_runner_native_request.mjs","pattern":"gap return consumes handover","old":"gaps: issued.gaps","replacement":"gaps: undefined"},
{"name":"exit-runner-no-fallback","target":"workflow_runner_exit.mjs","pattern":"requested unavailable isolated runner","old":"  return park('checks-runner-unavailable');\n}\nexport function exitRequest","replacement":"  return {runner:'host',pickedBy:'auto'};\n}\nexport function exitRequest","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-macos-requires-container","target":"workflow_runner_exit.mjs","pattern":"macos runner parks when CLI","old":"return command === true && status === true && machine === 'arm64'","replacement":"return true || command === true && status === true && machine === 'arm64'","file":"test_workflow_runner_exit.mjs"},
{"name":"exit-handover-consume","target":"workflow_runner_core.mjs","pattern":"return handover is written by","old":"if (s.phase === 'ready' && s.exit?.handoverPath && !s.exit.handoverConsumed)","replacement":"if (false)","file":"test_workflow_runner_exit.mjs"},
{"name":"spec-fidelity-same-line","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec_fidelity.mjs","pattern":"same-line directives cannot","old":"(?=\\s(?:CONSTANTS?|SPECIFICATION","replacement":"(?=\\n\\s*(?:CONSTANTS?|SPECIFICATION"},
  { name: 'spec-fidelity-directives', target: 'workflow_runner_spec.mjs', file: 'test_workflow_runner_spec_fidelity.mjs', pattern: 'safe config directives cannot',
    old: 'CONSTRAINTS?|ACTION_CONSTRAINTS?', replacement: 'CONSTRAINT|ACTION_CONSTRAINT' },
{"name":"spec-binding","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"matchingSpec rejects each mismatched","old":"!Object.entries(request.binding).every(([key, value]) => observed[key] === value)","replacement":"false"},
{"name":"spec-claim-required","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"spec event identity is mandatory","old":"!adapter.specEventId || ","replacement":""},
{"name":"spec-claim-match","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"spec event identity is mandatory","old":"s.specClaim?.eventId !== adapter.specEventId","replacement":"false"},
{"name":"spec-derived-integrity","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"matchingSpec rejects a forged","old":"observed.derivedDigest === sha(canonical(observed.derived))","replacement":"true"},
{"name":"spec-manifest-admission","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"specPassed binds act","old":"s.spec.manifestSha256 === w.spec?.sha256","replacement":"true"},
{"name":"spec-dispatch-admission","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"dispatch independently requires","old":"if (!specPassed(w, s))","replacement":"if (false)"},
{"name":"config-no-follow","target":"workflow_runner_user_config.mjs","file":"test_workflow_runner_user_config.mjs","pattern":"default synchronous reader refuses symlinks","old":" | constants.O_NOFOLLOW","replacement":""},
{"name":"config-nonblocking","target":"workflow_runner_user_config.mjs","file":"test_workflow_runner_user_config.mjs","pattern":"default reader refuses FIFO","old":" | constants.O_NONBLOCK","replacement":""},
{"name":"config-byte-cap","target":"workflow_runner_user_config.mjs","file":"test_workflow_runner_user_config.mjs","pattern":"default reader refuses valid JSON","old":"stat.size > 262144","replacement":"false"},
{"name":"spec-early-deadline","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"expired early invariant budgets","old":"if (remaining <= 0) return failed('spec-check-incomplete');","replacement":"if (false) return failed('spec-check-incomplete');"},
{"name":"spec-claim-recovery","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"a new spec event replaces","old":"      s.specClaim = { eventId: key, binding: request.binding };","replacement":"      if (s.specClaim) { result = { move: 'wait', reason: 'spec-check-incomplete' }; break; }\n      s.specClaim = { eventId: key, binding: request.binding };"},
{"name":"spec-rejected-claim-release","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"matched rejected spec observation","old":"if (!matchingSpec(request, observed, s.consumedSpec ?? {})) { s.specClaim = null;","replacement":"if (!matchingSpec(request, observed, s.consumedSpec ?? {})) {"},
{"name":"spec-gate-required","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"worker step parks before dispatch","old":"if (needsSpec(w) && !specPassed(w, s))","replacement":"if (false)"},
{"name":"spec-complete-only","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"incomplete or timed-out","old":"safe.exit === 0","replacement":"safe.exit !== 1"},
{"name":"spec-unsafe-must-fail","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"an unsafe config failing on a different","old":"u.exit === 1 && u.broke.includes(u.mustViolate)","replacement":"true"},
{"name":"spec-digest-bound","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"spec bytes at the frozen revision","old":"sha(bytes) !== entry.sha256","replacement":"false"},
{"name":"spec-chart-confirmed","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"a pinned chart whose committed sha","old":"sha(chart) !== manifest.chart.sha256","replacement":"false"},
{"name":"spec-derived-stack","target":"workflow_runner_core.mjs","file":"test_workflow_runner_spec.mjs","pattern":"dispatch carries the derived stack","old":"s.intent.stack = structuredClone(s.spec.derived)","replacement":"s.intent.stack = structuredClone(event.stack ?? s.spec.derived)"},
{"name":"spec-source-pin","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"skills resolve from the first","old":"skill.contentSha256","replacement":"skill.name"},
{"name":"spec-harness-match","target":"workflow_runner_dispatch.mjs","file":"test_workflow_runner_spec.mjs","pattern":"harness the driver cannot serve","old":"issued.stack.harness.kind !== driver.kind","replacement":"false"},
{"name":"spec-early-invariants","target":"workflow_runner_spec.mjs","file":"test_workflow_runner_spec.mjs","pattern":"when invariantWhen is both","old":"if (invariantWhen === 'both'","replacement":"if (false"},
  { name: 'ownership-release', target: 'workflow_runner_ownership.mjs', file: 'test_workflow_runner_ownership.mjs', pattern: 'ownership release refuses',
    old: "if (!transfer && !approved) throw new Error('owner control unverified');", replacement: 'if (false) throw new Error("disabled");' },
  { name: 'ownership-transfer', target: 'workflow_runner_ownership.mjs', file: 'test_workflow_runner_ownership.mjs', pattern: 'ownership transfer requires',
    old: "if (transfer && !approved) throw new Error('owner control unverified');", replacement: 'if (false) throw new Error("disabled");' },
  { name: 'ownership-generation', target: 'workflow_runner_ownership.mjs', file: 'test_workflow_runner_ownership.mjs', pattern: 'each transfer bumps',
    old: 'generation: ownership.generation + 1, managed: true', replacement: 'generation: ownership.generation + (transfer ? 0 : 1), managed: true' },
  { name: 'ownership-effect', target: 'workflow_runner_ownership.mjs', file: 'test_workflow_runner_ownership.mjs', pattern: 'managed effect gate refuses',
    old: 'return ownership.ownerId !== null && matches(observed, request);', replacement: 'return true;' },
  { name: 'ownership-reconcile', target: 'workflow_runner_ownership.mjs', file: 'test_workflow_runner_ownership.mjs', pattern: 'stale effects require',
    old: "if (!matches(observed, request) || !['absent', 'completed', 'failed'].includes(observed.status))", replacement: 'if (false)' },
  {
    name: 'pending-save', path: 'scripts/workflow_runner_authority.mjs', file: 'test_workflow_runner_authority.mjs', pattern: 'original requestId.*fake',
    old: 'store.save(request);', replacement: 'void request;',
  },
  {
    name: 'pending-publication', path: 'scripts/workflow_runner_authority_pending.mjs', file: 'test_workflow_runner_authority.mjs', pattern: 'original requestId.*fake',
    old: 'linkSync(temp, target);', replacement: 'void target;',
  },
  {
    name: 'authority-commit-before-ack', path: 'scripts/workflow_runner_authority.mjs', file: 'test_workflow_runner_authority.mjs', pattern: 'offline cancel stays pending',
    old: "if (!result.ok) return { ...result, accepted: true, acknowledged: false, state: 'cancel_pending' };",
    replacement: "if (false) return { ...result, accepted: true, acknowledged: false, state: 'cancel_pending' };",
  },
  {
    name: 'terminal-headroom', file: 'test_workflow_runner.mjs', pattern: 'final evidence reaches DONE',
    old: 'const terminalProgress = finalIntent && (',
    replacement: 'const terminalProgress = false && finalIntent && (',
  },
  {
    name: 'terminal-prelock', file: 'test_workflow_runner.mjs', pattern: 'final evidence reaches DONE',
    old: "!['cancel', 'hold', 'receipt', 'wake', 'tick'].includes(event?.type)",
    replacement: "!['cancel', 'hold'].includes(event?.type)",
  },
  {
    name: 'settled-controls', file: 'test_workflow_runner.mjs', pattern: 'settled owner controls do not grow',
    old: "if (['cancel', 'hold'].includes(event.type) &&",
    replacement: "if (false && ['cancel', 'hold'].includes(event.type) &&",
  },
  {
    name: 'stale-generation', file: 'test_workflow_runner_crash.mjs', pattern: 'stale contender cannot reuse a compacted writer generation',
    old: 'if (readdirSync(target).some(name => Number(/^writer\\.g\\.(\\d+)\\.lock$/.exec(name)?.[1]) > latest + 1)) {',
    replacement: 'if (false) {',
  },
  {
    name: 'owner-history-cap', file: 'test_workflow_runner.mjs', pattern: 'owner cancel and hold still settle at the run history cap',
    old: "if (s.history.length > 1024 && !terminalProgress && !['cancel', 'hold'].includes(event.type)) fail('run history limit');",
    replacement: "if (s.history.length > 1024) fail('run history limit');",
  },
  {
    name: 'decisions-throw', file: 'test_workflow_runner.mjs', pattern: 'throwing Decisions API cannot wedge',
    old: 'catch { proposal = undefined; }',
    replacement: 'catch { throw Error("offline"); }',
  },
  {
    name: 'checkpoint-halt', file: 'test_workflow_runner.mjs', pattern: 'damaged periodic checkpoint',
    old: '|journal|checkpoint|reconcil|',
    replacement: '|journal|reconcil|',
  },
  {
    name: 'identity', file: 'test_workflow_runner.mjs', pattern: 'cancel binds each artifact',
    old: 'repo: w.repo, artifact: posix.normalize(s.artifact).replace(/\\/+$/, \'\').toLowerCase(),',
    replacement: 'repo: w.repo, artifact: posix.normalize(s.artifact).replace(/\\/+$/, \'\').toLowerCase(), sha256: s.sha256,',
  },
  {
    name: 'authority-admission', file: 'test_workflow_runner_authority_core.mjs', pattern: 'CAS authority is unavailable',
    old: 'if (blocked) return blocked;',
    replacement: 'if (false && blocked) return blocked;',
  },
  {
    // G4 independently fences the old local-marker mutant. Exercise the authoritative halt instead.
    name: 'halt', target: 'workflow_runner_authority_gate.mjs', file: 'test_workflow_runner_authority_core.mjs', pattern: 'G4 filesystem rollback',
    old: "const cancelled = () => ({ move: 'settled', phase: 'cancelled', reason: 'cancelled', acknowledged: true, authorityCreated: false });",
    replacement: "const cancelled = () => ({ move: 'act', phase: 'ready', reason: 'cancelled', acknowledged: true, authorityCreated: false });",
  },
  {
    name: 'writer', file: 'test_workflow_runner_crash.mjs', pattern: 'copied completion marker',
    old: 'if (!sameIdentity(lstatSync(done), owner.observed) || readSafe(done) !== owner.token)',
    replacement: 'if (false)',
  },
  {
    name: 'lock-facts', file: 'test_workflow_runner.mjs', pattern: 'retired lock facts are exact',
    old: 'if (checksum !== seal(key, body) || !Array.isArray(body.retired) ||',
    replacement: 'if (!Array.isArray(body.retired) ||',
  },
  {
    name: 'checkpoint', file: 'test_workflow_runner.mjs', pattern: 'damaged periodic checkpoint',
    old: 'body.prefixHash !== sha(bytes.subarray(0, body.offset)) || checksum !== seal(key, body) ||',
    replacement: 'false ||',
  },
  {
    name: 'bound', file: 'test_workflow_runner.mjs', pattern: '256 polls keep journal bytes',
    old: 'compactCompleted(target, key, adapter);',
    replacement: 'void adapter;',
  },
];

let failed = false;
for (const control of controls) {
  const sourcePath = control.path ?? `scripts/${control.target ?? 'workflow_runner_core.mjs'}`;
  const source = readFileSync(join(root, sourcePath), 'utf8');
  const count = source.split(control.old).length - 1;
  if (count !== 1) throw Error(`${control.name}: expected exactly one original guard, found ${count}`);
  const scratch = mkdtempSync(join(tmpdir(), 'runner-mut-'));
  try {
    mkdirSync(join(scratch, '.scratch'));
    mkdirSync(join(scratch, 'scripts'));
    mkdirSync(join(scratch, 'tests'));
    mkdirSync(join(scratch, 'extensions'));
    mkdirSync(join(scratch, 'scripts/enforcement'));
    for (const name of ['linux_microvm_checks_runtime.js']) copyFileSync(join(root, 'scripts/enforcement', name), join(scratch, 'scripts/enforcement', name));
    copyFileSync(join(root, 'scripts/session_handover.py'), join(scratch, 'scripts/session_handover.py'));
    cpSync(join(root, 'tests/fixtures/workflow-exit'), join(scratch, 'tests/fixtures/workflow-exit'), { recursive: true });
    copyFileSync(join(root, 'scripts/workflow_runner_core.mjs'), join(scratch, 'scripts/workflow_runner_core.mjs'));
    for (const name of ['workflow_runner_ownership.mjs', 'workflow_runner_procedure.mjs', 'workflow_runner_authority.mjs', 'workflow_runner_authority_pending.mjs', 'workflow_runner_authority_gate.mjs', 'workflow_runner_authority_remote.mjs', 'workflow_runner_authority_local.mjs', 'workflow_runner_spec.mjs', 'workflow_runner_user_config.mjs', 'workflow_runner_exit.mjs', 'workflow_runner_outputs.mjs'])
      copyFileSync(join(root, 'scripts', name), join(scratch, 'scripts', name));
    cpSync(join(root, 'tests/fixtures/workflow-spec'), join(scratch, 'tests/fixtures/workflow-spec'), { recursive: true });
    copyFileSync(join(root, 'tests/workflow_runner_spec_fixture.mjs'), join(scratch, 'tests/workflow_runner_spec_fixture.mjs'));
    cpSync(join(root, 'config'), join(scratch, 'config'), { recursive: true });
    copyFileSync(join(root, 'tests/workflow_runner_authority_fixture.mjs'), join(scratch, 'tests/workflow_runner_authority_fixture.mjs'));
    copyFileSync(join(root, 'tests', control.file), join(scratch, 'tests', control.file));
    copyFileSync(join(root, 'extensions/workflow-runner.js'), join(scratch, 'extensions/workflow-runner.js'));
    for (const file of ['workflow_runner_procedure.mjs', 'workflow_runner_dispatch.mjs', 'pad-runner.mjs'])
      copyFileSync(join(root, 'scripts', file), join(scratch, 'scripts', file));
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
    // Why: missing imports or broken fixtures must not masquerade as killed source guards.
    const argv = ['--test', '--test-reporter=tap', `--test-name-pattern=${control.pattern}`, join(scratch, 'tests', control.file)];
    writeFileSync(join(scratch, sourcePath), source);
    const head = spawnSync(process.execPath, argv, { cwd: scratch, encoding: 'utf8', timeout: 90000 });
    if (head.status !== 0 || !head.stdout.includes('# pass 1') || !head.stdout.includes('# fail 0'))
      throw Error(`${control.name}: unmutated control must pass one behavioral test`);
    writeFileSync(join(scratch, sourcePath), source.replace(control.old, control.replacement));
    const proc = spawnSync(process.execPath, argv, { cwd: scratch, encoding: 'utf8', timeout: 90000 });
    const killed = proc.status !== 0 && proc.stdout.includes('not ok') && proc.stdout.includes('# fail 1');
    console.log(`${control.name}: ${killed ? 'killed' : 'SURVIVED'} (exit ${proc.status ?? 'timeout'})`);
    if (!killed) { failed = true; console.log(proc.stdout.slice(-1500), proc.stderr.slice(-500)); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (failed) process.exitCode = 1;
