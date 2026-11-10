# SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-only
"""Actual public-sync CLI on a private scoped fixture; never an outward sync or full-policy clearance."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys

root = Path.cwd()
area = Path(os.environ['TMPDIR']) / 'observer-public-dry-run'
source, public = area / 'source', area / 'public'
source.mkdir(parents=True)
public.mkdir()

def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout

def commit(repo, message):
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', message)

for relative in ['scripts/public_sync.py', 'config/public-sync-exclusions.json',
                 'config/public-sync-fixture-allowances.json', 'config/public-sync-lock-allowances.json',
                 'extensions/task-skill-observability.ts', 'scripts/enforcement/task_skill_observability_pi.js',
                 'docs/task-skill-observability.md', 'tests/test_task_skill_observability.mjs',
                 'tests/test_task_skill_observability_qa.mjs', 'tests/fixtures/observability-sdk.mjs']:
    destination = source / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / relative, destination)
(source / 'config/herdr-worker-repositories.v1.json').write_text(json.dumps({'repositories': ['agentic-driver']}))
(source / 'package.json').write_text(json.dumps({'name': '@evoclock/pi-agentic-driver',
    'peerDependencies': {'@earendil-works/pi-ai': '*'}, 'files': ['extensions/task-skill-observability.ts',
    'scripts/enforcement/task_skill_observability_pi.js', 'docs/task-skill-observability.md']}))
(public / 'README.md').write_text('Neutral private dry-run fixture.\n')
for repo in (source, public):
    git(repo, 'init', '-b', 'main')
    commit(repo, 'Initialize private dry-run fixture')
terms = area / 'terms.json'
terms.write_text(json.dumps({'schema': 'public-sync-terms.v1', 'persona_names': ['private-persona-marker'],
    'model_names': ['private-model-marker'], 'other_terms': ['private-term-marker'], 'private_paths': []}))
command = [sys.executable, str(source / 'scripts/public_sync.py'), '--source', str(source),
           '--public', str(public), '--terms', str(terms)]
before_public = git(public, 'rev-parse', 'HEAD')
original_paths = ['extensions/task-skill-observability.ts', 'scripts/enforcement/task_skill_observability_pi.js',
                  'docs/task-skill-observability.md', 'tests/test_task_skill_observability.mjs']
for relative in original_paths:
    (source / relative).write_text(git(root, 'show', 'fed22542c7a5a0839f3bcca4024df80874ee27a7:' + relative))
commit(source, 'Materialize actual pinned pre-repair feature files')
original = subprocess.run(command, capture_output=True, text=True)
assert original.returncode == 1, original.stdout + original.stderr
original_report = json.loads(original.stdout)
for relative in ['docs/task-skill-observability.md', 'tests/test_task_skill_observability.mjs']:
    assert any(row['path'] == relative and 'home path' in row['reason'] for row in original_report['findings'])
assert git(public, 'rev-parse', 'HEAD') == before_public
for relative in original_paths:
    shutil.copyfile(root / relative, source / relative)
commit(source, 'Restore exact corrected feature files')
before_source = git(source, 'rev-parse', 'HEAD')
positive = subprocess.run(command, capture_output=True, text=True)
assert positive.returncode == 0, positive.stdout + positive.stderr
report = json.loads(positive.stdout)
assert report['mode'] == 'dry-run' and report['findings'] == []
assert git(source, 'rev-parse', 'HEAD') == before_source
assert git(public, 'rev-parse', 'HEAD') == before_public
# A real literal-home injection must be rejected by the unchanged CLI, not by a fake return value.
doc = source / 'docs/task-skill-observability.md'
doc.write_text(doc.read_text() + '\n' + '/' + 'Users' + '/fixture/private-root\n')
commit(source, 'Inject neutral negative privacy canary')
negative = subprocess.run(command, capture_output=True, text=True)
assert negative.returncode == 1, negative.stdout + negative.stderr
negative_report = json.loads(negative.stdout)
assert any(row['path'] == 'docs/task-skill-observability.md' and 'home path' in row['reason']
           for row in negative_report['findings'])
assert git(public, 'rev-parse', 'HEAD') == before_public
print(json.dumps({'scope': 'exact observer files in private fixture, not full project/private deny-policy clearance',
    'pre_repair': original_report, 'positive': report, 'negative': negative_report, 'public_unchanged': True}))
