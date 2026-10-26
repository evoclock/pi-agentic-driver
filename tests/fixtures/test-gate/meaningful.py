import unittest

from app import value


class BehaviorTest(unittest.TestCase):
    def test_value_matches_new_contract(self):
        """Why: this expected value differs from base and detects a real regression."""
        self.assertEqual(value(), 2)
