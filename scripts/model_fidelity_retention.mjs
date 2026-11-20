#!/usr/bin/env node
import { appendRetentionBundle, retentionDestination, verifyPrivateEvidenceOrigin } from '../lib/model-fidelity/retention.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length % 2) throw new TypeError('usage: --repo ABSOLUTE_PATH [--destination ABSOLUTE_PATH] [--bundle ABSOLUTE_PATH --plan-id ID --bundle-id ID]');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--repo', '--destination', '--bundle', '--plan-id', '--bundle-id'].includes(key) || options[key]) throw new TypeError('unknown or repeated option');
    options[key] = args[i + 1];
  }
  const selected = retentionDestination({ repo: options['--repo'], destination: options['--destination'] });
  const append = ['--bundle', '--plan-id', '--bundle-id'].map(key => options[key]);
  if (append.some(Boolean) && (append.some(value => !value) || !options['--destination'])) throw new TypeError('append requires destination, bundle, plan-id and bundle-id');
  console.log(JSON.stringify({ schema: 'model-fidelity.retention.v1', ...(append.every(Boolean)
    ? appendRetentionBundle({ bundle: append[0], destination: selected.root, planId: append[1], bundleId: append[2], verifyDestination: verifyPrivateEvidenceOrigin })
    : selected) }));
} catch (error) {
  console.log(JSON.stringify({ schema: 'model-fidelity.retention.v1', error: error.message }));
  process.exitCode = 2;
}
