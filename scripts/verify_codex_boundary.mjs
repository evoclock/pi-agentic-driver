// Synthetic model conformance and mutation check. Never executes modeled shell text.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const testFile = join(root, 'tests/test_codex_boundary_model.mjs');
const sourceDir = join(root, 'scripts/enforcement');
const mutations = [
  ['search-path-expansion', 'guard', '[A-Za-z0-9_./][A-Za-z0-9_./-]*$', '[^\\s-][A-Za-z0-9_./-]*$'],
  ['query-mask', 'guard', 'const forbiddenText = literalSearch ? text.replace(/\\bcodex\\b/, \'__literal_query__\') : text;', 'const forbiddenText = literalSearch ? text : text;'],
  ['preprocessor', 'guard', 'pattern: /\\brg\\b[^\\n;&|]*\\s--pre(?:=|\\s)/', 'pattern: /a^/'],
  ['opaque-shell', 'guard', 'pattern: /(?:^|[\\s;&|])(?:sh|bash|zsh)\\s+(?:\\.\\/|\\/|[^\\s]+\\.sh\\b)|(?:^|[;&|(`]\\s*|\\$\\(\\s*)(?:(?:env|exec|command|nohup|time)\\s+)*(?:\\S*\\/)?(?:sh|bash|zsh|dash|ksh)\\s+(?:-(?![A-Za-z]*c)[A-Za-z]+\\s+)*(?![-\'"])\\S|(?:^|[;&|(`]\\s*|\\$\\(\\s*)(?:\\.|source)\\s+\\S/', 'pattern: /a^/'],
  ['git-config', 'guard', 'pattern: /(?:^|[\\s;&|`(])(?:\\S*\\/)?git\\b[^\\n;&|]*?(?:\\s-c\\s*|\\s--config-env[=\\s]+|\\sconfig\\b(?![^\\n;&|]*\\s--(?:get|get-all|get-regexp|get-urlmatch|list|show-origin)\\b)[^\\n;&|]*?\\s)(?:core\\.(?:pager|fsmonitor|sshcommand|editor|hookspath|askpass|alternaterefscommand|gitproxy)|pager\\.[^\\s=]+|sequence\\.editor|diff\\.external|uploadpack\\.packobjectshook|web\\.browser|gpg(?:\\.[^\\s=]+)?\\.program|credential(?:\\.[^\\s=]+)?\\.helper|include(?:if\\.[^\\s=]+)?\\.path|alias\\.[^\\s=]+|diff\\.[^\\s=]+\\.(?:textconv|command)|merge\\.[^\\s=]+\\.driver|filter\\.[^\\s=]+\\.(?:clean|smudge|process)|(?:mergetool|difftool|man|browser)\\.[^\\s=]+\\.(?:cmd|path)|remote\\.[^\\s=]+\\.(?:uploadpack|receivepack|vcs)|protocol\\.[^\\s=]+\\.allow|submodule\\.[^\\s=]+\\.update)(?=[\\s=]|$)/i', 'pattern: /a^/'],
  ['git-environment', 'guard', 'pattern: /(?:^|[\\s;&|`(])(?:GIT_(?:EXTERNAL_DIFF|SSH|SSH_COMMAND|ASKPASS|EDITOR|SEQUENCE_EDITOR|PROXY_COMMAND|EXEC_PATH|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\\d+|CONFIG_VALUE_\\d+)|SSH_ASKPASS)\\s*\\+?=|(?:^|[\\s;&|`(])(?:GIT_PAGER|PAGER)\\s*=(?!(?:cat|less|more|""|\'\')?(?:\\s|$))/', 'pattern: /a^/'],
  ['ripgrep-config', 'guard', 'pattern: /(?:^|[\\s;&|`(])RIPGREP_CONFIG_PATH\\s*\\+?=/', 'pattern: /a^/'],
  ['account-assignment', 'guard', '\\bCODEX_HOME\\s*\\+?=', '\\bNEVER_HOME\\s*\\+?='],
  ['first-kind-check', 'ack', 'if (first.agentKind === "codex") {', 'if (false) {'],
  ['second-kind-check', 'ack', 'if (second.agentKind === "codex") {', 'if (false) {'],
  ['pre-prompt-kind-change', 'ack', 'if (second.agentKind !== first.agentKind) {', 'if (false) {'],
  ['ack-kind-compare', 'ack', 'if (observation.agentKind !== first.agentKind) {', 'if (false) {'],
  ['transport-mark', 'ack', 'did not retry");\n        unknown.deliveryState = "unknown";', 'did not retry");'],
  ['stalled-mark', 'ack', '          error.deliveryState = "unknown";\n', ''],
  ['post-prompt-mark', 'ack', 'failure.deliveryState = "unattributed";', 'failure.deliveryState = "unknown";'],
  ['post-prompt-reason', 'ack', 'if (!failure.message.startsWith("a prompt was sent;")) {', 'if (false) {'],
  ['post-prompt-blocked', 'ack', 'throw communicationError("role_blocked", "the prompted role reached blocked state", "blocked");', 'return errorResult(operation, communicationError("role_blocked", "the prompted role reached blocked state", "blocked"));'],
  ['dispatch-returned-reprompt', 'dispatch', 'const unresponsive = exchange.deliveryState !== "unattributed"\n        && (', 'const unresponsive = ('],
];
const sourceNames = { guard: 'attended_authority_guard.js', ack: 'herdr_communication_pi.js', dispatch: 'herdr_async_dispatch_pi.js' };
const mutantEnv = { guard: 'PAD_GUARD_MUTANT_PATH', ack: 'PAD_ACK_MUTANT_PATH', dispatch: 'PAD_DISPATCH_MUTANT_PATH' };
const scratch = mkdtempSync(join(tmpdir(), 'pad-codex-model-mutations-'));
try {
  const profile = join(scratch, 'profile');
  mkdirSync(profile);
  const baseEnv = { ...process.env, PI_CODING_AGENT_DIR: profile };
  delete baseEnv.PAD_GUARD_MUTANT_PATH;
  delete baseEnv.PAD_ACK_MUTANT_PATH;
  delete baseEnv.PAD_DISPATCH_MUTANT_PATH;
  const run = (env) => spawnSync(process.execPath, ['--test', testFile],
    { cwd: root, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  const control = run({});
  if (control.status !== 0) throw new Error('model conformance baseline failed: ' + control.stdout.slice(-2000));
  console.log('model conformance baseline passed');
  // An unmutated copy must pass, or a copy that cannot load would count every
  // mutant as killed.
  for (const category of Object.keys(sourceNames)) mutations.unshift(['copy-control-' + category, category, null, null]);
  for (const [label, category, before, after] of mutations) {
    const dir = join(scratch, label);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const copied = join(dir, 'scripts/enforcement');
    cpSync(sourceDir, copied, { recursive: true });
    const target = join(copied, sourceNames[category]);
    const source = readFileSync(target, 'utf8');
    if (before === null) {
      const result = run({ [mutantEnv[category]]: target });
      if (result.status !== 0 || result.error) throw new Error(label + ': unmutated copy failed: ' + result.stdout.slice(-2000));
      console.log(label + ': unmutated copy passed');
      continue;
    }
    if (source.split(before).length !== 2) throw new Error(label + ': mutation target not unique');
    writeFileSync(target, source.replace(before, after));
    const result = run({ [mutantEnv[category]]: target });
    if (result.status === 0 || result.error) throw new Error(label + ': mutant survived or did not finish');
    console.log(label + ': killed by model-generated conformance tests');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
