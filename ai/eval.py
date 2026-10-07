"""Measure a checkpoint's win rate in the simulator.

    ai/.venv/bin/python ai/eval.py --games 20000 [--checkpoint ai/checkpoints/best.pt] [--sample] [-v]
"""

from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

import numpy as np
import torch

from common import ACTIONS, CHECKPOINTS, Pool, Status, fmt_duration, load


def summary(places: list[int]) -> str:
    p = np.array(places)
    win = (p == 1).mean()
    ci = 1.96 * math.sqrt(win * (1 - win) / len(p)) * 100
    share = np.bincount(p, minlength=4)[1:] / len(p) * 100
    return f"win {win * 100:5.1f}% ±{ci:.1f} · places 1/2/3 {share[0]:.0f}/{share[1]:.0f}/{share[2]:.0f}%"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", type=Path, default=CHECKPOINTS / "best.pt")
    ap.add_argument("--games", type=int, default=20000)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--envs", type=int, default=48)
    ap.add_argument("--sample", action="store_true", help="sample actions instead of taking the most likely one")
    ap.add_argument("-v", "--verbose", action="store_true", help="also print the action mix and game length")
    args = ap.parse_args()

    out = Status()
    meta = torch.load(args.checkpoint, map_location="cpu").get("meta", {})
    out.line(
        f"Evaluating {args.checkpoint} (trained on {meta.get('games', 0):,} games, "
        f"training win rate {meta.get('win', 0) * 100:.1f}%)"
    )
    out.line(f"  policy: {'sampled' if args.sample else 'greedy (most likely action)'} · {args.games:,} games")
    policy = load(args.checkpoint)

    t_boot = time.time()
    out.line(f"Starting {args.workers} game servers × {args.envs} tables…")
    pool = Pool(args.workers, args.envs)
    out.line(f"  ready in {time.time() - t_boot:.1f}s\n")

    places: list[int] = []
    hands: list[int] = []
    action_counts = np.zeros(len(ACTIONS), np.int64)
    start = time.time()
    next_report = 0.1
    try:
        while len(places) < args.games:
            a = policy.act(pool.x, pool.mask, greedy=not args.sample)
            action_counts += np.bincount(a, minlength=len(ACTIONS))
            _, done, place = pool.step(a)
            places.extend(int(p) for p in place[done])
            hands.extend(int(h) for h in pool.hands[done])
            if not places:
                continue
            n = min(len(places), args.games)
            elapsed = time.time() - start
            rate = n / elapsed
            eta = (args.games - n) / rate if rate else 0
            progress = f"{n:7,d}/{args.games:,} games ({n / args.games * 100:3.0f}%) · {summary(places[:n])} · {rate:.0f} games/s · ETA {fmt_duration(eta)}"
            out.live("  " + progress)
            # Permanent checkpoints every 10% (useful when output goes to a file).
            if n / args.games >= next_report:
                out.line(f"  [{fmt_duration(elapsed)}] {progress}")
                next_report += 0.1
    except KeyboardInterrupt:
        out.line("\nStopped by Ctrl+C: results so far")
    finally:
        pool.close()

    places = places[: args.games]
    if not places:
        return
    out.line(f"\n{args.checkpoint.name}: {len(places):,} games in {fmt_duration(time.time() - start)}")
    out.line(f"  {summary(places)}")
    if args.verbose:
        mix = action_counts / action_counts.sum() * 100
        out.line("  actions: " + " · ".join(f"{name} {p:.1f}%" for name, p in zip(ACTIONS, mix)))
        out.line(f"  {np.mean(hands):.1f} hands per game")


if __name__ == "__main__":
    main()
