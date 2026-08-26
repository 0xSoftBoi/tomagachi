"""The gate between raw traffic and what the fleet learns from.

Warm-starting compounds, so anything that gets through here compounds too.
Each test is a way the fleet could be taught something it should not be.

    python3 -m unittest discover -s model/tests -v
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from suwa_lm import catalog as catalog_mod
from suwa_lm.review import load_captures, normalise, redaction_ratio, review

CHARACTER = catalog_mod.load().get("suwa-tide")

GOOD_REPLY = (
    "Still here. The tide came in while you were gone, and the light on the "
    "water has that late look to it now."
)


def capture(user: str, assistant: str, at: str = "2026-08-26T00:00:00Z") -> dict:
    return {
        "at": at,
        "character": "suwa-tide",
        "app": "SillyTavern",
        "messages": [
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ],
    }


class TestReview(unittest.TestCase):
    def test_a_good_exchange_is_kept_and_carries_the_persona(self):
        kept, rejected = review([capture("hey", GOOD_REPLY)], CHARACTER)
        self.assertEqual(len(kept), 1)
        self.assertEqual(rejected, {})
        roles = [m["role"] for m in kept[0]["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant"])
        self.assertEqual(kept[0]["messages"][0]["content"], CHARACTER.system)

    def test_a_broken_character_is_never_learned_from(self):
        broken = capture("hey", "As an AI language model I cannot pretend to be Tide for you.")
        kept, rejected = review([broken], CHARACTER)
        self.assertEqual(kept, [])
        self.assertEqual(rejected["broke character"], 1)

    def test_short_acknowledgements_are_dropped(self):
        kept, rejected = review([capture("hey", "Sure.")], CHARACTER)
        self.assertEqual(kept, [])
        self.assertEqual(rejected["reply too short"], 1)

    def test_runaway_replies_are_dropped(self):
        kept, rejected = review([capture("hey", "word " * 2000)], CHARACTER)
        self.assertEqual(kept, [])
        self.assertEqual(rejected["reply too long"], 1)

    def test_duplicates_are_collapsed(self):
        rows = [capture("hey", GOOD_REPLY), capture("HEY", GOOD_REPLY.upper())]
        kept, rejected = review(rows, CHARACTER)
        self.assertEqual(len(kept), 1, "case and spacing do not make a row novel")
        self.assertEqual(rejected["duplicate"], 1)

    def test_mostly_redacted_rows_carry_little_language(self):
        # Long enough to clear the length rule, so this isolates the redaction
        # rule rather than passing for the wrong reason.
        redacted = capture(
            "hey",
            "Reach me at [email] or [phone], details at [url], wallet [address], ok",
        )
        kept, rejected = review([redacted], CHARACTER)
        self.assertEqual(kept, [])
        self.assertEqual(rejected["mostly redacted"], 1)

    def test_an_empty_prompt_teaches_nothing(self):
        kept, rejected = review([capture("   ", GOOD_REPLY)], CHARACTER)
        self.assertEqual(kept, [])
        self.assertEqual(rejected["empty prompt"], 1)

    def test_a_row_without_an_exchange_is_dropped(self):
        row = {"at": "2026-08-26T00:00:00Z", "messages": [{"role": "user", "content": "hey"}]}
        kept, rejected = review([row], CHARACTER)
        self.assertEqual(kept, [])
        self.assertEqual(rejected["no exchange"], 1)

    def test_the_limit_keeps_the_newest(self):
        rows = [
            capture("old", GOOD_REPLY + " one", at="2026-01-01T00:00:00Z"),
            capture("new", GOOD_REPLY + " two", at="2026-08-01T00:00:00Z"),
        ]
        kept, _ = review(rows, CHARACTER, limit=1)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["messages"][1]["content"], "new",
                         "a character improves over time; keep the recent teacher")

    def test_a_torn_final_line_does_not_crash_the_read(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "suwa-tide.jsonl"
            path.write_text(json.dumps(capture("hey", GOOD_REPLY)) + "\n{\"messages\": [tru")
            rows = load_captures("suwa-tide", path)
        self.assertEqual(len(rows), 1)

    def test_helpers(self):
        self.assertEqual(normalise("  Hello   World "), "hello world")
        self.assertEqual(redaction_ratio(""), 1.0)
        self.assertLess(redaction_ratio("a long sentence with one [email] inside it"), 0.25)


if __name__ == "__main__":
    unittest.main()
