// Load a synthetic model-fidelity fixture for workflow callers.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DISCONNECT_FIXTURE = 'tests/fixtures/model-fidelity/disconnect-02';

export function loadSyntheticFixture(root = '.') {
  const dir = join(root, DISCONNECT_FIXTURE);
  if (existsSync(join(dir, 'expected.json')) !== true) {
    return null;
  }
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  if (expected.reviewStatus !== 'expected-unreviewed') {
    throw new Error('disconnect fixture must stay unreviewed');
  }
  if (expected.scoringEligible !== false) {
    throw new Error('disconnect fixture must not be scoring-eligible');
  }
  return {
    dir,
    expected,
    operations: JSON.parse(readFileSync(join(dir, 'operations.json'), 'utf8')),
  };
}
