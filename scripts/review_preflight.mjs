import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { changedModelInventory } from './model_negative_controls.mjs';

export function preflight({cwd = process.cwd(), fetch = true} = {}) {
  const run = (command,args,env = process.env) => {
    const result = spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:120000,maxBuffer:16 * 1024 * 1024});
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || `${command} failed (${result.status})`);
    return result.stdout;
  };
  try {
    if (fetch) run('git',['fetch','origin','main']);
    const ancestor = spawnSync('git',['merge-base','--is-ancestor','origin/main','HEAD'],{cwd,encoding:'utf8',timeout:10000});
    if (ancestor.status !== 0) return {ok:false,message:'BLOCKED: merge origin/main with --no-ff first'};
    const inventory = changedModelInventory({root:cwd});
    if (inventory.errors.length) throw new Error(inventory.errors.join('\n'));
    const toolEnv = JSON.parse(run('python3',['scripts/gate.py','--tool-env']));
    run('node',['scripts/review_gate_tools.mjs']);
    run('python3',['scripts/review_contract_preflight.py']);
    run('node',['scripts/owner_terms_lint.mjs','--base','origin/main']);
    run('python3',['scripts/review_test_tokens.py','origin/main']);
    const env = {...process.env,...toolEnv,TLC_REQUIRED:'1'};
    run('node',['scripts/model_negative_controls.mjs','--run'],env);
    run('node',['--test','tests/parallel_scheduler_liveness.mjs'],env);
    run('node',['--test','tests/test_owner_terms_lint.mjs','tests/test_owner_terms_boundary.mjs','tests/test_model_negative_controls.mjs','tests/test_model_obligations.mjs','tests/test_model_control_diagnostics.mjs','tests/test_review_gate_tools.mjs','tests/test_tlc_helper.mjs','tests/test_boundary_classes.mjs','tests/test_review_preflight.mjs','tests/test_review_contract_preflight.mjs','tests/test_review_token_adapter.mjs','tests/test_review_ready_skill.mjs','tests/test_skill_dependencies.mjs','tests/test_skill_shape.mjs','tests/test_skill_proof.mjs'],env);
    return {ok:true,message:'OK: review preflight'};
  } catch (error) { return {ok:false,message:`BLOCKED: ${error.message.trim()}`}; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = preflight();
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
