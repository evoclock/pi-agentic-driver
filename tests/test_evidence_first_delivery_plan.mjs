import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../skills/evidence-first-delivery-workflow/examples/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const copy = (plan) => structuredClone(plan);
const newUnit = () => load('new-unit.plan.json');
const resume = () => load('exhausted-resume.plan.json');
// Import inside each case: on the base commit the unimplemented validator must fail
// an assertion, rather than crash the test runner during module loading.
const validator = async () => {
  const module = await import('../skills/evidence-first-delivery-workflow/validate_plan.mjs').catch(() => null);
  assert.equal(typeof module?.validatePlan, 'function', 'the plan validator must exist');
  return module.validatePlan;
};
// Why: every invalid-plan case must exercise the real validator and reject the named contract violation.
const rejects = (name, alter, expected, example = newUnit) => test(name, async () => {
  const validatePlan = await validator();
  const plan = copy(example());
  alter(plan);
  assert.ok(validatePlan(plan).errors.some((error) => error.includes(expected)), JSON.stringify(validatePlan(plan)));
});

// Why: inactive examples must conform to the static contract, without asserting any runtime execution.
test('both inactive examples pass plan validation only', async () => {
  const validatePlan = await validator();
  for (const plan of [newUnit(), resume()]) assert.deepEqual(validatePlan(plan), { ok: true, errors: [] });
});
// Why: an author cannot act as their own independent reviewer.
rejects('self-review', p => { p.nodes.find(n => n.id === 'review1').actor = 'development'; }, 'self-review');
// Why: the second review is the terminal budget, not an invitation to add a third review.
rejects('third review', p => {
  p.nodes.push({ id: 'review3', kind: 'review', actor: 'independent-review', model: null, artifactHead: p.artifactHead });
  p.edges.push({ from: 'review2', to: 'review3', outcome: 'retry', requires: 'review-receipt' });
  p.edges.push({ from: 'review3', to: 'qa2', outcome: 'pass', requires: 'review-receipt' });
}, 'third review');
// Why: an exhausted unit cannot regain review budget by resuming.
rejects('review budget reset on resume', p => { p.review.consumed = 0; }, 'budget reset', resume);
// Why: relabeling an exhausted unit cannot turn it into a fresh unit.
rejects('review budget reset by relabel', p => { p.unitId = 'renamed-unit'; }, 'unit relabel', resume);
// Why: evidence for a different artifact head cannot satisfy the pinned plan.
rejects('stale artifact head', p => { p.artifactHead = '0'.repeat(40); }, 'stale artifact');
// Why: every transition needs an explicit future evidence requirement.
rejects('missing evidence edge', p => { p.edges[0].requires = ''; }, 'missing evidence edge');
// Why: terminal recovery must not reopen QA or review.
rejects('terminal recovery cannot return to review', p => {
  p.edges.push({ from: 'recovery', to: 'review2', outcome: 'retry', requires: 'review-receipt' });
}, 'terminal recovery');
// Why: a saved example must not claim to be activated.
rejects('active flag forbidden', p => { p.active = false; }, 'activation');
// Why: an inactive graph must not register a trigger.
rejects('trigger forbidden', p => { p.triggers = ['push']; }, 'activation');
// Why: an unreachable step cannot be part of a coherent delivery path.
rejects('disconnected node', p => { p.nodes.push({ id: 'orphan', kind: 'stop' }); }, 'disconnected');
// Why: a plan cannot quietly redefine the owner's acceptance criteria.
rejects('self-relaxed definition', p => { p.contract.definition = 'Ship anything'; }, 'definition hash');
// Why: ordinary valid steps must continue automatically, not demand routine human approval.
rejects('human approval on ordinary transition', p => { p.edges[0].continuation = 'human'; }, 'automatic transition');
// Why: rejection must route to bounded correction without waiting for routine approval.
rejects('human approval on correction', p => { p.edges.find(e => e.from === 'review1' && e.outcome === 'reject').continuation = 'human'; }, 'automatic transition');
// Why: owner integration is an owner-only decision, not a silent automatic transition.
rejects('automatic owner integration', p => { p.edges.find(e => e.outcome === 'integrated').continuation = 'automatic'; }, 'human decision');
// Why: undefined product choices cannot be invented by the graph.
rejects('missing material decision stop', p => { p.humanDecisions = p.humanDecisions.filter(x => x !== 'material-undefined-product-decision'); }, 'human decision');
// Why: capabilities must be identified before a plan can be mistaken for enforcement.
rejects('missing capability matrix reference', p => { p.matrixRefs.capabilities = ''; }, 'capability matrix');
// Why: bypass routes must be disclosed, not hidden behind static validation.
rejects('missing bypass matrix reference', p => { p.matrixRefs.bypasses = ''; }, 'bypass matrix');
