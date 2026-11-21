import { createHash } from 'node:crypto';

const string = { type: 'string', minLength: 1 };
const list = { type: 'array', items: string };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const choice = (...values) => ({ enum: values });
const shape = (name, required, properties, options = {}) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: `model-fidelity.${name}.v1`, type: 'object',
  required: ['schema', ...required],
  properties: { schema: { const: `model-fidelity.${name}.v1` }, ...properties },
  additionalProperties: options.extensible ?? false,
});

const common = { id: string };
export const requestPayloads = {
  prepare: shape('payload.prepare', ['mode', 'planRef', 'designRefs'], { mode: choice('protocol', 'light'), planRef: string, designRefs: list, planId: string }),
  check: shape('payload.check', ['bundleId'], { bundleId: string, controlIds: list, limits: { type: 'object' } }),
  assess: shape('payload.assess', ['bundleId', 'checkResultIds', 'reviewArtifactIds'], { bundleId: string, checkResultIds: list, reviewArtifactIds: list }),
  diagram: shape('payload.diagram', ['bundleId'], { bundleId: string, resultIds: list }),
  evaluate: shape('payload.evaluate', ['planId', 'bundleId', 'assessmentIds', 'runtimeArtifactIds', 'changeRef', 'rollbackRecordRef'], { planId: string, bundleId: string, assessmentIds: list, runtimeArtifactIds: list, changeRef: string, rollbackRecordRef: { type: ['string', 'null'] }, priorEvaluateRequestId: string }),
  read: shape('payload.read', [], { artifactId: string, resultId: string }),
};
const finding = { type: 'object', required: ['id', 'code', 'message', 'origin', 'evidenceIds'], properties: {
  id: string, code: string, actionId: string, message: string, origin: choice('author-claim', 'inspected-source', 'versioned-api-guarantee', 'model-run', 'host-observed-test'), evidenceIds: list, suggestedNext: string,
  redLine: choice('raw-data-overwrite', 'key-asset-delete', 'same-script-reedit'), confidence: choice('confirmed', 'suspected'),
}, additionalProperties: false };
const callerFields = { ...common, unitId: string, attemptId: string, kind: choice('review', 'runtime', 'rollback', 'red-line-stop'), reviewArtifactId: string, observationId: string, status: choice('observed', 'not-run', 'unknown'), revision: { type: 'string', pattern: '^[a-f0-9]{40}$' }, manifestDigest: digest, outcome: choice('not-needed', 'suggested', 'deprecated', 'observed', 'failed', 'unknown', 'not-permitted'), findingId: string, stoppedAction: string };

export const schemas = Object.freeze({
  plan: shape('plan', ['id', 'goals', 'currentGenerationRule', 'allowedPostDeathCompletion', 'initialConditions', 'exclusions', 'failureCases', 'progressRequirements', 'scope', 'intendedRollback'], { ...common, goals: list, currentGenerationRule: string, allowedPostDeathCompletion: { type: 'boolean' }, initialConditions: list, exclusions: list, failureCases: list, progressRequirements: list, scope: list, intendedRollback: string }),
  design: shape('design', ['id', 'planId', 'mode', 'sourceRefs', 'modelRefs', 'configRefs', 'dependencyRefs', 'actionIds', 'environmentId'], { ...common, planId: string, mode: choice('protocol', 'light'), sourceRefs: list, modelRefs: list, configRefs: list, dependencyRefs: list, actionIds: list, environmentId: string }),
  'action-map': shape('action-map', ['actionId', 'kind', 'modelLocation', 'actor', 'session', 'privilege', 'realOperation', 'sourceEvidenceIds', 'preconditions', 'observedValue', 'observedFrom', 'protectedInterval', 'effectPoint', 'assumptions'], { actionId: string, kind: choice('implementation', 'environment', 'bookkeeping'), modelLocation: string, actor: string, session: string, privilege: string, realOperation: string, sourceEvidenceIds: list, preconditions: list, observedValue: string, observedFrom: string, protectedInterval: string, effectPoint: string, assumptions: list }),
  environment: shape('environment', ['id', 'events', 'omissions'], { ...common, events: list, omissions: list }),
  evidence: shape('evidence', ['id', 'claim', 'artifactDigest', 'origin'], { ...common, claim: string, artifactDigest: digest, sourceSpan: string, traceStep: string, origin: choice('author-claim', 'inspected-source', 'versioned-api-guarantee', 'model-run', 'host-observed-test') }),
  review: shape('review', ['id', 'bundleId', 'reviewer', 'provenance', 'challengeSchedules', 'evidenceIds', 'unresolvedAssumptions'], { ...common, bundleId: string, reviewer: string, provenance: choice('self-reported', 'host-bound', 'missing'), challengeSchedules: list, evidenceIds: list, unresolvedAssumptions: list }),
  view: shape('view', ['bundleDigest', 'viewId', 'mode', 'states', 'transitions', 'findings'], { bundleDigest: digest, viewId: choice('lifecycle', 'action-map', 'fault-window', 'results'), mode: choice('protocol', 'light'), states: { type: 'array', items: { type: 'object' } }, transitions: { type: 'array', items: { type: 'object' } }, findings: list, omittedViews: { type: 'array', items: { type: 'object', required: ['viewId', 'status', 'reason'], properties: { viewId: string, status: { const: 'not-applicable' }, reason: string }, additionalProperties: false } }, hiddenSteps: list, grouping: { type: 'object' } }),
  request: shape('request', ['requestId', 'unitId', 'attemptId', 'operation', 'payload'], { requestId: string, unitId: string, attemptId: string, operation: choice(...Object.keys(requestPayloads)), payload: { type: 'object' } }),
  result: shape('result', ['requestId', 'unitId', 'attemptId', 'operation', 'status', 'continuation', 'findings', 'checks', 'correspondence', 'runtime', 'diagrams', 'artifactIds', 'errors', 'authorityCreated'], { requestId: string, unitId: string, attemptId: string, operation: choice(...Object.keys(requestPayloads)), status: choice('complete', 'partial', 'error'), continuation: choice('continue', 'stop-red-line'), planId: string, bundleId: string, findings: { type: 'array', items: finding }, checks: { type: 'array', items: { type: 'object' } }, correspondence: choice('not-assessed', 'gaps', 'supported-under-assumptions', 'implementation-correspondence-not-assessed'), runtime: choice('not-run', 'observed', 'unknown'), diagrams: { type: 'array', items: { type: 'object' } }, artifactIds: list, errors: { type: 'array', items: { type: 'object' } }, authorityCreated: { const: false }, rollback: choice('not-needed', 'suggested', 'deprecated', 'observed', 'failed', 'unknown', 'not-permitted'), planMatch: choice('matches', 'differs', 'unknown') }, { extensible: true }),
  'caller-step': shape('caller-step', ['id', 'unitId', 'attemptId', 'kind'], callerFields),
});

function check(schema, value, path, errors) {
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid value`);
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type)) errors.push(`${path}: wrong type`);
  if (typeof value === 'string' && ((schema.minLength && value.length < schema.minLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) errors.push(`${path}: invalid string`);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties[key]) check(schema.properties[key], item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false || ['verified', 'verifiedImplementation', 'blocking'].includes(key)) errors.push(`${path}.${key}: unexpected`);
    }
  }
}

export function validateRecord(kind, value) {
  const errors = [];
  const schema = schemas[kind];
  if (!schema) return { ok: false, errors: [`unknown record kind: ${kind}`] };
  check(schema, value, kind, errors);
  if (value && typeof value === 'object') {
    if (kind === 'request' && requestPayloads[value.operation]) {
      check({ ...requestPayloads[value.operation], required: requestPayloads[value.operation].required.filter(key => key !== 'schema'), properties: { ...requestPayloads[value.operation].properties, schema: undefined } }, value.payload, 'request.payload', errors);
      if (value.operation === 'read' && Number('artifactId' in (value.payload ?? {})) + Number('resultId' in (value.payload ?? {})) !== 1) errors.push('request.payload: exactly one reference required');
    }
    if (kind === 'result' && value.continuation === 'stop-red-line' && !(Array.isArray(value.findings) && value.findings.some(f => f?.confidence === 'confirmed' && ['raw-data-overwrite', 'key-asset-delete'].includes(f.redLine)))) errors.push('result.continuation: confirmed red line required');
    if (kind === 'result' && Array.isArray(value.findings) && value.findings.some(f => f?.redLine === 'same-script-reedit' && f.confidence === 'confirmed')) errors.push('result.findings: script reedit is suspected only');
    if (kind === 'view' && value.mode === 'light' && !value.omittedViews?.length) errors.push('view.omittedViews: light mode requires explicit omissions');
    if (kind === 'caller-step') {
      const required = { review: ['reviewArtifactId'], runtime: ['observationId', 'status'], rollback: ['revision', 'manifestDigest', 'outcome'], 'red-line-stop': ['findingId', 'stoppedAction'] }[value.kind] ?? [];
      for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`caller-step.${key}: required`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const safeId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new TypeError('Invalid artifact ID');
  return value;
};
export function outputPath(kind, ids) {
  if (kind === 'view') return `views/${safeId(ids.viewId)}/${safeId(ids.resultId)}/`;
  if (kind === 'evaluation') return `evaluation/${safeId(ids.resultId)}/`;
  if (kind === 'result') return `results/${safeId(ids.requestId)}.json`;
  throw new TypeError('Unknown output kind');
}
export function dedupKey({ requestId, checkerVersion, inputDigest }) {
  if (typeof checkerVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(checkerVersion)) throw new TypeError('Invalid checker version');
  if (typeof inputDigest !== 'string' || !inputDigest.length) throw new TypeError('Invalid input digest');
  return createHash('sha256').update(JSON.stringify([safeId(requestId), checkerVersion, inputDigest])).digest('hex');
}
