import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
async function load() {
  const file = process.env.PAD_NODE_TEST_RUN_SOURCE || join(root, 'scripts/node_test_run.mjs');
  assert.ok(existsSync(file), 'native Node partition runner is required');
  return import(pathToFileURL(file).href);
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'node-isolation-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const put = (name, text) => { writeFileSync(join(dir,name),text); return join(dir,name); };
  return {dir,put};
}
// Why: each generated native fixture contains an executed equality assertion.
const pure = value => `import test from 'node:test'; import assert from 'node:assert/strict'; test('pure ${value}',()=>assert.equal(${value},${value}));`;

// Why: only a dependency-checked pure subset can share a test process.
test('pure files are grouped and every unsafe or uncertain file stays process-isolated', async t => {
  const {planNodeTests} = await load(); const f = fixture(t);
  const a=f.put('a.mjs',pure(1)), b=f.put('b.mjs',pure(2));
  // Why: the generated environment-writing case must remain process-isolated.
  const unsafe=f.put('unsafe.mjs',`import test from 'node:test'; test('state',()=>{process.env.SAMPLE='x'});`);
  const plan=planNodeTests({root:f.dir,argv:['--test','--test-reporter=tap',a,b,unsafe]});
  assert.equal(plan.groups.length,2);
  assert.deepEqual(plan.groups.flatMap(g=>g.files).sort(),[a,b,unsafe].sort());
  assert.deepEqual(plan.groups.find(g=>g.safe).files,[a,b]);
  assert.deepEqual(plan.groups.find(g=>!g.safe).files,[unsafe]);
  assert.ok(plan.groups.find(g=>g.safe).argv.includes('--experimental-test-isolation=none'));
  assert.ok(!plan.groups.find(g=>!g.safe).argv.includes('--experimental-test-isolation=none'));
});

// Why: unknown flags and preloads must retain native process isolation rather than guess purity.
test('unknown options and preloads fall back without dropping arguments or files',async t=>{
  const {planNodeTests}=await load(),f=fixture(t);
  const a=f.put('a.mjs',pure(1)),b=f.put('b.mjs',pure(2));
  for(const options of [{argv:['--test','--unknown-option',a,b],env:{}},{argv:['--test',a,b],env:{NODE_OPTIONS:'--import unknown.mjs'}}]) {
    const plan=planNodeTests({root:f.dir,...options});
    assert.ok(plan.groups.every(g=>!g.safe));
    assert.deepEqual(plan.groups.flatMap(g=>g.files).sort(),[a,b].sort());
    assert.ok(!plan.groups.some(g=>g.argv.includes('--experimental-test-isolation=none')));
    if(options.argv.includes('--unknown-option')) assert.ok(plan.groups[0].argv.includes('--unknown-option'));
  }
});

// Why: process/env/cwd/timers/filesystem, transitive state and test hooks are not guesses.
test('classifier refuses unsafe operations and transitive module state', async t => {
  const {classifyTestFile} = await load(); const f=fixture(t);
  const cases=[`process.env.X='x'`,`process.chdir('.')`,`setTimeout(()=>{},1)`,`globalThis.x=1`,`eval('1')`,`new Function('return 1')`,`import('node:fs')`,`import fs from 'node:fs';`,`import {before} from 'node:test'; before(()=>{});`,`Object.defineProperty(Math,'x',{value:1})`,`const key='constructor';`];
  // Why: each generated callback exercises an otherwise hidden native/global effect.
  for(const body of [`Math=0`, `Math++`, `assert.register('x',()=>{})`, `Error.captureStackTrace(Math)`, `assert.equal(RegExp.$1,'')`, `ctx.assert.snapshot('x')`, `const alias=ctx; alias.assert.snapshot('x')`, `test.snapshot.setDefaultSnapshotSerializers([])`]) cases.push(pure(1)+`test('closed API',ctx=>{${body}});`);
  // Why: the generated named-import case refuses unrecognized assertion APIs.
  cases.push(`import {register} from 'node:assert'; import test from 'node:test'; test('unknown assert API',()=>register('x',()=>{}));`);
  for (const [i,code] of cases.entries()) assert.equal(classifyTestFile(f.put(`bad${i}.mjs`,code),f.dir).safe,false,code);
  f.put('state.mjs',`export const state = new Map(); export function value(){return state.size}`);
  assert.equal(classifyTestFile(f.put('transitive.mjs',`import {value} from './state.mjs'; ${pure(1)}`),f.dir).safe,false);
  f.put('fn.mjs',`export function twice(n){return n*2}`);
  // Why: the generated local-function case proves a useful pure dependency is accepted.
  assert.equal(classifyTestFile(f.put('safe.mjs',`import {twice} from './fn.mjs'; import test from 'node:test'; import assert from 'node:assert/strict'; test('fn',()=>assert.equal(twice(2),4));`),f.dir).safe,true);
});

// Why: grouping must execute every file, retain native counts, and propagate an assertion failure.
test('real native groups execute all cases and retain a failing planted assertion', async t => {
  const {runNodeTests} = await load(); const f=fixture(t);
  const a=f.put('a.mjs',pure(1)), b=f.put('b.mjs',pure(2));
  const pass=runNodeTests({root:f.dir,argv:['--test','--test-reporter=tap',a,b],capture:true});
  assert.equal(pass.status,0,pass.output); assert.match(pass.output,/# tests 2/);
  f.put('b.mjs',pure(2).replace('equal(2,2)','equal(2,3)'));
  const fail=runNodeTests({root:f.dir,argv:['--test','--test-reporter=tap',a,b],capture:true});
  assert.notEqual(fail.status,0); assert.match(fail.output,/ERR_ASSERTION/); assert.match(fail.output,/# fail 1/);
});

// Why: each actual Node worker owns and removes its temp directory, including Java extraction state.
test('bootstrap gives a worker a private temporary directory and cleans it at exit', async () => {
  await load(); const bootstrap=join(root,'scripts/node_test_sandbox.mjs');
  assert.ok(existsSync(bootstrap));
  const run=spawnSync(process.execPath,['--import',bootstrap,'--input-type=module','-e','console.log(JSON.stringify({temp:process.env.TMPDIR,java:process.env.JAVA_TOOL_OPTIONS}))'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const value=JSON.parse(run.stdout); assert.match(value.temp,/test-gate-node-/);
  assert.ok(value.java.includes('-Djava.io.tmpdir=')); assert.equal(existsSync(value.temp),false);
});
