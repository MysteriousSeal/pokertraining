"""Measure a checkpoint's win rate in the simulator.

    ai/.venv/bin/python ai/eval.py --games 20000 [--checkpoint ai/checkpoints/best.pt] [--sample]
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np

from common import CHECKPOINTS, Pool, load


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", type=Path, default=CHECKPOINTS / "best.pt")
    ap.add_argument("--games", type=int, default=20000)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--envs", type=int, default=48)
    ap.add_argument("--sample", action="store_true", help="sample actions instead of taking the most likely one")
    args = ap.parse_args()

    policy = load(args.checkpoint)
    pool = Pool(args.workers, args.envs)
    places: list[int] = []
    while len(places) < args.games:
        a = policy.act(pool.x, pool.mask, greedy=not args.sample)
        _, done, place = pool.step(a)
        places.extend(int(p) for p in place[done])
    pool.close()

    p = np.array(places[: args.games])
    win = (p == 1).mean()
    ci = 1.96 * math.sqrt(win * (1 - win) / len(p))
    counts = np.bincount(p, minlength=4)[1:]
    print(f"{args.checkpoint.name}: {len(p)} games  win {win * 100:.1f}% ± {ci * 100:.1f}  places 1/2/3 = {counts.tolist()}")


if __name__ == "__main__":
    main()
