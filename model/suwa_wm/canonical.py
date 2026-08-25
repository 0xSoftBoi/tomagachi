"""Canonical weight hashing.

The hash that goes on-chain must be reproducible by anyone who re-runs the
same seeded job — otherwise the challenge mechanism has no teeth. Hashing the
`.pt` file itself is too brittle: archive containers, compression, and pickle
protocol details can all differ between machines and torch versions.

Instead we hash the *tensors*, canonically: every parameter in sorted key
order, each contributing its name, dtype, shape, and raw little-endian bytes.
Two runs that produce identical weights produce an identical hash on any
machine, whatever the container looks like.
"""

from __future__ import annotations

import hashlib
from typing import Mapping

import torch


def canonical_hash(state: Mapping[str, torch.Tensor]) -> str:
    """sha256 over a canonical encoding of a model state dict."""
    h = hashlib.sha256()
    for key in sorted(state.keys()):
        t = state[key].detach().to("cpu").contiguous()
        h.update(key.encode("utf-8"))
        h.update(b"\x00")
        h.update(str(t.dtype).encode("utf-8"))
        h.update(b"\x00")
        h.update(",".join(str(d) for d in t.shape).encode("utf-8"))
        h.update(b"\x00")
        h.update(t.numpy().tobytes(order="C"))
        h.update(b"\xff")
    return h.hexdigest()


def hash_checkpoint(path: str) -> str:
    """Recompute the on-chain hash from a released checkpoint file."""
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    state = ckpt["model"] if "model" in ckpt else ckpt
    return canonical_hash(state)
