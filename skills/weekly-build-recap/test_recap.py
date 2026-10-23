import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('recap', ROOT / 'recap.py')
recap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recap)


def fixture():
    return {'schema': recap.SCHEMA, 'account': 'example', 'since': '2026-10-16', 'until': '2026-10-22',
            'counts': {'commits': 2, 'default_commits': 1, 'prs_opened': 1, 'prs_merged': 1, 'repos': 1},
            'repos': [{'name': 'example/tool', 'url': 'https://github.com/example/tool',
                       'description': 'A command-line tool for preparing summaries.',
                       'landed': ['Add HTML export'], 'commits': 2, 'default_commits': 1,
                       'prs_opened': 1, 'prs_merged': 1}], 'method': 'Unique authored SHAs; PR dates UTC.'}


class RecapTests(unittest.TestCase):
    def test_schema_and_specificity(self):
        recap.validate(fixture())
        bad = fixture()
        bad['repos'][0]['landed'] = ['Various improvements']
        with self.assertRaisesRegex(ValueError, 'banned'):
            recap.validate(bad)
        bad['schema'] = 'unknown'
        with self.assertRaises(ValueError):
            recap.validate(bad)

    def test_local_banned_override(self):
        with tempfile.TemporaryDirectory() as folder:
            override = Path(folder) / 'banned.local.json'
            with patch.object(recap, 'BANNED_LOCAL', override):
                self.assertEqual(recap.banned_phrases(), recap.BANNED)
                override.write_text(json.dumps(['Private phrase']))
                self.assertIn('private phrase', recap.banned_phrases())
                bad = fixture()
                bad['repos'][0]['landed'] = ['A private phrase']
                with self.assertRaisesRegex(ValueError, 'banned'):
                    recap.validate(bad)
                override.write_text('{}')
                with self.assertRaisesRegex(ValueError, 'list'):
                    recap.banned_phrases()

    def test_post_limit(self):
        data = fixture()
        data['counts']['repos'] = 0
        data['repos'] = []
        base = len(recap.drafts(data)['x'])
        data['counts']['commits'] = int('9' * (280 - base + 1))
        self.assertEqual(len(recap.drafts(data)['x']), 280)
        data['counts']['commits'] = int('9' * (281 - base + 1))
        with self.assertRaisesRegex(ValueError, '280'):
            recap.drafts(data)

    def test_pr_search_bounded_and_read_only(self):
        seen = []
        def fake_api(path):
            seen.append(path)
            return {'total_count': 1, 'items': [{'title': 'Add export', 'repository_url': 'https://api.github.com/repos/example/tool'}]}
        with patch.object(recap, 'api', side_effect=fake_api):
            self.assertEqual(len(recap.search_prs('example', 'merged', '2026-10-16', '2026-10-22')), 1)
        self.assertIn('merged%3A2026-10-16..2026-10-22', seen[0])
        self.assertIn('is%3Amerged', seen[0])
        self.assertNotIn('-X', seen[0])

    def test_shorten_does_not_cut_words(self):
        self.assertEqual(recap.shorten('A meaningful description', 15), 'A meaningful…')

    def test_readme(self):
        self.assertEqual(recap.meaningful_readme('# Tool\n\nA useful package that exports data into readable files.\n', ''),
                         'A useful package that exports data into readable files.')

    def test_palette_exact(self):
        palette = json.loads((ROOT / 'config.json').read_text())['palettes']['flockmate']
        self.assertEqual(palette['accents'], dict(zip(('sage', 'rust', 'peach', 'mustard', 'slate_blue', 'mauve_burgundy', 'muted_olive', 'deep_teal', 'ochre', 'forest', 'clay'),
            ('#79c39e', '#e77843', '#ee9b69', '#ceb05e', '#617082', '#76536b', '#6e7354', '#3f6f70', '#a77c2e', '#52705f', '#9c5f45'))))
        self.assertEqual(palette['chrome'], ['#1a1816', '#383431', '#4a4540', '#5c564f', '#b09080', '#ead1b5'])
        self.assertEqual(palette['headline'], ['rust', 'sage', 'peach'])
        config = json.loads((ROOT / 'config.json').read_text())
        self.assertEqual(config['default_palette'], 'neutral')
        self.assertEqual(config['palettes']['neutral']['headline'], ['slate', 'sage', 'clay'])

    def test_draft_render_and_no_write_calls(self):
        for path in (ROOT / 'recap.py', ROOT / 'render.py'):
            source = path.read_text().lower()
            for forbidden in ('gh pr create', 'gh api -x post', 'requests.post(', 'urllib.request.request(', 'gh issue comment', 'gh pr ready'):
                self.assertNotIn(forbidden, source)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'fixture.json').write_text(json.dumps(fixture()))
            subprocess.run(['python3', str(ROOT / 'recap.py'), '--stats-input', str(root / 'fixture.json'),
                            '--output', str(root / 'out')], check=True, capture_output=True)
            png = (root / 'out/recap.png').read_bytes()
            self.assertEqual(struct.unpack('>II', png[16:24]), (1600, 900))
            self.assertGreater(len(png), 10000)
            highlights = json.loads((root / 'out/highlights.json').read_text())
            self.assertEqual(highlights['schema'], recap.HIGHLIGHTS_SCHEMA)
            self.assertIn('Add HTML export', highlights['lines'][0])
            self.assertIn('Unique authored SHAs', json.loads((root / 'out/stats.json').read_text())['method'])
            self.assertLessEqual(len((root / 'out/x.txt').read_text().rstrip('\n')), 280)


if __name__ == '__main__':
    unittest.main()
