"""Fail-safe affected mutation selection under the full-proof override."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import nullcontext, ExitStack
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class MutationSelection(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location('selection_runner', ROOT / 'scripts/test_gate_runner.py')
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        self.assertTrue(hasattr(gate, 'select_mutation_contracts'), 'affected mutation selection is required')
        return gate

    def test_supervised_native_entry_forwards_affected_mode_with_same_cap(self):
        """Why: selecting affected contracts must retain the native supervisor and its inherited cap."""
        spec = importlib.util.spec_from_file_location('selection_supervisor', ROOT / 'scripts/gate.py')
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        with patch('sys.argv', ['gate.py', '--native-phase', 'check']), \
             patch.dict(os.environ, {'TEST_GATE_MUTATIONS': 'affected'}), \
             patch.object(driver, 'load_rules', return_value={'speedBudgetSeconds': 600}), \
             patch.object(driver.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stderr='')), \
             patch.object(driver, 'preflight_findings', return_value=[]), \
             patch.object(driver, 'observable_gate_lock', return_value=nullcontext()), \
             patch.object(driver, 'record_runtime'), \
             patch.object(driver, 'run_bounded', return_value=0) as run:
            self.assertEqual(driver._locked_entry(), 0)
        command, cap = run.call_args.args
        self.assertEqual(command[-4:], ['--phase', 'check', '--mutations', 'affected'])
        self.assertEqual(cap, driver.NATIVE_BUDGET_SECONDS)

    def config(self):
        return {'mutations': {key: {'path': target, 'testPaths': ['tests/test_' + key + '.py']} for key, target in [('one', 'app.py'), ('two', 'other.py'), ('three', 'app.py')]}}

    def test_every_registered_target_keeps_its_declared_killing_tests(self):
        """Why: affected selection cannot drop a contract or its killing suite on any registered target."""
        gate = self.load()
        config = json.loads((ROOT / '.driver/test-gate.json').read_text())
        rules = json.loads((ROOT / '.driver/gate-rules.json').read_text())
        for key, contract in gate.mutation_contracts(config).items():
            with self.subTest(contract=key):
                selected = gate.select_mutation_contracts(config, {contract['path']}, 'affected')
                self.assertIn(key, selected['mutations'])
                self.assertEqual(selected['mutations'][key]['testPaths'], contract['testPaths'])
                spec = gate.mutation_command_spec(ROOT, rules, selected, selected['mutations'][key])
                self.assertEqual(set(spec['testFiles']), set(contract['testPaths']))

    def test_touched_target_selects_exactly_its_contracts(self):
        """Why: unrelated production contracts do not belong to a mapped PR subset."""
        gate = self.load()
        selected = gate.select_mutation_contracts(self.config(), {'app.py'}, 'affected')
        self.assertEqual(list(selected['mutations']), ['one', 'three'])
        self.assertEqual(selected['mutationSelection']['available'], 3)
        self.assertEqual(selected['mutationSelection']['selected'], 2)

    def test_unknown_test_contract_and_gate_changes_select_full(self):
        """Why: uncertainty or changes to the proof machinery must require the full set."""
        gate = self.load()
        for path in ('unknown.py', 'docs/unknown.md', 'tests/test_one.py', '.driver/test-gate.json', '.driver/gate-rules.json', 'scripts/test_gate_runner.py', 'scripts/gate.py', 'Makefile', '.buildkite/pipeline.yml'):
            with self.subTest(path=path):
                selected = gate.select_mutation_contracts(self.config(), {path}, 'affected')
                self.assertEqual(list(selected['mutations']), ['one', 'two', 'three'])
        self.assertEqual(len(gate.select_mutation_contracts(self.config(), set(), 'all')['mutations']), 3)
        self.assertEqual(gate.select_mutation_contracts(self.config(), set(), 'affected')['mutations'], {})

    def test_malformed_mapping_selects_full_without_guessing(self):
        """Why: incomplete registry metadata is uncertainty, never an empty subset or crash."""
        gate = self.load()
        broken = self.config()
        del broken['mutations']['one']['path']
        try:
            selected = gate.select_mutation_contracts(broken, {'app.py'}, 'affected')
        except KeyError as error:
            self.fail(f'incomplete mapping crashed instead of selecting full: {error}')
        self.assertEqual(len(selected['mutations']), 3)

    def test_registered_suites_and_near_match_proof_files_force_full(self):
        """Why: helper and liveness filenames without test_ prefixes remain proof inputs."""
        gate = self.load()
        config = json.loads((ROOT / '.driver/test-gate.json').read_text())
        contracts = gate.mutation_contracts(config)
        paths = {path for contract in contracts.values() for path in contract['testPaths']}
        paths.update({'tests/helpers/tlc.mjs', 'tests/parallel_scheduler_liveness.mjs', 'tests/workflow_runner_authority_fixture.mjs', 'scripts/review_gate_tools.mjs', 'lib/model-fidelity/tlc-runner.mjs', 'scripts/pad_test_treehouse.js', 'docs/design/review-preflight/terms-boundary-verification.v1.json'})
        for path in sorted(paths):
            with self.subTest(path=path):
                self.assertEqual(len(gate.select_mutation_contracts(config, {path}, 'affected')['mutations']), len(contracts))

    def test_a_selected_planted_fault_is_caught_by_the_real_cli(self):
        """Why: subset selection must still execute and catch the exact touched-file fault."""
        gate = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'tests').mkdir()
            (root / '.driver').mkdir()
            (root / '.gitignore').write_text('scratch/\n.driver/test-gate-evidence/\n')
            (root / 'app.py').write_text('value = 1\n')
            (root / 'other.py').write_text('value = 7\n')
            for name, value in [('app', 1), ('other', 7)]:
                (root / 'tests' / ('test_' + name + '.py')).write_text(f'import unittest\nfrom {name} import value\nclass Value(unittest.TestCase):\n def test_value(self):\n  """Why: reject the planted fault."""\n  self.assertEqual(value, {value})\n')
            rules = {'schema': 'driver-gate-rules.v1', 'baseRef': 'HEAD', 'checks': [{'id': 'python-tests', 'kind': 'command', 'command': ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']}]}
            config = {'schema': 'driver-test-gate.v1', 'caps': {'maxObservedTests': 10000, 'commandTimeoutSeconds': 30}, 'testCountRationales': {'python-tests': 'unittest actual count'}, 'mutations': {name: {'path': name + '.py', 'before': f'value = {value}', 'after': 'value = 0', 'testCheckId': 'python-tests', 'testPaths': ['tests/test_' + name + '.py'], 'reason': 'catch planted value'} for name, value in [('app', 1), ('other', 7)]}}
            (root / '.driver/gate-rules.json').write_text(json.dumps(rules))
            (root / '.driver/test-gate.json').write_text(json.dumps(config))
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], check=True)
            # Only production bytes change: the existing test still observes value=1.
            (root / 'app.py').write_text('value = 1\n# touched\n')
            selected = gate.select_mutation_contracts(config, {'app.py'}, 'affected')
            sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            runs = gate.mutation_observation(root, rules, selected, {'app.py'}, {'tests/test_app.py'}, sha, sha)
            self.assertEqual([r['record']['contractId'] for r in runs], ['app'])
            self.assertEqual(runs[0]['exitCode'], 1)
            self.assertEqual(runs[0]['counts']['failures'], 1)
            # Full mode is required to run contracts even on unchanged main.
            (root / 'app.py').write_text('value = 1\n')
            run = subprocess.run(['python3', str(ROOT / 'scripts/test_gate_runner.py'), '--root', str(root), '--mutations', 'all'], env={**os.environ, 'PAD_TEST_GATE_WORKERS': '1'}, text=True, capture_output=True)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertIn('"mutationCaught": true', run.stdout)
            self.assertIn('"app.py", "other.py"', run.stdout)
            (root / 'app.py').write_text('value = 1\n# mapped-only production refactor\n')
            refused = subprocess.run(['python3', str(ROOT / 'scripts/test_gate_runner.py'), '--root', str(root), '--mutations', 'affected'], text=True, capture_output=True)
            self.assertEqual(refused.returncode, 3, refused.stdout + refused.stderr)
            self.assertIn('changed code has no changed tests', refused.stdout)

    def test_archive_checkout_dependency_link_keeps_main_only_contract_and_rejects_source_links(self):
        """Why: a read-only dependency mount is not changed source after a main-only contract merge."""
        gate = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'work'; root.mkdir()
            dependency = Path(directory) / 'mounted-dependencies'; dependency.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
            git('init', '-q', '--template=')
            git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
            (root / '.gitignore').write_text((ROOT / '.gitignore').read_text())
            (root / '.driver').mkdir(); (root / 'tests').mkdir()
            rules = {'schema':'driver-gate-rules.v1','baseRef':'HEAD','checks':[{'id':'python-tests','kind':'command','command':['python3','-m','unittest','discover','-s','tests','-p','test_*.py']}]}
            config = {'schema':'driver-test-gate.v1','caps':{'maxObservedTests':10000,'commandTimeoutSeconds':30},'testCountRationales':{'python-tests':'actual native unittest total'},'mutations':{}}
            (root / '.driver/gate-rules.json').write_text(json.dumps(rules))
            (root / '.driver/test-gate.json').write_text(json.dumps(config))
            git('add','.'); git('commit','-qm','initial base'); git('branch','-M','main'); git('branch','feature')
            (root / 'stable.py').write_text('value = 7\n')
            (root / 'tests/test_stable.py').write_text('import unittest\nfrom stable import value\nclass Stable(unittest.TestCase):\n def test_value(self):\n  """Why: main-only inherited behavior must execute and reject its fault."""\n  self.assertEqual(value,7)\n')
            config['mutations']['main-only'] = {'path':'stable.py','before':'value = 7','after':'value = 0','testCheckId':'python-tests','testPaths':['tests/test_stable.py'],'reason':'preserve main-only mutation proof'}
            (root / '.driver/test-gate.json').write_text(json.dumps(config))
            git('add','.'); git('commit','-qm','main gains inherited contract'); base = git('rev-parse','HEAD')
            git('switch','-q','feature'); git('merge','--no-ff','main','-m','integrate current main')
            (root / 'README.md').write_text('Feature documentation only.\n')
            git('add','README.md'); git('commit','-qm','feature documentation')
            # Match the contained archive checkout: Git metadata plus an external dependency link.
            (root / 'node_modules').symlink_to(dependency, target_is_directory=True)
            changed = gate.changed_paths(root, base)
            self.assertEqual(changed, {'README.md'})
            self.assertNotIn('stable.py', changed)
            selected = gate.select_mutation_contracts(config, changed, 'affected')
            self.assertEqual(set(selected['mutations']), {'main-only'})
            run = subprocess.run(['python3',str(ROOT / 'scripts/test_gate_runner.py'),'--root',str(root),'--base',base,'--mutations','affected'],text=True,capture_output=True)
            self.assertEqual(run.returncode,0,run.stdout+run.stderr)
            rows = [json.loads(line) for line in (root / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
            killed = [row for row in rows if row.get('phase') == 'mutation-spot-check']
            self.assertEqual([row['contractId'] for row in killed], ['main-only'])
            self.assertGreater(killed[0]['testCounts']['failures'],0)
            self.assertEqual(killed[0]['testCounts']['errors'],0)
            (dependency / 'unmanaged.py').write_text('value = 9\n')
            (root / 'unmanaged.py').symlink_to(dependency / 'unmanaged.py')
            with ExitStack() as cleanup:
                with self.assertRaisesRegex(gate.Blocked,'changed linked inputs'):
                    gate.mutation_snapshot(root,base,{'tests/test_stable.py'},gate.changed_paths(root,base),cleanup)


if __name__ == '__main__':
    unittest.main()
