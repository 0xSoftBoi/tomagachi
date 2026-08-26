"""SUWA-WM — a world model of the on-chain market.

Not an LLM. It never sees text. It watches the joint state of every asset
Suwappu routes through and learns how that state evolves.

    AssetEncoder     per-asset temporal features -> embedding
    CrossAssetBlock  assets attend to each other (BTC moving is context for SOL)
    Predictor        JEPA head: predict the EMBEDDING of the future, not prices
    ExecutionHeads   forward drift and forward volatility, with calibrated sigma

The pretraining objective is joint-embedding predictive (JEPA): encode a
context window, predict the representation of the window that follows, against
an EMA target encoder. Nothing is reconstructed — predicting raw prices would
force the model to waste capacity on unpredictable noise, which is exactly the
failure mode in a market.
"""

from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

D_MODEL = 96
N_HEADS = 4


class AssetEncoder(nn.Module):
    """Per-asset temporal encoder. Shared weights across assets, so the model
    learns market dynamics rather than memorising individual tickers."""

    def __init__(self, n_features: int, d_model: int = D_MODEL):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv1d(n_features, 64, kernel_size=5, padding=2), nn.SiLU(),
            nn.Conv1d(64, 96, kernel_size=5, stride=2, padding=2), nn.SiLU(),
            nn.Conv1d(96, d_model, kernel_size=3, stride=2, padding=1), nn.SiLU(),
        )
        self.norm = nn.LayerNorm(d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: [B, A, T, F] -> [B, A, D]"""
        B, A, T, Fdim = x.shape
        h = x.permute(0, 1, 3, 2).reshape(B * A, Fdim, T)
        h = self.net(h)             # [B*A, D, T']
        h = h.mean(dim=-1)          # temporal pool
        return self.norm(h).view(B, A, -1)


class CrossAssetBlock(nn.Module):
    """Assets attend to each other: this is what makes it a *market* model
    rather than N independent single-asset models."""

    def __init__(self, d_model: int = D_MODEL, n_heads: int = N_HEADS):
        super().__init__()
        self.attn = nn.MultiheadAttention(d_model, n_heads, batch_first=True)
        self.n1 = nn.LayerNorm(d_model)
        self.n2 = nn.LayerNorm(d_model)
        self.ff = nn.Sequential(
            nn.Linear(d_model, d_model * 2), nn.SiLU(), nn.Linear(d_model * 2, d_model)
        )

    def forward(self, z: torch.Tensor) -> torch.Tensor:
        h = self.n1(z)
        a, _ = self.attn(h, h, h, need_weights=False)
        z = z + a
        return z + self.ff(self.n2(z))


class SuwaWM(nn.Module):
    def __init__(self, n_assets: int, n_features: int, d_model: int = D_MODEL, depth: int = 2):
        super().__init__()
        self.n_assets = n_assets
        self.encoder = AssetEncoder(n_features, d_model)
        # Learned identity per slot, so the model can tell BTC from a small cap.
        self.asset_embed = nn.Parameter(torch.zeros(1, n_assets, d_model))
        nn.init.normal_(self.asset_embed, std=0.02)
        self.blocks = nn.ModuleList([CrossAssetBlock(d_model) for _ in range(depth)])
        self.out = nn.LayerNorm(d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: [B, A, T, F] -> per-asset context embeddings [B, A, D]"""
        z = self.encoder(x) + self.asset_embed
        for blk in self.blocks:
            z = blk(z)
        return self.out(z)

    def market_state(self, x: torch.Tensor) -> torch.Tensor:
        """A single vector summarising the whole market. [B, D]"""
        return self.forward(x).mean(dim=1)


class Predictor(nn.Module):
    """JEPA predictor: given where the market is, predict where its
    representation will be `horizon` hours from now."""

    def __init__(self, d_model: int = D_MODEL):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(d_model + 1, d_model * 2), nn.SiLU(),
            nn.Linear(d_model * 2, d_model * 2), nn.SiLU(),
            nn.Linear(d_model * 2, d_model),
        )

    def forward(self, z: torch.Tensor, horizon: float) -> torch.Tensor:
        h = torch.full_like(z[..., :1], horizon)
        return self.net(torch.cat([z, h], dim=-1))


def vicreg_terms(z: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Variance and covariance regularisers — without these a JEPA collapses
    to a constant, which would trivially satisfy the prediction loss."""
    z = z.reshape(-1, z.shape[-1])
    z = z - z.mean(dim=0, keepdim=True)
    std = torch.sqrt(z.var(dim=0) + 1e-6)
    var_loss = F.relu(1.0 - std).mean()
    n, d = z.shape
    cov = (z.T @ z) / max(n - 1, 1)
    off = cov - torch.diag_embed(torch.diagonal(cov))
    cov_loss = (off**2).sum() / d
    return var_loss, cov_loss


class ExecutionHeads(nn.Module):
    """What the creature is actually for.

    Given the market's current state, predict the distribution of each asset's
    next-H-hour log return: mu (drift) and sigma (risk). Execution decisions —
    route now or wait, how much slippage to tolerate — are read off that.

    sigma is *anchored* to the naive forecast (trailing realised vol scaled to
    the horizon) and the model predicts a bounded multiplicative correction.
    Learning vol from scratch would mean relearning what the baseline already
    knows; this way the model's whole job is to improve on it, and it starts
    level with the benchmark instead of below it.
    """

    def __init__(self, d_model: int = D_MODEL, n_scales: int = 8, max_log_adjust: float = 1.5):
        super().__init__()
        self.max_log_adjust = max_log_adjust
        self.n_scales = n_scales
        # The head sees the market embedding AND every trailing vol scale.
        self.trunk = nn.Sequential(nn.Linear(d_model + n_scales, d_model), nn.SiLU())
        self.mu = nn.Linear(d_model, 1)
        self.delta = nn.Linear(d_model, 1)
        # A learned blend of the scales forms the anchor the correction adjusts,
        # i.e. the model discovers its own HAR mix rather than being given one.
        self.blend = nn.Parameter(torch.zeros(n_scales))

    def forward(
        self, z: torch.Tensor, log_scales: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """log_scales: [B, A, S] log trailing vol at each look-back."""
        h = self.trunk(torch.cat([z, log_scales], dim=-1))
        mu = self.mu(h).squeeze(-1)
        weights = torch.softmax(self.blend, dim=0)
        anchor = (log_scales * weights).sum(dim=-1)
        # Bounded correction: at most e^1.5 either way, so a bad batch can
        # never produce a degenerate sigma.
        adjust = torch.tanh(self.delta(h).squeeze(-1)) * self.max_log_adjust
        return mu, (anchor + adjust).clamp(-9.0, 2.0)


class SuwaExecutionModel(nn.Module):
    """Pretrained world model + execution heads. This is what ships."""

    def __init__(self, n_assets: int, n_features: int, d_model: int = D_MODEL,
                 depth: int = 2, n_scales: int = 8):
        super().__init__()
        self.backbone = SuwaWM(n_assets, n_features, d_model, depth)
        self.heads = ExecutionHeads(d_model, n_scales)

    def forward(
        self, x: torch.Tensor, log_scales: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        return self.heads(self.backbone(x), log_scales)


def gaussian_nll(mu: torch.Tensor, log_sigma: torch.Tensor, y: torch.Tensor) -> torch.Tensor:
    """Negative log likelihood of y under N(mu, sigma). Training sigma this way
    is what makes the uncertainty calibrated rather than decorative."""
    inv_var = torch.exp(-2 * log_sigma)
    return (0.5 * inv_var * (y - mu) ** 2 + log_sigma).mean()


# Crypto returns are not Gaussian. Under a Gaussian likelihood the optimiser
# shrinks sigma to fit the calm bulk and is then annihilated by the tails —
# which is exactly the failure we measured. A Student-t has the heavy tails
# built in, so the fitted scale stays honest.
STUDENT_T_DOF = 4.0


def student_t_nll(
    mu: torch.Tensor, log_scale: torch.Tensor, y: torch.Tensor, dof: float = STUDENT_T_DOF
) -> torch.Tensor:
    scale = torch.exp(log_scale)
    z = (y - mu) / scale
    c = (
        math.lgamma((dof + 1) / 2)
        - math.lgamma(dof / 2)
        - 0.5 * math.log(dof * math.pi)
    )
    return (-c + log_scale + 0.5 * (dof + 1) * torch.log1p(z**2 / dof)).mean()


def t_scale_to_std(dof: float = STUDENT_T_DOF) -> float:
    """A Student-t scale is not a standard deviation; this converts it."""
    return math.sqrt(dof / (dof - 2)) if dof > 2 else float("nan")
