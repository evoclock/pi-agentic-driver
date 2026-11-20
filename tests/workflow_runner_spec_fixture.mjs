import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { initial, run } from '../scripts/workflow_runner_core.mjs';
import { existsSync } from 'node:fs';
const modulePath = new URL('../scripts/workflow_runner_spec.mjs', import.meta.url);
const { specRequest } = existsSync(modulePath) ? await import(modulePath.href) : {};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
// Existing dispatch tests inject trusted host evidence, not a real installed checker.
// The focused spec suite independently exercises revision reads and adapter outcomes.
export function checkedSpecFixture(w, store, authority) {
  if (!specRequest) return;
  w.spec = { schema: 'pad-workflow-spec-ref.v1', manifest: 'synthetic-spec.json', sha256: sha('synthetic manifest') };
  const request = specRequest(w, { ...initial(w), taskId: basename(store) });
  const derived = { schema: 'pad-derived-stack.v1', skills: [], playbook: { name: 'synthetic', sha256: sha('synthetic playbook') }, harness: { kind: 'pi' }, specDigest: w.spec.sha256 };
  const claim = run(w, store, { id: 'synthetic-spec-claim', type: 'spec' }, { authority });
  const admit = () => run(w, store, { id: 'synthetic-spec', type: '_spec' }, { authority, specEventId: 'synthetic-spec-claim', specObservation: () => ({ ...request.binding, evidenceId: `spec-${randomUUID()}`, manifestSha256: w.spec.sha256,
    verdict: 'pass', reason: null, derived, derivedDigest: sha(canonical(derived)), chartSha256: null, confirmedChartSha256: null }) });
  return claim?.then ? claim.then(admit) : admit();
}
