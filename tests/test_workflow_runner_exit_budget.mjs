import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateWorkflow, run } from './workflow_runner_authority_fixture.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root=resolve('.scratch/g8-budget-tests');mkdirSync(root,{recursive:true});
  const repo=mkdtempSync(join(root,'case-'));t.after(()=>rmSync(repo,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','fixture');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  const skill='## Step: check\n';writeFileSync(join(repo,'skill.md'),skill);writeFileSync(join(repo,'.gitignore'),'.local/\n');
  git('add','.');git('commit','-m','fixture');
  const w={schema:'pad-workflow.v1',repo,revision:git('rev-parse','HEAD'),maxAttempts:2,steps:[{id:'build',artifact:'artifact.md',sha256:sha('after'),skill:{pack:'synthetic',version:'v1',path:'skill.md',sha256:sha(skill),step:'check'}}]};
  return {repo,w,store:join(repo,'.local/workflow-runner/task')};
}
// Why: G8 raises delivery exhaustion to the inclusive engine backstop without removing its hard ceiling.
test('attempt backstop accepts100 and rejects101 without changing the built-in workflow default',t=>{
  const f=fixture(t);assert.equal(validateWorkflow({...f.w,maxAttempts:100}).maxAttempts,100);
  assert.throws(()=>validateWorkflow({...f.w,maxAttempts:101}),/invalid workflow/);
  assert.equal(validateWorkflow(f.w).maxAttempts,2);
});
// Why: an authenticated journal for another contract is a mismatch, while forged bytes remain an integrity failure.
test('workflow contract mismatch is diagnosed distinctly from journal tampering',t=>{
  const f=fixture(t);run(f.w,f.store,{id:'act',type:'tick'});
  assert.throws(()=>run({...f.w,maxAttempts:4},f.store,{id:'changed',type:'tick'}),/workflow revision mismatch/);
  const journal=join(f.store,'journal.jsonl');const rows=readFileSync(journal,'utf8').trim().split('\n').map(JSON.parse);rows[0].checksum='0'.repeat(64);writeFileSync(journal,rows.map(JSON.stringify).join('\n')+'\n');
  assert.throws(()=>run(f.w,f.store,{id:'forged',type:'tick'}),/journal integrity failure/);
});
