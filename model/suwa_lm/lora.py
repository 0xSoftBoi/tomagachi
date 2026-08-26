"""LoRA in plain torch, plus a tiny local backbone so the loop runs anywhere.

Two backbones, one interface:

  * **hosted** — a real causal LM through `transformers`, which is what ships.
    `characters.json` names the base; adapters are trained against it frozen.
  * **tiny** — a small byte-level transformer defined here, trained from
    scratch on CPU in a couple of minutes with nothing to download.

The tiny path exists for the same reason the Reef did: the creature's economy
has to close end-to-end — train, score, hash, post on-chain, serve — before any
of it is worth spending real GPU money on. Same artifact format either way, so
the brain cannot tell them apart and neither can the contract.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

# Where pretrain_tiny.py leaves the shared backbone the adapters sit on.
TINY_BASE_PATH = Path(__file__).resolve().parents[2] / "runs" / "tiny-base.pt"

# Byte-level vocabulary: 256 raw bytes plus two control ids. No tokenizer file,
# no download, and every string round-trips exactly.
BOS, EOS, VOCAB = 256, 257, 258


class ByteTokenizer:
    """Bytes in, bytes out. Deterministic, which the eval score depends on."""

    vocab_size = VOCAB
    eos_id = EOS

    def encode(self, text: str, bos: bool = False) -> list[int]:
        ids = list(text.encode("utf-8"))
        return [BOS] + ids if bos else ids

    def decode(self, ids: list[int]) -> str:
        raw = bytes(i for i in ids if i < 256)
        return raw.decode("utf-8", errors="replace")


class Block(nn.Module):
    def __init__(self, dim: int, heads: int):
        super().__init__()
        self.heads = heads
        self.norm1 = nn.LayerNorm(dim)
        self.norm2 = nn.LayerNorm(dim)
        # Separate projections rather than one fused qkv: LoRA targets q and v
        # by name, and fusing them would force adapting k as well.
        self.q_proj = nn.Linear(dim, dim, bias=False)
        self.k_proj = nn.Linear(dim, dim, bias=False)
        self.v_proj = nn.Linear(dim, dim, bias=False)
        self.o_proj = nn.Linear(dim, dim, bias=False)
        self.mlp = nn.Sequential(
            nn.Linear(dim, 4 * dim), nn.GELU(), nn.Linear(4 * dim, dim)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, t, d = x.shape
        h = self.norm1(x)
        q, k, v = self.q_proj(h), self.k_proj(h), self.v_proj(h)
        shape = (b, t, self.heads, d // self.heads)
        q, k, v = (z.view(shape).transpose(1, 2) for z in (q, k, v))
        att = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        x = x + self.o_proj(att.transpose(1, 2).reshape(b, t, d))
        return x + self.mlp(self.norm2(x))


class TinyLM(nn.Module):
    def __init__(self, dim: int = 192, layers: int = 4, heads: int = 4, ctx: int = 512):
        super().__init__()
        self.ctx = ctx
        self.embed = nn.Embedding(VOCAB, dim)
        self.pos = nn.Embedding(ctx, dim)
        self.blocks = nn.ModuleList(Block(dim, heads) for _ in range(layers))
        self.norm = nn.LayerNorm(dim)
        self.head = nn.Linear(dim, VOCAB, bias=False)

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        t = input_ids.shape[1]
        pos = torch.arange(t, device=input_ids.device)
        x = self.embed(input_ids) + self.pos(pos)[None]
        for blk in self.blocks:
            x = blk(x)
        return self.head(self.norm(x))


class LoRALinear(nn.Module):
    """y = Wx + (alpha/r) * B(A(x)), with W frozen.

    B starts at zero, so an untrained adapter is exactly the base model -- the
    first training step can only improve on the thing we already had.
    """

    def __init__(self, base: nn.Linear, r: int, alpha: float):
        super().__init__()
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)
        self.a = nn.Linear(base.in_features, r, bias=False)
        self.b = nn.Linear(r, base.out_features, bias=False)
        nn.init.kaiming_uniform_(self.a.weight, a=math.sqrt(5))
        nn.init.zeros_(self.b.weight)
        self.scale = alpha / r

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.base(x) + self.b(self.a(x)) * self.scale


DEFAULT_TARGETS = ("q_proj", "v_proj")


def apply_lora(
    model: nn.Module,
    targets: tuple[str, ...] = DEFAULT_TARGETS,
    r: int = 8,
    alpha: float = 16.0,
) -> int:
    """Freeze the model and wrap every matching nn.Linear. Returns trainable count."""
    for p in model.parameters():
        p.requires_grad_(False)

    replaced = 0
    for parent in model.modules():
        for name, child in list(parent.named_children()):
            if isinstance(child, nn.Linear) and any(t in name for t in targets):
                setattr(parent, name, LoRALinear(child, r, alpha))
                replaced += 1
    if replaced == 0:
        raise ValueError(f"no Linear layers matched {targets}")
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def adapter_state_dict(model: nn.Module) -> dict[str, torch.Tensor]:
    """Only the LoRA weights. This is the artifact -- kilobytes, not gigabytes."""
    return {
        k: v.detach().cpu()
        for k, v in model.state_dict().items()
        if ".a.weight" in k or ".b.weight" in k
    }


def load_adapter(model: nn.Module, state: dict[str, torch.Tensor]) -> None:
    missing = model.load_state_dict(state, strict=False)
    unexpected = getattr(missing, "unexpected_keys", [])
    if unexpected:
        raise ValueError(f"adapter has weights this model has no slot for: {unexpected[:3]}")


@dataclass
class Backbone:
    name: str
    model: nn.Module
    tokenizer: object
    kind: str  # "tiny" | "hosted"

    def logits(self, input_ids: torch.Tensor) -> torch.Tensor:
        out = self.model(input_ids)
        return out if isinstance(out, torch.Tensor) else out.logits


def load_base(base_id: str, tiny: bool = False, device: torch.device | None = None) -> Backbone:
    """Real base when transformers is installed and `tiny` is off; TinyLM otherwise."""
    device = device or torch.device("cpu")
    if not tiny:
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer

            tok = AutoTokenizer.from_pretrained(base_id)
            model = AutoModelForCausalLM.from_pretrained(
                base_id, torch_dtype=torch.bfloat16 if device.type == "cuda" else torch.float32
            ).to(device)
            return Backbone(name=base_id, model=model, tokenizer=tok, kind="hosted")
        except ImportError:
            print("[suwa-lm] transformers not installed -- falling back to the tiny backbone")
        except Exception as e:  # missing weights, no network, gated repo
            print(f"[suwa-lm] could not load {base_id} ({e}) -- falling back to the tiny backbone")

    model = TinyLM().to(device)
    if TINY_BASE_PATH.exists():
        state = torch.load(TINY_BASE_PATH, map_location=device, weights_only=True)
        model.load_state_dict(state["model"])
        print(f"[suwa-lm] shared tiny base loaded from {TINY_BASE_PATH}")
    else:
        print(
            "[suwa-lm] no shared tiny base yet -- run `python3 suwa_lm/pretrain_tiny.py` first, "
            "or this adapter has nothing to steer"
        )
    return Backbone(name="suwa-tiny-v0", model=model, tokenizer=ByteTokenizer(), kind="tiny")


@torch.no_grad()
def greedy(backbone: Backbone, prompt: str, max_new_tokens: int = 48) -> str:
    """Deterministic decode. The eval score has to be reproducible by anyone."""
    tok = backbone.tokenizer
    device = next(backbone.model.parameters()).device
    backbone.model.eval()

    if backbone.kind == "hosted":
        ids = tok(prompt, return_tensors="pt").to(device)
        out = backbone.model.generate(**ids, max_new_tokens=max_new_tokens, do_sample=False)
        return tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)

    ctx = getattr(backbone.model, "ctx", 512)
    ids = tok.encode(prompt, bos=True)[-ctx:]
    generated: list[int] = []
    for _ in range(max_new_tokens):
        x = torch.tensor([ids[-ctx:]], device=device)
        nxt = int(backbone.logits(x)[0, -1].argmax())
        if nxt == tok.eos_id:
            break
        ids.append(nxt)
        generated.append(nxt)
    return tok.decode(generated)
