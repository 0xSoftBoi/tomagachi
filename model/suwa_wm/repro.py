"""Reproducibility contract.

The on-chain challenge mechanism only has teeth if two honest workers who run
the same seeded job produce the same weights. Everything that could introduce
nondeterminism is pinned here, in one place.
"""

from __future__ import annotations

import os
import random

import numpy as np
import torch


def pin_determinism(seed: int) -> None:
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    os.environ.setdefault("PYTHONHASHSEED", str(seed))
    # Thread scheduling reorders float reductions; one thread removes that.
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(seed)
    random.seed(seed)
    np.random.seed(seed % (2**32))


def seed_from_hex(seed_hex: str) -> int:
    """Turn the contract's 32-byte job seed into a usable integer seed."""
    return int(seed_hex.lower().removeprefix("0x"), 16) % (2**31 - 1)
