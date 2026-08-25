"""The Reef — a tiny procedural ocean world the creature dreams about.

A 12x12 grid. The agent (a small swimmer) moves in four directions or drifts;
ocean currents shove it around; plankton spawns and is eaten for reward.
Observations are dense multi-channel grids, which makes this a real (if tiny)
world-modeling problem: the model must learn dynamics (movement + currents),
object permanence (plankton), and reward structure — from pixels, not text.

Everything is generated procedurally: no external dataset, no downloads.
A training run works the same on a laptop, a CPU pod, or a decentralized GPU.
"""

from __future__ import annotations

import numpy as np

GRID = 12
CHANNELS = 4  # agent, plankton, current-x, current-y
ACTIONS = 5   # stay, up, down, left, right
EPISODE_LEN = 64

_DELTAS = np.array([[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]])


class Reef:
    def __init__(self, seed: int | None = None):
        self.rng = np.random.default_rng(seed)
        self.reset()

    def reset(self) -> np.ndarray:
        self.t = 0
        self.pos = self.rng.integers(0, GRID, size=2)
        self.plankton = np.zeros((GRID, GRID), dtype=np.float32)
        for _ in range(6):
            self._spawn_plankton()
        # A smooth current field, fixed per episode: sin/cos waves with a
        # random phase. The model has to infer it from how the agent drifts.
        xs = np.arange(GRID)
        phase = self.rng.uniform(0, 2 * np.pi, size=2)
        self.current_x = np.tile(np.sin(xs / 3.0 + phase[0]), (GRID, 1)).astype(np.float32)
        self.current_y = np.tile(np.cos(xs / 3.0 + phase[1])[:, None], (1, GRID)).astype(np.float32)
        return self.obs()

    def _spawn_plankton(self) -> None:
        for _ in range(20):
            p = self.rng.integers(0, GRID, size=2)
            if self.plankton[p[0], p[1]] == 0 and not np.array_equal(p, self.pos):
                self.plankton[p[0], p[1]] = 1.0
                return

    def obs(self) -> np.ndarray:
        o = np.zeros((CHANNELS, GRID, GRID), dtype=np.float32)
        o[0, self.pos[0], self.pos[1]] = 1.0
        o[1] = self.plankton
        o[2] = self.current_x
        o[3] = self.current_y
        return o

    def step(self, action: int) -> tuple[np.ndarray, float, bool]:
        self.t += 1
        move = _DELTAS[action].copy()

        # Currents: probabilistically shove the swimmer along the local flow.
        cx = self.current_x[self.pos[0], self.pos[1]]
        cy = self.current_y[self.pos[0], self.pos[1]]
        if self.rng.random() < abs(cx) * 0.5:
            move[1] += int(np.sign(cx))
        if self.rng.random() < abs(cy) * 0.5:
            move[0] += int(np.sign(cy))

        self.pos = np.clip(self.pos + move, 0, GRID - 1)

        reward = 0.0
        if self.plankton[self.pos[0], self.pos[1]] > 0:
            self.plankton[self.pos[0], self.pos[1]] = 0.0
            reward = 1.0
            self._spawn_plankton()

        done = self.t >= EPISODE_LEN
        return self.obs(), reward, done


def forage_policy(env: Reef, eps: float, rng: np.random.Generator) -> int:
    """Swim toward the nearest plankton, with epsilon noise."""
    if rng.random() < eps:
        return int(rng.integers(0, ACTIONS))
    targets = np.argwhere(env.plankton > 0)
    if len(targets) == 0:
        return 0
    d = np.abs(targets - env.pos).sum(axis=1)
    t = targets[int(np.argmin(d))]
    if t[0] < env.pos[0]:
        return 1
    if t[0] > env.pos[0]:
        return 2
    if t[1] < env.pos[1]:
        return 3
    if t[1] > env.pos[1]:
        return 4
    return 0


def rollout_batch(
    batch: int, seq: int, rng: np.random.Generator
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Collect (obs, action, reward, next_obs) sequences: shapes
    [B, T, C, H, W], [B, T], [B, T], [B, T, C, H, W]."""
    O = np.zeros((batch, seq, CHANNELS, GRID, GRID), dtype=np.float32)
    A = np.zeros((batch, seq), dtype=np.int64)
    R = np.zeros((batch, seq), dtype=np.float32)
    N = np.zeros_like(O)
    for b in range(batch):
        env = Reef(seed=int(rng.integers(0, 2**31)))
        o = env.reset()
        eps = float(rng.uniform(0.1, 0.6))
        for t in range(seq):
            a = forage_policy(env, eps, rng)
            o2, r, done = env.step(a)
            O[b, t], A[b, t], R[b, t], N[b, t] = o, a, r, o2
            o = env.reset() if done else o2
    return O, A, R, N
