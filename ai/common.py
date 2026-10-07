"""Shared pieces: the policy network and the bridge to the TypeScript game (ai/server.ts)."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

ROOT = Path(__file__).resolve().parent.parent
CHECKPOINTS = ROOT / "ai" / "checkpoints"
ACTIONS = ["fold", "check/call", "raise min", "raise ½ pot", "raise pot", "all-in"]


class GameServer:
    """One Node process hosting `n` simulated games (or answering featurize calls)."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            ["npx", "tsx", "ai/server.ts"],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def send(self, msg: dict) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def recv(self) -> dict:
        assert self.proc.stdout
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("game server exited")
        reply = json.loads(line)
        if "error" in reply:
            raise RuntimeError(reply["error"])
        return reply

    def call(self, msg: dict) -> dict:
        self.send(msg)
        return self.recv()

    def close(self) -> None:
        self.proc.kill()


class Pool:
    """Several game servers stepped in parallel, exposed as one batch."""

    def __init__(self, workers: int, envs_per_worker: int) -> None:
        self.servers = [GameServer() for _ in range(workers)]
        self.n = envs_per_worker
        self.server_time = 0.0  # seconds spent waiting on game servers
        for s in self.servers:
            s.send({"cmd": "init", "n": envs_per_worker})
        replies = [s.recv() for s in self.servers]
        self.x, self.mask = self._stack(replies)

    @staticmethod
    def _stack(replies: list[dict]):
        x = np.concatenate([np.asarray(r["x"], dtype=np.float32) for r in replies])
        mask = np.concatenate([np.asarray(r["mask"], dtype=bool) for r in replies])
        return x, mask

    def step(self, actions: np.ndarray):
        t0 = time.time()
        for i, s in enumerate(self.servers):
            s.send({"cmd": "step", "actions": actions[i * self.n : (i + 1) * self.n].tolist()})
        replies = [s.recv() for s in self.servers]
        self.server_time += time.time() - t0
        self.x, self.mask = self._stack(replies)
        reward = np.concatenate([r["reward"] for r in replies]).astype(np.float32)
        done = np.concatenate([r["done"] for r in replies]).astype(bool)
        place = np.concatenate([[p or 0 for p in r["place"]] for r in replies]).astype(np.int64)
        self.hands = np.concatenate([r["hands"] for r in replies]).astype(np.int64)
        return reward, done, place

    def close(self) -> None:
        for s in self.servers:
            s.close()


class Status:
    """Console output: permanent lines, plus a live line that rewrites itself in a terminal."""

    def __init__(self) -> None:
        self.tty = sys.stdout.isatty()
        self._last_live = 0.0
        self._live_len = 0

    def line(self, text: str = "") -> None:
        self._clear()
        print(text, flush=True)

    def live(self, text: str, every: float = 0.2) -> None:
        if not self.tty:
            return
        now = time.time()
        if now - self._last_live < every:
            return
        self._last_live = now
        self._clear()
        sys.stdout.write(text[:200])
        sys.stdout.flush()
        self._live_len = min(len(text), 200)

    def _clear(self) -> None:
        if self.tty and self._live_len:
            sys.stdout.write("\r" + " " * self._live_len + "\r")
            self._live_len = 0


def fmt_duration(seconds: float) -> str:
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m" if h else f"{m}m{s:02d}s"


class Policy(nn.Module):
    def __init__(self, obs_dim: int, n_actions: int, hidden: int = 256) -> None:
        super().__init__()
        self.obs_dim = obs_dim
        self.body = nn.Sequential(
            nn.Linear(obs_dim, hidden),
            nn.Tanh(),
            nn.Linear(hidden, hidden),
            nn.Tanh(),
            nn.Linear(hidden, hidden),
            nn.Tanh(),
        )
        self.pi = nn.Linear(hidden, n_actions)
        self.v = nn.Linear(hidden, 1)
        nn.init.orthogonal_(self.pi.weight, 0.01)
        nn.init.zeros_(self.pi.bias)

    def forward(self, x: torch.Tensor, mask: torch.Tensor):
        h = self.body(x)
        logits = self.pi(h).masked_fill(~mask, -1e9)
        return logits, self.v(h).squeeze(-1)

    @torch.no_grad()
    def act(self, x: np.ndarray, mask: np.ndarray, greedy: bool = False) -> np.ndarray:
        logits, _ = self(torch.as_tensor(x), torch.as_tensor(mask))
        if greedy:
            return logits.argmax(-1).numpy()
        return torch.distributions.Categorical(logits=logits).sample().numpy()


def save(policy: Policy, path: Path, **meta) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": policy.state_dict(), "obs_dim": policy.obs_dim, "meta": meta}, path)


def load(path: Path) -> Policy:
    ckpt = torch.load(path, map_location="cpu")
    policy = Policy(ckpt["obs_dim"], len(ACTIONS))
    policy.load_state_dict(ckpt["state_dict"])
    policy.eval()
    return policy
