import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }))[0];
const packed = new Set(pack.files.map(f => f.path));
const skills = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).pi.skills;
const optional = new Set(['.pi/pstack-model-roles.v1.json', 'fix_plan.json', 'fix_plan.md', 'ralph-state.json', 'ralph-budget.json', 'HANDOVER.json', 'sections.json', 'PLAN.json', 'tracker_data', 'harvest.json', 'evidence.jsonl', 'lessons-report.md', 'docs/agents/issue-tracker.md']);
const repositoryOnly = new Set(['scripts/test_gate_runner.py', 'scripts/enforcement/pr_review_gate.js', 'tests/test_test_gate.py', 'tests/test_test_gate_control_lock.py', 'tests/test_release_public.py', 'tests/test_evidence_first_delivery_plan.mjs', '.driver/gate-rules.json', '.driver/test-gate.json', 'scripts/release_public.py', 'skills/weekly-build-recap/test_recap.py']);

// Why: a shipped skill must not point readers at missing package contents.
test('all shipped skill Markdown links and repository paths resolve in the package', () => {
  const missing = [];
  for (const skill of skills) {
    const dir = skill.replace(/^\.\//, '');
    for (const file of readdirSync(resolve(root, dir)).filter(f => f.endsWith('.md'))) {
      const name = `${dir}/${file}`;
      const text = readFileSync(resolve(root, name), 'utf8');
      const links = [...text.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)(?:#[^)]*)?\)/g)].map(m => posix.normalize(posix.join(dir, decodeURIComponent(m[1]))));
      const paths = [...text.matchAll(/`((?:scripts|skills|docs|config|\.driver|\.pi|tests|\.agentic-driver|templates|model)\/[\w./-]+\.(?:md|json|mjs|js|py|tla|cfg))`/g)].map(m => m[1]);
      for (const path of [...links, ...paths]) {
        if (optional.has(path) || repositoryOnly.has(path) || path.startsWith('model/') && packed.has(`${dir}/${path}`)) continue;
        if (!packed.has(path)) missing.push(`${name}: ${path}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
