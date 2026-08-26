"""The release gate.

Warm-starting compounds improvements, which is the point — and compounds
regressions, which is the risk. These tests are the rules for what is allowed
to become the next epoch's starting point.

    python3 -m unittest discover -s model/tests
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from suwa_lm.train_lora import gate


class TestGate(unittest.TestCase):
    def test_a_better_epoch_is_released(self):
        ok, why = gate(0.80, {"epoch": 1, "score": 0.70, "eval_version": 2}, 2, 0.0)
        self.assertTrue(ok)
        self.assertIn("holds", why)

    def test_an_equal_epoch_is_released(self):
        ok, _ = gate(0.70, {"epoch": 1, "score": 0.70, "eval_version": 2}, 2, 0.0)
        self.assertTrue(ok, "flat is not a regression; training is allowed to plateau")

    def test_a_worse_epoch_is_refused(self):
        ok, why = gate(0.60, {"epoch": 3, "score": 0.70, "eval_version": 2}, 2, 0.0)
        self.assertFalse(ok)
        self.assertIn("below parent epoch 3", why)

    def test_the_first_epoch_has_nothing_to_beat(self):
        ok, why = gate(0.10, None, 2, 0.0)
        self.assertTrue(ok)
        self.assertIn("no parent", why)

    def test_scores_from_a_different_eval_version_are_not_a_baseline(self):
        # v1 scored single replies only, so its numbers run high. Gating a v2
        # score against one would reject every good epoch after a scoring change.
        ok, why = gate(0.44, {"epoch": 1, "score": 0.875, "eval_version": 1}, 2, 0.0)
        self.assertTrue(ok)
        self.assertIn("not comparable", why)

    def test_a_parent_predating_versioning_is_treated_as_v1(self):
        ok, _ = gate(0.44, {"epoch": 1, "score": 0.875}, 2, 0.0)
        self.assertTrue(ok, "an unversioned manifest is v1 by definition, not a baseline for v2")

    def test_a_parent_without_a_score_cannot_gate_anything(self):
        ok, why = gate(0.5, {"epoch": 1, "eval_version": 2}, 2, 0.0)
        self.assertTrue(ok)
        self.assertIn("no score", why)

    def test_tolerance_allows_a_declared_amount_of_slippage(self):
        parent = {"epoch": 2, "score": 0.70, "eval_version": 2}
        self.assertTrue(gate(0.69, parent, 2, 0.02)[0], "inside the declared tolerance")
        self.assertFalse(gate(0.67, parent, 2, 0.02)[0], "beyond it")

    def test_the_default_tolerance_refuses_any_drop(self):
        parent = {"epoch": 2, "score": 0.70, "eval_version": 2}
        self.assertFalse(gate(0.6999, parent, 2, 0.0)[0],
                         "the eval is deterministic, so a drop is a real drop")


if __name__ == "__main__":
    unittest.main()
