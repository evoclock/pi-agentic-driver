import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTracker } from '../skills/crew-tracker-sync/validate_tracker.mjs';

// Why: the tracker must show each open PR, agent stream and human unblock without moving draft PRs into owner steps.
test('tracker validator checks open PR, stream and human-step invariants', () => {
  const source = { prs: [{ title: 'Work', repo: 'a/b', state: 'draft' }, { title: 'Ready', repo: 'a/b', state: 'ready' }], agents: ['alpha'] };
  const tracker = { merges: [['Work', 'a/b', 'alpha', 'draft (2h)'], ['Ready', 'a/b', 'alpha', 'ready']],
    streams: [['alpha', 'Area', 'Work at 12:00', 'Nothing right now']],
    steps: [{ text: 'Merge Ready', done: false, meta: '12:00 local' }], decisions: [], settled: [] };
  assert.deepEqual(validateTracker(tracker, source), []);
  assert.match(validateTracker({ ...tracker, merges: tracker.merges.slice(1) }, source).join(' '), /Work/);
  assert.match(validateTracker({ ...tracker, streams: [] }, source).join(' '), /alpha/);
  assert.match(validateTracker({ ...tracker, steps: [...tracker.steps, { text: 'Merge Work', done: false, meta: '12:00 local' }] }, source).join(' '), /draft/i);
});
