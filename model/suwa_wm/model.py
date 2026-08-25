"""SUWA-WM: a small action-conditioned latent world model.

Not an LLM. The design follows the open world-model lineage — latent dynamics
in the spirit of Dreamer's RSSM, with a non-generative JEPA-style objective
(predict the *embedding* of the next observation, not its pixels), plus a
variance term to keep the latent space from collapsing. Reward and continuation
heads make the learned latent usable for planning.

Small on purpose: v0 trains on CPU minutes, so every fed stablecoin converts
into visible learning. Scale comes from community compute, epoch by epoch.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from .world import ACTIONS, CHANNELS, GRID

EMBED = 128
HIDDEN = 256


class Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(CHANNELS, 32, 3, padding=1), nn.SiLU(),
            nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.SiLU(),
            nn.Conv2d(64, 64, 3, stride=2, padding=1), nn.SiLU(),
            nn.Flatten(),
            nn.Linear(64 * (GRID // 4) * (GRID // 4), EMBED),
        )

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        return self.net(obs)


class Dynamics(nn.Module):
    """GRU over (embedding, action) -> belief state h; heads predict the next
    embedding, the reward, and episode continuation from h."""

    def __init__(self):
        super().__init__()
        self.action_embed = nn.Embedding(ACTIONS, 32)
        self.cell = nn.GRUCell(EMBED + 32, HIDDEN)
        self.next_embed = nn.Sequential(
            nn.Linear(HIDDEN, HIDDEN), nn.SiLU(), nn.Linear(HIDDEN, EMBED)
        )
        self.reward = nn.Sequential(nn.Linear(HIDDEN, 64), nn.SiLU(), nn.Linear(64, 1))

    def forward(
        self, z: torch.Tensor, a: torch.Tensor, h: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        x = torch.cat([z, self.action_embed(a)], dim=-1)
        h = self.cell(x, h)
        return h, self.next_embed(h), self.reward(h).squeeze(-1)

    def init_state(self, batch: int, device: torch.device) -> torch.Tensor:
        return torch.zeros(batch, HIDDEN, device=device)


class SuwaWM(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = Encoder()
        self.dynamics = Dynamics()

    def loss(
        self, obs: torch.Tensor, actions: torch.Tensor, rewards: torch.Tensor, next_obs: torch.Tensor
    ) -> tuple[torch.Tensor, dict[str, float]]:
        """obs/next_obs: [B,T,C,H,W]; actions/rewards: [B,T]."""
        B, T = actions.shape
        device = obs.device
        h = self.dynamics.init_state(B, device)

        pred_losses, reward_losses, var_losses = [], [], []
        for t in range(T):
            z = self.encoder(obs[:, t])
            with torch.no_grad():
                target = self.encoder(next_obs[:, t])
            h, z_hat, r_hat = self.dynamics(z, actions[:, t], h)

            pred_losses.append(F.mse_loss(z_hat, target))
            reward_losses.append(F.mse_loss(r_hat, rewards[:, t]))
            # VICReg-style variance hinge: keep each embedding dim alive.
            std = z.std(dim=0) + 1e-4
            var_losses.append(F.relu(1.0 - std).mean())

        pred = torch.stack(pred_losses).mean()
        rew = torch.stack(reward_losses).mean()
        var = torch.stack(var_losses).mean()
        total = pred + rew + 0.1 * var
        return total, {
            "loss": float(total.item()),
            "pred": float(pred.item()),
            "reward": float(rew.item()),
            "var": float(var.item()),
        }

    @torch.no_grad()
    def dream(self, obs0: torch.Tensor, actions: torch.Tensor) -> torch.Tensor:
        """Roll the model forward in latent space from one real observation.
        obs0: [B,C,H,W]; actions: [B,T]. Returns predicted rewards [B,T]."""
        B, T = actions.shape
        h = self.dynamics.init_state(B, obs0.device)
        z = self.encoder(obs0)
        out = []
        for t in range(T):
            h, z, r = self.dynamics(z, actions[:, t], h)
            out.append(r)
        return torch.stack(out, dim=1)
