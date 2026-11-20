import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const modulePath = new URL('../scripts/workflow_runner_spec.mjs', import.meta.url);
const api = existsSync(modulePath) ? await import(modulePath.href) : {};
function fixture() {
  assert.equal(typeof api.checkSpecFidelity, 'function', 'G7 fidelity checking must exist');
  const root = new URL('../tests/fixtures/workflow-spec/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('spec.json', root), 'utf8'));
  const files = Object.fromEntries(['SPEC.tla', 'SPEC.cfg', 'SPEC-unsafe-skip.cfg'].map(name => [name, readFileSync(new URL(name, root), 'utf8')]));
  return { manifest, files };
}
// Why: an invariant mentioned under another config directive was not necessarily checked as an invariant.
test('safe config directives cannot impersonate checked invariants', () => {
  for (const directive of ['CONSTRAINTS', 'ACTION_CONSTRAINT', 'ACTION_CONSTRAINTS', 'ALIAS', 'POSTCONDITION']) {
    const { manifest, files } = fixture();
    files['SPEC.cfg'] = `SPECIFICATION Spec\nCONSTANT SkipGuard = TRUE\nINVARIANTS OtherRule\n${directive} NoSkippedReview\n`;
    assert.deepEqual(api.checkSpecFidelity(manifest, files), { park: 'spec-fidelity' }, directive);
  }
});
// Why: repeated singular/plural invariant declarations are valid; boundary hardening must retain their actual operators.
test('safe config collects repeated invariant declarations only from invariant sections', () => {
  const { manifest, files } = fixture();
  manifest.invariants.push({ id: 'OtherRule', statement: 'Another declared rule.' });
  files['SPEC.tla'] += '\nOtherRule == TRUE\n';
  files['SPEC.cfg'] = 'SPECIFICATION Spec\nCONSTANT SkipGuard = TRUE\nINVARIANT NoSkippedReview\nINVARIANTS OtherRule\n';
  assert.deepEqual(api.checkSpecFidelity(manifest, files), { ok: true });
});
// Why: TLC directives can share a line; whitespace must still end the invariant section.
test('same-line directives cannot impersonate checked invariants', () => {
  for (const directive of ['CONSTRAINT', 'CONSTRAINTS', 'ACTION_CONSTRAINTS', 'ALIAS', 'POSTCONDITION']) {
    const { manifest, files } = fixture();
    files['SPEC.cfg'] = 'SPECIFICATION Spec\nCONSTANT SkipGuard = TRUE\nINVARIANT OtherRule ' + directive + ' NoSkippedReview\n';
    assert.deepEqual(api.checkSpecFidelity(manifest, files), { park: 'spec-fidelity' }, directive);
  }
});
