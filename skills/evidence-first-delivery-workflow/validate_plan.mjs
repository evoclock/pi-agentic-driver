#!/usr/bin/env node
// Static plan validation only. No dispatch, authorization, or runtime effect.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const hash = value => createHash('sha256').update(value).digest('hex');

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['invalid plan object'] };
  if (plan.schema !== 'evidence-first-delivery-plan.v1' || !plan.planId || !plan.unitId || !['new', 'resume'].includes(plan.mode)) errors.push('invalid plan identity');
  if (['active', 'triggers', 'schedule', 'schedules', 'enabled'].some(key => Object.hasOwn(plan, key))) errors.push('activation fields forbidden in inactive plan');
  if (!hex(plan.artifactHead, 40) || plan.artifactHead !== plan.baseline?.artifactHead) errors.push('stale artifact head');
  if (plan.unitId !== plan.baseline?.unitId) errors.push('unit relabel cannot reset review history');
  if (!plan.contract?.definition || hash(plan.contract.definition) !== plan.contract.definitionHash) errors.push('definition hash mismatch (self-relaxed definition)');
  for (const value of [plan.contract?.sourceHash, plan.methodHash, plan.modelMapHash]) if (!hex(value, 64)) errors.push('missing contract, method, or model evidence hash');
  if (!plan.writer?.actor || !Number.isSafeInteger(plan.writer.epoch) || plan.writer.epoch < 1) errors.push('missing sole-writer epoch');
  if (!Number.isSafeInteger(plan.review?.consumed) || !Number.isSafeInteger(plan.baseline?.consumedReviews) ||
      plan.review.consumed < plan.baseline.consumedReviews || plan.review.consumed < 0) errors.push('review budget reset on resume');
  if (plan.review?.limit !== 2 || plan.review?.consumed > 2 || !Array.isArray(plan.review?.previousInvolvement)) errors.push('invalid review limit or involvement');
  if (plan.mode === 'new' && plan.baseline?.consumedReviews !== 0) errors.push('new unit cannot discard prior reviews');
  if (plan.mode === 'resume' && plan.review?.consumed === 2 && plan.start !== 'resume') errors.push('exhausted resume must start in recovery');
  if (plan.continuationDefault !== 'automatic') errors.push('missing automatic transition default');
  if (plan.matrixRefs?.capabilities !== 'GUARDS.md#adapter-capability-matrix') errors.push('missing capability matrix reference');
  if (plan.matrixRefs?.bypasses !== 'GUARDS.md#framework-bypass-matrix') errors.push('missing bypass matrix reference');
  const decisions = ['material-undefined-product-decision', 'new-authority', 'review-budget-exhaustion', 'owner-only-merge'];
  if (!Array.isArray(plan.humanDecisions) || decisions.some(item => !plan.humanDecisions.includes(item)) ||
      plan.humanDecisions.some(item => !decisions.includes(item))) errors.push('invalid human decision points');
  if (!plan.roles || typeof plan.roles.development !== 'string' || !Object.hasOwn(plan.roles, 'independent-review')) errors.push('role map incomplete');
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  const edges = Array.isArray(plan.edges) ? plan.edges : [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!nodes.length || !edges.length || byId.size !== nodes.length || !byId.has(plan.start)) errors.push('invalid graph identity');
  for (const node of nodes) {
    if (node.kind === 'review') {
      if (!['review1', 'review2'].includes(node.id) || (plan.mode === 'resume' && plan.review?.consumed === 2)) errors.push('third review or review after exhausted resume');
      if (node.actor === plan.writer?.actor || plan.review?.previousInvolvement?.includes(node.actor)) errors.push('self-review or prior involvement');
    }
    if (node.actor && node.model !== plan.roles?.[node.actor]) errors.push('actor/model map mismatch');
  }
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || !edge.outcome) errors.push('invalid edge endpoint or outcome');
    if (typeof edge.requires !== 'string' || !edge.requires.trim()) errors.push('missing evidence edge');
    if (edge.outcome === 'integrated') {
      if (edge.continuation !== 'human') errors.push('owner merge is a human decision');
    } else if ((edge.continuation ?? plan.continuationDefault) !== 'automatic') errors.push('ordinary valid/rejection paths require automatic transition');
  }
  const reachable = start => {
    const seen = new Set();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...edges.filter(edge => edge.from === id && byId.has(edge.to)).map(edge => edge.to));
    }
    return seen;
  };
  if (nodes.some(node => !reachable(plan.start).has(node.id))) errors.push('disconnected node');
  for (const node of nodes.filter(item => item.kind === 'recovery')) {
    const after = reachable(node.id);
    if (nodes.some(item => after.has(item.id) && ['review', 'qa', 'correction'].includes(item.kind))) errors.push('terminal recovery cannot return to review/QA');
  }
  if (!nodes.some(node => node.kind === 'delivery') || !nodes.some(node => node.kind === 'stop') || !nodes.some(node => node.kind === 'cleanup')) errors.push('missing delivery/stop/cleanup path');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node validate_plan.mjs PLAN.json');
    const result = validatePlan(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
