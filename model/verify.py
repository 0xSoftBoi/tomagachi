"""Verify a released checkpoint against what the chain recorded.

    python3 verify.py path/to/checkpoint.pt [expected_hash]

With no expected hash it just prints the canonical hash, which you can compare
against `latestModel()` (or any `releases(i)`) on the Tomagachi contract.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from suwa_wm.canonical import hash_checkpoint


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    actual = hash_checkpoint(sys.argv[1])
    print(f"canonical weights hash: 0x{actual}")
    if len(sys.argv) > 2:
        expected = sys.argv[2].lower().removeprefix("0x")
        if actual == expected:
            print("MATCH — these weights are exactly what the chain attests to.")
            return 0
        print(f"MISMATCH — chain says 0x{expected}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
