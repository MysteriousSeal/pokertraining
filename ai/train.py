"""PPO training against the table bots in the headless simulator.

    ai/.venv/bin/python ai/train.py --minutes 60

Reward = chips won or lost each hand (as a share of all chips in play)
       + a bonus for winning the Expresso / a penalty for busting (see ai/env.ts).
"""

from __future__ import annotations

import argparse
import collections
import time

import numpy as np
import torch

from common import ACTIONS, CHECKPOINTS, Policy, Pool, load, save

SHORT = ["fold", "call", "min", "half", "pot", "jam"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=60)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--envs", type=int, default=48, help="games per worker")
    ap.add_argument("--steps", type=int, default=64, help="rollout length per game")
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--gamma", type=float, default=0.997)
    ap.add_argument("--lam", type=float, default=0.95)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--minibatch", type=int, default=2048)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--ent", type=float, default=0.02, help="initial entropy bonus (decays to 10%%)")
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    torch.set_num_threads(2)
    pool = Pool(args.workers, args.envs)
    n_envs = args.workers * args.envs
    obs_dim = pool.x.shape[1]

    latest = CHECKPOINTS / "latest.pt"
    policy = load(latest) if args.resume and latest.exists() else Policy(obs_dim, len(ACTIONS))
    policy.train()
    opt = torch.optim.Adam(policy.parameters(), lr=args.lr, eps=1e-5)

    T = args.steps
    buf_x = np.zeros((T, n_envs, obs_dim), np.float32)
    buf_m = np.zeros((T, n_envs, len(ACTIONS)), bool)
    buf_a = np.zeros((T, n_envs), np.int64)
    buf_lp = np.zeros((T, n_envs), np.float32)
    buf_v = np.zeros((T, n_envs), np.float32)
    buf_r = np.zeros((T, n_envs), np.float32)
    buf_d = np.zeros((T, n_envs), np.float32)

    recent = collections.deque(maxlen=5000)  # finishing places
    total_games = 0
    best = 0.0
    best_path = CHECKPOINTS / "best.pt"
    if args.resume and best_path.exists():
        # Only replace the saved best model with a better one.
        best = torch.load(best_path, map_location="cpu")["meta"].get("win", 0.0)
        print(f"resuming from {latest.name}; best so far {best * 100:.1f}%", flush=True)
    start = time.time()
    update = 0
    print(f"obs_dim={obs_dim} envs={n_envs} batch={T * n_envs}", flush=True)

    while time.time() - start < args.minutes * 60:
        frac = min(1.0, (time.time() - start) / (args.minutes * 60))
        ent_coef = args.ent * (1 - 0.9 * frac)
        for g in opt.param_groups:
            g["lr"] = args.lr * (1 - 0.8 * frac)

        # ---- rollout
        policy.eval()
        for t in range(T):
            x = torch.as_tensor(pool.x)
            m = torch.as_tensor(pool.mask)
            with torch.no_grad():
                logits, v = policy(x, m)
                dist = torch.distributions.Categorical(logits=logits)
                a = dist.sample()
            buf_x[t], buf_m[t] = pool.x, pool.mask
            buf_a[t], buf_lp[t], buf_v[t] = a.numpy(), dist.log_prob(a).numpy(), v.numpy()
            r, d, place = pool.step(a.numpy())
            buf_r[t], buf_d[t] = r, d
            for p in place[d]:
                recent.append(int(p))
                total_games += 1
        with torch.no_grad():
            _, next_v = policy(torch.as_tensor(pool.x), torch.as_tensor(pool.mask))
        next_v = next_v.numpy()

        # ---- GAE (episodes end on `done`; the next observation is a fresh game)
        adv = np.zeros_like(buf_r)
        last = np.zeros(n_envs, np.float32)
        for t in reversed(range(T)):
            nv = next_v if t == T - 1 else buf_v[t + 1]
            nonterminal = 1.0 - buf_d[t]
            delta = buf_r[t] + args.gamma * nv * nonterminal - buf_v[t]
            last = delta + args.gamma * args.lam * nonterminal * last
            adv[t] = last
        ret = adv + buf_v

        # ---- PPO update
        policy.train()
        X = torch.as_tensor(buf_x.reshape(-1, obs_dim))
        M = torch.as_tensor(buf_m.reshape(-1, len(ACTIONS)))
        A = torch.as_tensor(buf_a.reshape(-1))
        LP = torch.as_tensor(buf_lp.reshape(-1))
        ADV = torch.as_tensor(adv.reshape(-1))
        RET = torch.as_tensor(ret.reshape(-1))
        ADV = (ADV - ADV.mean()) / (ADV.std() + 1e-8)
        n = X.shape[0]
        for _ in range(args.epochs):
            perm = torch.randperm(n)
            for i in range(0, n, args.minibatch):
                idx = perm[i : i + args.minibatch]
                logits, v = policy(X[idx], M[idx])
                dist = torch.distributions.Categorical(logits=logits)
                ratio = (dist.log_prob(A[idx]) - LP[idx]).exp()
                pg = -torch.min(ratio * ADV[idx], ratio.clamp(1 - args.clip, 1 + args.clip) * ADV[idx]).mean()
                vloss = 0.5 * (v - RET[idx]).pow(2).mean()
                ent = dist.entropy().mean()
                loss = pg + 0.5 * vloss - ent_coef * ent
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
                opt.step()

        # ---- log & checkpoint
        update += 1
        places = np.array(recent)
        win = float((places == 1).mean()) if len(places) else 0.0
        mix = np.bincount(buf_a.reshape(-1), minlength=len(ACTIONS)) / buf_a.size
        elapsed = time.time() - start
        print(
            f"[{elapsed / 60:5.1f} min] update {update:4d}  games {total_games:7d}  "
            f"win(last {len(places)}) {win * 100:5.1f}%  ent {ent.item():.2f}  "
            "actions " + " ".join(f"{a}:{p * 100:.0f}" for a, p in zip(SHORT, mix)),
            flush=True,
        )
        save(policy, latest, games=total_games, win=win)
        if len(places) >= 3000 and win > best:
            best = win
            save(policy, best_path, games=total_games, win=win)

    pool.close()
    print(f"done: {total_games} games, best rolling win {best * 100:.1f}%")


if __name__ == "__main__":
    main()
