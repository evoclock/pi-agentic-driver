// Load a synthetic model-fidelity fixture for workflow callers.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LOCK_WINDOW_FIXTURE = 'tests/fixtures/model-fidelity/lock-window-03';

export function loadSyntheticFixture(root = '.') {
  const dir = resolve(root, LOCK_WINDOW_FIXTURE);
  if (existsSync(join(dir, 'expected.json')) !== true) {
    return null;
  }
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  if (expected.reviewStatus !== 'expected-unreviewed') {
    throw new Error('lock-window fixture must stay unreviewed');
  }
  if (expected.scoringEligible !== false) {
    throw new Error('lock-window fixture must not be scoring-eligible');
  }
  return {
    dir,
    expected,
    operations: JSON.parse(readFileSync(join(dir, 'operations.json'), 'utf8')),
  };
}
