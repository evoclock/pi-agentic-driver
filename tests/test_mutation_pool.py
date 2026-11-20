"""Conformance for isolated, bounded mutation batches."""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
from contextlib import ExitStack
import subprocess
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def runner():
    path = Path(os.environ.get('TEST_GATE_SCRIPT', ROOT / 'scripts/test_gate_runner.py'))
    spec = importlib.util.spec_from_file_location('mutation_pool_runner', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MutationPool(unittest.TestCase):
    def setUp(self):
        self.gate = runner()

    def test_node_partitions_preserve_native_counts_and_execution_evidence(self):
        """Why: shared pure files and isolated unsafe files must all contribute native totals."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            for name in ('node_test_run.mjs', 'node_test_isolation.mjs', 'node_test_sandbox.mjs'):
                source = ROOT / 'scripts' / name
                if source.exists():
                    shutil.copy2(source, root / 'scripts' / name)
            (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            pure = "import test from 'node:test'; import assert from 'node:assert/strict'; test('pure',()=>assert.equal(1+1,2));\n"
            for name in ('a.mjs', 'b.mjs'):
                (root / name).write_text(pure)
            (root / 'c.mjs').write_text("import test from 'node:test'; import assert from 'node:assert/strict'; import os from 'node:os'; test('unsafe',()=>assert.equal(typeof os.tmpdir(),'string'));\n")
            spec = {'command': ['node', '--test', '--test-reporter=tap', 'a.mjs', 'b.mjs', 'c.mjs'], 'timeoutSeconds': 30}
            with patch.object(self.gate, 'worktree_fingerprint', return_value=(0, '0' * 64)):
                observation = self.gate.run_command(root, root, spec, phase='mutation-head-tests', commit_sha='a' * 40, base_sha='b' * 40, expected='pass')
            self.assertEqual(observation['exitCode'], 0)
            self.assertEqual(observation['counts']['tests'], 3)
            commands = observation['record'].get('executedCommands', [])
            self.assertEqual(len(commands), 2, 'native execution partitions must be recorded')
            self.assertEqual([row['testCounts']['tests'] for row in commands], [2, 1])
            self.assertTrue(all(row['exitCode'] == 0 for row in commands))
            self.assertTrue(all('--test-reporter=tap' in row['argv'] for row in commands))

    def test_pool_is_bounded_overlaps_and_returns_input_order(self):
        """Why: independent jobs must overlap without completion-order attribution."""
        self.assertTrue(hasattr(self.gate, 'mutation_jobs'), 'bounded mutation pool is required')
        active = peak = 0
        lock = threading.Lock()
        def job(key, delay):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(delay)
            with lock:
                active -= 1
            return key
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PAD_TEST_GATE_WORKERS': '2', 'PAD_TEST_GATE_NESTED': ''}), patch.object(os, 'cpu_count', return_value=4):
            result = self.gate.mutation_jobs(Path(directory), {'slow': .06, 'fast': .01, 'last': .01}, job)
        self.assertEqual(result, ['slow', 'fast', 'last'])
        self.assertEqual(peak, 2)

    def test_container_cpu_quota_bounds_the_outer_pool(self):
        """Why: the offline two-CPU sandbox must not start four JVM-heavy commands at once."""
        self.assertTrue(hasattr(self.gate, 'available_cpus'), 'container-aware CPU observation is required')
        with tempfile.TemporaryDirectory() as directory:
            quota = Path(directory) / 'cpu.max'; quota.write_text('200000 100000\n')
            with patch.object(os, 'cpu_count', return_value=8):
                self.assertEqual(self.gate.available_cpus(quota), 2)
            with patch.object(self.gate, 'available_cpus', return_value=2), patch.object(os, 'cpu_count', return_value=8), patch.dict(os.environ, {'PAD_TEST_GATE_WORKERS':'4','PAD_TEST_GATE_NESTED':''}):
                self.assertEqual(self.gate.mutation_workers(), 2)

    def test_nested_pool_is_serial_and_invalid_bounds_are_blocked(self):
        """Why: fixture subprocesses cannot multiply the outer pool or raise its cap."""
        self.assertTrue(hasattr(self.gate, 'mutation_workers'), 'pool bounds are required')
        with patch.dict(os.environ, {'PAD_TEST_GATE_WORKERS': '4', 'PAD_TEST_GATE_NESTED': '1'}):
            self.assertEqual(self.gate.mutation_workers(), 1)
        for invalid in ('0', '5', '-1', 'unbounded'):
            with self.subTest(invalid=invalid), patch.dict(os.environ, {'PAD_TEST_GATE_WORKERS': invalid, 'PAD_TEST_GATE_NESTED': ''}):
                with self.assertRaises(self.gate.Blocked):
                    self.gate.mutation_workers()

    def test_attribution_rejects_another_contract_path_digest_or_exit(self):
        """Why: a neighbour's caught fault must never stand in for a surviving mutant."""
        self.assertTrue(hasattr(self.gate, 'verify_mutation_attribution'), 'exact attribution is required')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'app.py').write_text('value = 1\n')
            contract = {'id': 'one', 'path': 'app.py', 'before': 'value = 1', 'after': 'value = 2'}
            record = {'contractId': 'one', 'mutationPath': 'app.py', 'mutantSha256': self.gate.sha256_bytes(b'value = 2\n'), 'exitCode': 1}
            observation = {'record': record, 'exitCode': 1}
            self.gate.verify_mutation_attribution(root, contract, observation)
            for field, value in [('contractId', 'other'), ('mutationPath', 'else.py'), ('mutantSha256', '0' * 64), ('exitCode', 0)]:
                with self.subTest(field=field), self.assertRaises(self.gate.Blocked):
                    self.gate.verify_mutation_attribution(root, contract, {**observation, 'record': {**record, field: value}})

    def test_same_target_contracts_are_caught_alone_and_in_pool(self):
        """Why: source reset, own cwd and exact evidence must survive same-target batching."""
        self.assertTrue(hasattr(self.gate, 'mutation_jobs'), 'isolated mutation pool is required')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'tests').mkdir()
            (root / '.driver').mkdir()
            for name in ('gate-rules.json', 'test-gate.json'):
                (root / '.driver' / name).write_text('{}')
            (root / 'app.py').write_text('value = 1\n')
            (root / 'tests/test_value.py').write_text('import unittest\nfrom app import value\nfrom pathlib import Path\nclass Value(unittest.TestCase):\n def test_value(self):\n  """Why: the planted value must not pass."""\n  self.assertFalse(Path("touched").exists())\n  Path("touched").write_text("own tree")\n  self.assertEqual(value, 1)\n')
            (root / '.gitignore').write_text('scratch/\n.driver/test-gate-evidence/\n')
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], check=True)
            base = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            rules = {'checks': [{'id': 'python-tests', 'kind': 'command', 'command': ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']}]}
            contracts = {key: {'path': 'app.py', 'before': 'value = 1', 'after': f'value = {value}', 'testCheckId': 'python-tests', 'testPaths': ['tests/test_value.py'], 'reason': 'catch value fault'} for key, value in [('two', 2), ('three', 3)]}
            config = {'caps': {'maxObservedTests': 10000, 'commandTimeoutSeconds': 30}, 'testCountRationales': {'python-tests': 'unittest actual count'}, 'mutations': contracts}
            records = []
            for workers in ('1', '2'):
                with patch.dict(os.environ, {'PAD_TEST_GATE_WORKERS': workers, 'PAD_TEST_GATE_NESTED': ''}), patch.object(os, 'cpu_count', return_value=4):
                    runs = self.gate.mutation_observation(root, rules, config, set(), set(), base, base)
                self.assertEqual([r['record']['contractId'] for r in runs], ['two', 'three'])
                self.assertTrue(all(r['exitCode'] == 1 and r['counts']['failures'] == 1 for r in runs))
                records.extend(r['record'] for r in runs)
            self.assertFalse((root / 'touched').exists())
            self.assertEqual((root / 'app.py').read_text(), 'value = 1\n')
            self.assertEqual(len({r['executeTree'] for r in records}), 4)

    def test_evidence_append_waits_for_another_process_writer(self):
        """Why: separate runner sessions must not interleave shared evidence records."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = self.gate.evidence_path(root)
            code = 'import importlib.util,sys; from pathlib import Path; s=importlib.util.spec_from_file_location("writer",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print("ready",flush=True); m.append_evidence(Path(sys.argv[2]),{"probe":"x"*32768})'
            with target.open('a') as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                child = subprocess.Popen(['python3', '-c', code, self.gate.__file__, str(root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(child.stdout.readline(), 'ready\n')
                    with self.assertRaises(subprocess.TimeoutExpired):
                        child.wait(timeout=.2)
                finally:
                    fcntl.flock(holder, fcntl.LOCK_UN)
                    out, err = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, out + err)
            self.assertEqual(json.loads(target.read_text())['probe'], 'x' * 32768)

    def test_materialized_snapshot_has_its_own_git_identity(self):
        """Why: Git-dependent suites need private metadata, not a parent repo or a broken guard."""
        self.assertTrue(hasattr(self.gate, 'mutation_snapshot'), 'private head materialization is required')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'value').write_text('base')
            (root / 'mode').write_text('mode fixture')
            (root / 'mode').chmod(0o644)
            (root / '.gitignore').write_text('scratch/\n.driver/test-gate-evidence/\n')
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], check=True)
            sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            (root / 'value').unlink()
            (root / 'mode').chmod(0o755)
            with ExitStack() as cleanup:
                snapshot = self.gate.mutation_snapshot(root, sha, set(), {'value', 'mode'}, cleanup)
                self.assertFalse((snapshot / 'value').exists(), 'private head must not resurrect a deleted base file')
                self.assertEqual((snapshot / 'mode').stat().st_mode & 0o777, 0o755, 'private head must preserve executable mode changes')
                spec = {'command': ['git', 'rev-parse', '--show-toplevel'], 'cwd': '.', 'timeoutSeconds': 10}
                observation = self.gate.run_command(root, snapshot, spec, phase='mutation-head-tests', commit_sha=sha, base_sha=sha, expected='private Git metadata is available')
                self.assertEqual(observation['exitCode'], 0, observation['output'])
                self.assertEqual(Path(observation['output'].strip()).resolve(), snapshot.resolve())
                private_git = subprocess.check_output(['git', '-C', str(snapshot), 'rev-parse', '--absolute-git-dir'], text=True).strip()
                self.assertEqual(Path(private_git).resolve(), (snapshot / '.git').resolve())
                self.assertNotEqual(Path(private_git).resolve(), (root / '.git').resolve())
            (root / 'value').symlink_to(root / '.gitignore')
            with ExitStack() as cleanup, self.assertRaisesRegex(self.gate.Blocked, 'linked'):
                self.gate.mutation_snapshot(root, sha, set(), {'value'}, cleanup)

    def test_private_tree_git_discovery_stops_before_shared_checkout(self):
        """Why: a scratch command must not discover its parent checkout's Git metadata."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            child = root / 'private'
            child.mkdir()
            spec = {'command': ['git', 'rev-parse', '--show-toplevel'], 'cwd': '.', 'timeoutSeconds': 10}
            overrides = {'GIT_DIR': str(root / '.git'), 'GIT_WORK_TREE': str(root), 'GIT_COMMON_DIR': str(root / '.git'), 'GIT_INDEX_FILE': str(root / '.git/index'), 'GIT_OBJECT_DIRECTORY': str(root / '.git/objects'), 'GIT_ALTERNATE_OBJECT_DIRECTORIES': str(root / '.git/objects')}
            with patch.object(self.gate, 'worktree_fingerprint', return_value=(0, '0' * 64)), patch.dict(os.environ, {**overrides, 'GIT_CEILING_DIRECTORIES': ''}):
                observation = self.gate.run_command(root, child, spec, phase='mutation-head-tests', commit_sha='a' * 40, base_sha='a' * 40, expected='private Git discovery boundary')
                code = 'import os,json; print(json.dumps({name:os.environ.get(name) for name in ' + repr(list(overrides)) + '}))'
                probe = self.gate.run_command(root, child, {**spec, 'command': ['python3', '-c', code]}, phase='mutation-head-tests', commit_sha='a' * 40, base_sha='a' * 40, expected='inherited Git overrides removed')
            self.assertNotEqual(observation['exitCode'], 0)
            self.assertEqual(probe['exitCode'], 0)
            self.assertEqual(json.loads(probe['output']), dict.fromkeys(overrides))

    def test_private_commands_get_distinct_cleaned_temp_and_java_directories(self):
        """Why: concurrent JVMs must not extract standard modules into a shared temp file."""
        self.assertTrue(hasattr(self.gate, 'mutation_jobs'), 'private mutation commands are required')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            children = {key: root / key for key in ('a', 'b')}
            for child in children.values():
                child.mkdir()
            code = 'import os,json; from pathlib import Path; p=Path(os.environ.get("TMPDIR","")); assert p.name.startswith("test-gate-command-"), str(p); (p/"owned").write_text("fixture"); print(json.dumps({k:os.environ.get(k) for k in ("TMPDIR","TMP","TEMP","JAVA_TOOL_OPTIONS")}))'
            spec = {'command': ['python3', '-c', code], 'cwd': '.', 'timeoutSeconds': 10}
            def job(key, child):
                result = self.gate.run_command(root, child, spec, phase='mutation-head-tests', commit_sha='a'*40, base_sha='a'*40, expected='fresh per-command temp')
                self.assertEqual(result['exitCode'], 0, result['output'])
                return json.loads(result['output'])
            with patch.object(self.gate, 'worktree_fingerprint', return_value=(0, '0'*64)), patch.dict(os.environ, {'JAVA_TOOL_OPTIONS':'-Ddriver.keep=1','PAD_TEST_GATE_WORKERS':'2','PAD_TEST_GATE_NESTED':''}):
                results = self.gate.mutation_jobs(root, children, job)
            self.assertEqual(len({result['TMPDIR'] for result in results}), 2)
            for result in results:
                self.assertEqual(result['TMP'], result['TMPDIR'])
                self.assertEqual(result['TEMP'], result['TMPDIR'])
                self.assertTrue(result['JAVA_TOOL_OPTIONS'].startswith('-Ddriver.keep=1 '))
                self.assertIn('-Djava.io.tmpdir=' + json.dumps(result['TMPDIR']), result['JAVA_TOOL_OPTIONS'])
                self.assertFalse(Path(result['TMPDIR']).exists())

    def test_pool_failure_keeps_its_contract_name(self):
        """Why: a delayed failure must not be assigned to a faster successful neighbour."""
        self.assertTrue(hasattr(self.gate, 'mutation_jobs'), 'attributed failures are required')
        def job(key, _):
            if key == 'broken':
                time.sleep(.02)
                raise self.gate.GateFailure('survived')
            return key
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PAD_TEST_GATE_WORKERS': '2', 'PAD_TEST_GATE_NESTED': ''}):
            with self.assertRaisesRegex(self.gate.GateFailure, 'broken: survived'):
                self.gate.mutation_jobs(Path(directory), {'good': None, 'broken': None}, job)


if __name__ == '__main__':
    unittest.main()
