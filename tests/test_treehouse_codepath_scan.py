import importlib.util
import pathlib
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts/treehouse_codepath_scan.py"
spec = importlib.util.spec_from_file_location("treehouse_codepath_scan", SOURCE)
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


class TreehouseCodepathScanTests(unittest.TestCase):
    def test_rejects_ad_hoc_checkout_creation(self):
        for command in ("git worktree add scratch/other", "git clone url scratch/other",
                        "git -C repo worktree add scratch/other", "scratch/corrections-treehouse"):
            with self.subTest(command=command):
                self.assertTrue(scan.violations("skills/example/SKILL.md", command))

    def test_allows_treehouse_and_historical_evidence(self):
        self.assertFalse(scan.violations("scripts/lease.sh", "treehouse get --lease --branch fix/x"))
        self.assertFalse(scan.violations("docs/internal/history.md", "git worktree add old"))


if __name__ == "__main__":
    unittest.main()
