"""Build-local install reuse, tested without network or a real package install."""
import importlib.util
import hashlib
import io
import tarfile
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CiInstall(unittest.TestCase):
    def load(self):
        path = ROOT / 'scripts/ci_install.py'
        self.assertTrue(path.is_file(), 'build-local install cache is required')
        spec = importlib.util.spec_from_file_location('ci_install', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def fixture(self, root, lock='{}'):
        for prefix in ('', 'janus'):
            project = root / prefix
            project.mkdir(parents=True, exist_ok=True)
            (project / 'package.json').write_text('{}')
            (project / 'package-lock.json').write_text(lock)
        return root

    def test_offline_tlc_toolchain_is_pinned_verified_and_mounted_read_only(self):
        """Why: offline mutation proof must execute the Java backend rather than skip absent tools."""
        path = ROOT / 'scripts/ci_tlc_tools.py'
        self.assertTrue(path.is_file(), 'verified offline TLC tool preparation is required')
        spec = importlib.util.spec_from_file_location('ci_tlc_tools', path)
        tools = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tools)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w:gz') as bundle:
                for name in ('jdk/bin/java', 'jdk/lib/modules'):
                    entry = tarfile.TarInfo(name); entry.size = 4; entry.mode = 0o755
                    bundle.addfile(entry, io.BytesIO(b'tool'))
            blobs = {'jdk': archive.getvalue(), 'tlc': b'jar fixture'}
            manifest = {name: {'url': 'https://example.invalid/' + name, 'sha256': hashlib.sha256(blob).hexdigest()} for name, blob in blobs.items()}
            manifest['jdk']['directory'] = 'jdk'
            def fetch(asset, target):
                target.write_bytes(blobs[asset['url'].rsplit('/', 1)[1]])
            tools.install_tools(root / 'tools', manifest, fetch)
            self.assertTrue((root / 'tools/jdk/bin/java').is_file())
            self.assertEqual((root / 'tools/tla2tools.jar').read_bytes(), blobs['tlc'])
            bad = {**manifest, 'tlc': {**manifest['tlc'], 'sha256': '0' * 64}}
            with self.assertRaisesRegex(ValueError, 'checksum'):
                tools.install_tools(root / 'bad', bad, fetch)
        script = (ROOT / 'scripts/ci-observability.sh').read_text()
        self.assertIn('scripts/ci_tlc_tools.py', script)
        self.assertIn('dst=/tlc-toolchain,readonly', script)
        self.assertIn('TLA2TOOLS=/tlc-toolchain/tla2tools.jar', script)
        self.assertIn('TLC_REQUIRED=1', script)
        self.assertIn('--network none', script)
        self.assertIn('--memory 2g', script)
        pinned = json.loads((ROOT / 'config/ci-tlc-tools.v1.json').read_text())
        self.assertEqual(pinned['jdk']['sha256'], '8daf77d1aacffe38c9889689bc224a13557de77559d9a5bb91991e6a298baa0d')
        self.assertEqual(pinned['tlc']['sha256'], '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88')

    def test_buildkite_gate_durable_types_use_the_same_installer(self):
        """Why: all three jobs must use the real shared installer, not parallel npm ci calls."""
        pipeline = (ROOT / '.buildkite/pipeline.yml').read_text()
        for key in ('gate', 'durable', 'types'):
            block = pipeline.split(f'    key: "{key}"', 1)[1].split('  - label:', 1)[0]
            self.assertIn('python3 scripts/ci_install.py', block)
            self.assertNotIn('sfw npm ci ', block)

    def test_once_per_build_lock_and_runtime_with_independent_restores(self):
        """Why: identical jobs share installation but never writable node_modules trees."""
        cache = self.load()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            first = self.fixture(base / 'a')
            second = self.fixture(base / 'b')
            calls = []
            def install(command, *, cwd, env, check):
                calls.append((command, env['npm_config_cache']))
                modules = Path(cwd) / 'node_modules'
                modules.mkdir(exist_ok=True)
                (modules / 'value').write_text('original')
            cache.install(first, base / 'cache', 'build-one', 'main', 'node-test/npm-test', install)
            cache.install(second, base / 'cache', 'build-one', 'main', 'node-test/npm-test', install)
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(call[0][:3] == ['sfw', 'npm', 'ci'] and '--ignore-scripts' in call[0] for call in calls))
            (second / 'node_modules/value').write_text('local mutation')
            self.assertEqual((first / 'node_modules/value').read_text(), 'original')
            self.assertFalse((second / 'node_modules').is_symlink())
            third = self.fixture(base / 'c')
            cache.install(third, base / 'cache', 'build-one', 'main', 'node-test/npm-test', install)
            self.assertEqual((third / 'node_modules/value').read_text(), 'original')
            self.assertEqual(len(calls), 2)
            changed = self.fixture(base / 'changed', '{"changed":true}')
            cache.install(changed, base / 'cache', 'build-one', 'main', 'node-test/npm-test', install)
            self.assertEqual(len(calls), 4)
            self.assertNotEqual(calls[0][1], calls[-1][1])
            cache.install(self.fixture(base / 'runtime'), base / 'cache', 'build-one', 'main', 'other-runtime', install)
            cache.install(self.fixture(base / 'build'), base / 'cache', 'build-two', 'main', 'node-test/npm-test', install)
            cache.install(self.fixture(base / 'pr'), base / 'cache', 'build-one', 'pr', 'node-test/npm-test', install)
            self.assertEqual(len(calls), 10)

    def test_concurrent_jobs_publish_one_complete_install(self):
        """Why: agent-local concurrent jobs must wait on publication, not copy partial modules."""
        cache = self.load()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            roots = [self.fixture(base / str(i)) for i in range(3)]
            calls, errors = [], []
            def install(command, *, cwd, env, check):
                calls.append(command)
                modules = Path(cwd) / 'node_modules'
                modules.mkdir()
                (modules / 'complete').write_text('yes')
            def job(root):
                try:
                    cache.install(root, base / 'cache', 'one', 'pr', 'runtime', install)
                except Exception as error:
                    errors.append(error)
            threads = [threading.Thread(target=job, args=(root,)) for root in roots]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(errors, [])
            self.assertEqual(len(calls), 2)
            self.assertTrue(all((root / 'node_modules/complete').read_text() == 'yes' for root in roots))

    def test_nightly_full_pr_override_and_release_checklist_are_connected(self):
        """Why: affected-only PRs must not replace nightly or exact-release full proof."""
        declaration = ROOT / '.buildkite/nightly-schedule.json'
        self.assertTrue(declaration.is_file(), 'nightly Buildkite schedule declaration is required')
        schedule = json.loads(declaration.read_text())
        self.assertEqual(schedule['branch'], 'main')
        self.assertEqual(schedule['cronline'], '0 3 * * *')
        self.assertTrue(schedule['enabled'])
        pipeline = (ROOT / '.buildkite/pipeline.yml').read_text()
        self.assertIn('TEST_GATE_MUTATIONS=affected', pipeline)
        self.assertIn('BUILDKITE_SOURCE:-', pipeline)
        self.assertIn('!= schedule', pipeline)
        self.assertIn('BUILDKITE_TAG:-', pipeline)
        self.assertIn('TLC_REQUIRED=1 node scripts/model_negative_controls.mjs --run', pipeline)
        self.assertIn('      node scripts/node_test_home.mjs\n', pipeline)
        self.assertIn("runWithPrivateHome('npm',['test'])", (ROOT / 'scripts/node_test_home.mjs').read_text())
        checklist = (ROOT / 'docs/release-public.md').read_text()
        self.assertIn('Before **any release tag**', checklist)
        self.assertIn('TEST_GATE_MUTATIONS=all', checklist)
        self.assertIn('exact release candidate revision', checklist)

    def test_failed_install_is_not_published_or_reused(self):
        """Why: a failed npm invocation must not poison a later build-local restore."""
        cache = self.load()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = self.fixture(base / 'repo')
            def fail(command, **kwargs):
                raise subprocess.CalledProcessError(1, command)
            with self.assertRaises(subprocess.CalledProcessError):
                cache.install(root, base / 'cache', 'one', 'pr', 'runtime', fail)
            self.assertEqual(list((base / 'cache').rglob('complete.json')), [])


if __name__ == '__main__':
    unittest.main()
