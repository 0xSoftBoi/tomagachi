"""Turning captured traffic into something worth training on.

Raw traffic is not a dataset. Most of it is short, repetitive, or the model
having a bad turn — and warm-starting means anything that gets in compounds.
A fleet trained on its own worst output gets worse in a way that is slow to
notice and expensive to undo.

So this is a gate, not a converter. It reads the gitignored captures the shop
writes, drops what should not be learned from, and writes what survives into
the curated `model/data/<character>.jsonl` the trainer actually reads.

    python3 suwa_lm/review.py --character suwa-tide
    python3 suwa_lm/review.py --character suwa-tide --dry-run

Every rejection is counted and reported by reason. A run that keeps 3 of 400
is telling you something about the adapter, and silently writing three rows
would hide it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from suwa_lm import catalog as catalog_mod
from suwa_lm.catalog import Character

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
CAPTURED_DIR = DATA_DIR / "captured"

# A reply this short is an acknowledgement, not a demonstration of character.
MIN_REPLY_CHARS = 40
MAX_REPLY_CHARS = 4_000
# Past this share of redaction placeholders there is little language left.
MAX_REDACTION_RATIO = 0.25

_REDACTION = re.compile(r"\[(?:email|number|phone|secret|address|url)\]")
_WHITESPACE = re.compile(r"\s+")


def normalise(text: str) -> str:
    """For duplicate detection: case and spacing are not what makes a row novel."""
    return _WHITESPACE.sub(" ", text.strip().lower())


def redaction_ratio(text: str) -> float:
    if not text:
        return 1.0
    redacted = sum(len(m.group()) for m in _REDACTION.finditer(text))
    return redacted / len(text)


def judge(row: dict, character: Character, seen: set[str]) -> str | None:
    """Return a rejection reason, or None to keep the row."""
    messages = row.get("messages") or []
    turns = [m for m in messages if m.get("role") != "system"]
    if len(turns) < 2:
        return "no exchange"

    reply = turns[-1]
    if reply.get("role") != "assistant":
        return "no assistant reply"
    text = (reply.get("content") or "").strip()
    prompt_text = " ".join((m.get("content") or "") for m in turns[:-1]).strip()

    if not prompt_text:
        return "empty prompt"
    if len(text) < MIN_REPLY_CHARS:
        return "reply too short"
    if len(text) > MAX_REPLY_CHARS:
        return "reply too long"

    low = text.lower()
    # The one rejection that matters most: never teach a character to break.
    if any(marker.lower() in low for marker in character.out_of_character):
        return "broke character"
    if redaction_ratio(text) > MAX_REDACTION_RATIO:
        return "mostly redacted"

    key = normalise(prompt_text) + "\x00" + normalise(text)
    if key in seen:
        return "duplicate"
    seen.add(key)
    return None


def load_captures(character_id: str, path: Path | None = None) -> list[dict]:
    src = path or CAPTURED_DIR / f"{character_id}.jsonl"
    if not src.exists():
        return []
    rows = []
    for line in src.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a torn final line after a hard kill is not a crash
    return rows


def review(rows: list[dict], character: Character, limit: int | None = None
           ) -> tuple[list[dict], Counter]:
    """Keep what is worth learning from, newest first, and say why the rest went."""
    rejected: Counter = Counter()
    kept: list[dict] = []
    seen: set[str] = set()

    # Newest first: a character improves over time, so recent replies are the
    # better teacher, and the limit should cut the oldest rather than the newest.
    for row in sorted(rows, key=lambda r: r.get("at", ""), reverse=True):
        reason = judge(row, character, seen)
        if reason:
            rejected[reason] += 1
            continue
        turns = [m for m in row["messages"] if m.get("role") != "system"]
        # The curated format carries the persona, because that is what the model
        # is being taught to answer as.
        kept.append({"messages": [{"role": "system", "content": character.system}, *turns]})
        if limit and len(kept) >= limit:
            break
    return kept, rejected


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    ap.add_argument("--limit", type=int, default=None, help="keep at most this many, newest first")
    ap.add_argument("--captured", type=str, default=None, help="override the capture file")
    ap.add_argument("--out", type=str, default=None, help="override the curated file")
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args()

    cat = catalog_mod.load()
    character = cat.get(args.character)

    rows = load_captures(character.id, Path(args.captured) if args.captured else None)
    if not rows:
        raise SystemExit(
            f"no captures for {character.id} — is CAPTURE_TRANSCRIPTS=1 on the shop?"
        )

    kept, rejected = review(rows, character, args.limit)

    print(f"{character.id}: read {len(rows)}, kept {len(kept)}")
    for reason, count in rejected.most_common():
        print(f"  dropped {count:5d}  {reason}")

    if not kept:
        raise SystemExit("nothing survived review — not writing an empty training set")

    if args.dry_run:
        print("(dry run — nothing written)")
        return

    out = Path(args.out) if args.out else DATA_DIR / f"{character.id}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as fh:
        for row in kept:
            fh.write(json.dumps(row) + "\n")
    print(f"wrote {len(kept)} rows -> {out}")
    print(f"the trainer will now report data_source=collected for {character.id}")


if __name__ == "__main__":
    main()
