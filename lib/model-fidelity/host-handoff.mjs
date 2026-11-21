import { validateRecord } from './records.mjs';

const kinds = new Set(['review', 'runtime', 'rollback', 'red-line-stop']);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

// Validate the link between the hand-off and T01's caller-step record, not just each JSON envelope.
export function validateHostHandoff(value, offered) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['model-fidelity.to-host.v1', 'model-fidelity.from-host.v1'].includes(value.schema))
    return { ok: false, errors: ['unknown hand-off schema'] };
  for (const key of ['unitId', 'attemptId', 'stepId', 'requestId', 'bundleId']) if (!id(value[key])) errors.push(`${key}: invalid ID`);
  if (!kinds.has(value.kind)) errors.push('kind: invalid');
  if (value.authorityCreated !== false) errors.push('authorityCreated: must be false');
  const fields = value.schema === 'model-fidelity.to-host.v1'
    ? ['schema', 'unitId', 'attemptId', 'stepId', 'kind', 'requestId', 'bundleId', 'resultId', 'action', 'artifactIds', 'findingIds', 'authorityCreated']
    : ['schema', 'unitId', 'attemptId', 'stepId', 'kind', 'requestId', 'bundleId', 'status', 'callerStep', 'artifactIds', 'reason', 'authorityCreated'];
  for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push(`${key}: unexpected`);
  if (value.artifactIds !== undefined && (!Array.isArray(value.artifactIds) || value.artifactIds.some(item => typeof item !== 'string' || !item) || new Set(value.artifactIds).size !== value.artifactIds.length)) errors.push('artifactIds: invalid');
  if (value.schema === 'model-fidelity.to-host.v1') {
    if (!id(value.resultId) || typeof value.action !== 'string' || !value.action || !Array.isArray(value.artifactIds)) errors.push('to-host: missing result, action or artifacts');
    if (value.findingIds !== undefined && (!Array.isArray(value.findingIds) || value.findingIds.some(item => !id(item)) || new Set(value.findingIds).size !== value.findingIds.length)) errors.push('findingIds: invalid');
    if (offered) errors.push('to-host: unexpected parent');
  } else {
    if (!offered || offered.schema !== 'model-fidelity.to-host.v1') errors.push('from-host: missing offer');
    else for (const key of ['unitId', 'attemptId', 'stepId', 'kind', 'requestId', 'bundleId']) if (value[key] !== offered[key]) errors.push(`${key}: does not match offer`);
    if (!['recorded', 'not-run', 'unknown', 'interrupted'].includes(value.status)) errors.push('status: invalid');
    if (value.status === 'recorded') {
      const checked = validateRecord('caller-step', value.callerStep);
      errors.push(...checked.errors);
      if (checked.ok) for (const key of ['unitId', 'attemptId', 'kind'])
        if (value.callerStep[key] !== value[key]) errors.push(`callerStep.${key}: does not match hand-off`);
    } else if (value.callerStep !== null || typeof value.reason !== 'string' || !value.reason) {
      errors.push('unrecorded step needs null callerStep and reason');
    }
  }
  return { ok: errors.length === 0, errors };
}
