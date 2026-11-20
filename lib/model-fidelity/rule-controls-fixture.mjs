// Load a synthetic model-fidelity fixture for workflow callers.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULE_CONTROLS_FIXTURE = 'tests/fixtures/model-fidelity/rule-controls-04-05';

export function loadSyntheticFixture(root = '.') {
  const dir = join(root, RULE_CONTROLS_FIXTURE);
  if (existsSync(join(dir, 'expected.json')) !== true) {
    return null;
  }
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  if (expected.reviewStatus !== 'expected-unreviewed') {
    throw new Error('rule-controls fixture must stay unreviewed');
  }
  if (expected.scoringEligible !== false) {
    throw new Error('rule-controls fixture must not be scoring-eligible');
  }
  return {
    dir,
    expected,
    operations: JSON.parse(readFileSync(join(dir, 'operations.json'), 'utf8')),
  };
}
