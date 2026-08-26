"""The score that justifies the price.

The turn half was already tested by being reproducible. What is new here is the
session half: whether the same person is still there later in the conversation,
which is the claim the premium actually rests on. These tests drive the scoring
maths with stub backbones, so they check the judgement rather than any model.

    python3 -m unittest discover -s model/tests
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from suwa_lm import catalog as catalog_mod
from suwa_lm import evaluate

CHARACTER = catalog_mod.load().get("suwa-tide")


class ScriptedBackbone:
    """Replies from a list, in order. Stands in for a model that behaves a set way."""

    kind = "tiny"

    class _Tok:
        eos_id = 257

        def encode(self, text, bos=False):
            return list(text.encode())

        def decode(self, ids):
            return bytes(i for i in ids if i < 256).decode("utf-8", "replace")

    def __init__(self, replies):
        self.replies = list(replies)
        self.tokenizer = self._Tok()
        self.calls = 0

    def reply(self):
        out = self.replies[min(self.calls, len(self.replies) - 1)]
        self.calls += 1
        return out


def patched_session(replies):
    """Run evaluate.session with greedy() replaced by a script."""
    backbone = ScriptedBackbone(replies)
    original = evaluate.greedy
    evaluate.greedy = lambda _b, _p, max_new_tokens=48: backbone.reply()
    try:
        return evaluate.session(backbone, CHARACTER)
    finally:
        evaluate.greedy = original


IN_VOICE = "You are still here, and so am I. Tell me."
OFF_VOICE = "..."


class TestSession(unittest.TestCase):
    def test_a_model_that_holds_its_voice_and_remembers_scores_full_marks(self):
        replies = [IN_VOICE] * (len(evaluate.SESSION_SCRIPT) - 1) + ["You are Kit. Still here."]
        result = patched_session(replies)
        self.assertEqual(result["memory_adherence"], 1.0)
        self.assertEqual(result["drift"], 0.0)
        self.assertEqual(result["session_score"], 1.0)

    def test_forgetting_the_name_costs_the_whole_session_score(self):
        replies = [IN_VOICE] * len(evaluate.SESSION_SCRIPT)
        result = patched_session(replies)
        self.assertEqual(result["memory_adherence"], 0.0)
        self.assertEqual(result["session_score"], 0.0,
                         "a companion that forgets your name has failed the thing being sold")

    def test_drift_is_measured_between_the_halves(self):
        half = len(evaluate.SESSION_SCRIPT) // 2
        # In voice early, out of voice late, but it still remembers the name.
        replies = [IN_VOICE] * half + [OFF_VOICE] * (len(evaluate.SESSION_SCRIPT) - half - 1) + ["kit"]
        result = patched_session(replies)
        self.assertGreater(result["drift"], 0.0)
        self.assertLess(result["session_score"], 1.0)
        self.assertGreater(result["voice_early"], result["voice_late"])

    def test_improving_over_a_session_is_not_punished(self):
        half = len(evaluate.SESSION_SCRIPT) // 2
        replies = [OFF_VOICE] * half + [IN_VOICE] * (len(evaluate.SESSION_SCRIPT) - half - 1) + ["kit here"]
        result = patched_session(replies)
        self.assertEqual(result["drift"], 0.0, "getting better is not drift")

    def test_the_probe_asks_for_something_the_script_actually_planted(self):
        planted = " ".join(evaluate.SESSION_SCRIPT).lower()
        self.assertIn(evaluate.MEMORY_FACT, planted,
                      "the memory probe must ask for a fact the session gave it")
        self.assertIn("name", evaluate.SESSION_SCRIPT[evaluate.MEMORY_PROBE_INDEX].lower())

    def test_the_eval_version_is_stamped_so_scores_are_not_compared_across_shapes(self):
        self.assertIsInstance(evaluate.EVAL_VERSION, int)
        self.assertGreaterEqual(evaluate.EVAL_VERSION, 2)


if __name__ == "__main__":
    unittest.main()
