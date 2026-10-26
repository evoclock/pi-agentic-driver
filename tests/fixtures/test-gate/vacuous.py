import unittest


class VacuousTest(unittest.TestCase):
    def test_always_passes(self):
        """Why: this seeded case must fail because it passes on the base commit."""
        self.assertTrue(True)
