"""PPO training against the table bots in the headless simulator.

    ai/.venv/bin/python ai/train.py --minutes 60            # fresh start
    ai/.venv/bin/python ai/train.py --resume --minutes 60   # continue from latest.pt
    add -v for losses, learning rate, finishing places and game length

Reward = chips won or lost each hand (as a share of all chips in play)
       + a bonus for winning the Expresso / a penalty for busting (see ai/env.ts).
Ctrl+C stops cleanly and saves.
"""

from __future__ import annotations

import argparse
import collections
import time

import numpy as np
import torch

from common import ACTIONS, CHECKPOINTS, Policy, Pool, Status, fmt_duration, load, save

SHORT = ["fold", "call", "min", "half", "pot", "jam"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=60)
    ap.add_argument("--workers", type=int, default=6, help="game server processes (one CPU core each)")
    ap.add_argument("--threads", type=int, default=2, help="PyTorch threads for the network")
    ap.add_argument("--envs", type=int, default=48, help="games per worker")
    ap.add_argument("--steps", type=int, default=64, help="rollout length per game")
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--gamma", type=float, default=0.997)
    ap.add_argument("--lam", type=float, default=0.95)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--minibatch", type=int, default=2048)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--ent", type=float, default=0.02, help="initial entropy bonus (decays to 10%%)")
    ap.add_argument("--resume", action="store_true", help="continue from ai/checkpoints/latest.pt")
    ap.add_argument("-v", "--verbose", action="store_true", help="print extra training details each update")
    args = ap.parse_args()

    out = Status()
    torch.set_num_threads(args.threads)
    n_envs = args.workers * args.envs
    T = args.steps

    latest = CHECKPOINTS / "latest.pt"
    best_path = CHECKPOINTS / "best.pt"
    out.line(f"Starting {args.workers} game servers × {args.envs} games = {n_envs} tables…")
    t_boot = time.time()
    pool = Pool(args.workers, args.envs)
    obs_dim = pool.x.shape[1]
    out.line(f"  ready in {time.time() - t_boot:.1f}s · {obs_dim} inputs · {len(ACTIONS)} actions · {T * n_envs:,} decisions per update")

    games_before = 0
    best = 0.0
    if args.resume and latest.exists():
        policy = load(latest)
        games_before = int(torch.load(latest, map_location="cpu")["meta"].get("games", 0))
        out.line(f"Resuming from {latest} ({games_before:,} games already trained)")
        if best_path.exists():
            # Only replace the saved best model with a better one.
            best = torch.load(best_path, map_location="cpu")["meta"].get("win", 0.0)
            out.line(f"  best so far: {best * 100:.1f}% ({best_path})")
    else:
        if args.resume:
            out.line(f"No checkpoint at {latest}: starting from scratch")
        policy = Policy(obs_dim, len(ACTIONS))
        out.line("Starting from a blank network")
    policy.train()
    opt = torch.optim.Adam(policy.parameters(), lr=args.lr, eps=1e-5)
    out.line(f"Training for {args.minutes:g} min · lr {args.lr:g} · entropy {args.ent:g} · Ctrl+C to stop and save\n")

    buf_x = np.zeros((T, n_envs, obs_dim), np.float32)
    buf_m = np.zeros((T, n_envs, len(ACTIONS)), bool)
    buf_a = np.zeros((T, n_envs), np.int64)
    buf_lp = np.zeros((T, n_envs), np.float32)
    buf_v = np.zeros((T, n_envs), np.float32)
    buf_r = np.zeros((T, n_envs), np.float32)
    buf_d = np.zeros((T, n_envs), np.float32)

    recent = collections.deque(maxlen=5000)  # finishing places
    recent_hands = collections.deque(maxlen=5000)
    games = 0
    update = 0
    win = 0.0
    budget = args.minutes * 60
    start = time.time()

    def checkpoint() -> None:
        save(policy, latest, games=games_before + games, win=win)

    try:
        while time.time() - start < budget:
            t_update = time.time()
            games_at_start = games
            frac = min(1.0, (time.time() - start) / budget)
            ent_coef = args.ent * (1 - 0.9 * frac)
            lr = args.lr * (1 - 0.8 * frac)
            for g in opt.param_groups:
                g["lr"] = lr

            # ---- rollout: play T decisions at every table
            policy.eval()
            pool.server_time = 0.0
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
                for p, h in zip(place[d], pool.hands[d]):
                    recent.append(int(p))
                    recent_hands.append(int(h))
                    games += 1
                out.live(f"  update {update + 1} · playing {t + 1}/{T} · {games - games_at_start} games finished · {fmt_duration(time.time() - start)} elapsed")
            with torch.no_grad():
                _, next_v = policy(torch.as_tensor(pool.x), torch.as_tensor(pool.mask))
            next_v = next_v.numpy()
            t_learn = time.time()

            # ---- advantages (GAE); a finished game's next observation is a fresh game
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
            stats = collections.defaultdict(list)
            for epoch in range(args.epochs):
                out.live(f"  update {update + 1} · learning epoch {epoch + 1}/{args.epochs}", every=0)
                perm = torch.randperm(n)
                for i in range(0, n, args.minibatch):
                    idx = perm[i : i + args.minibatch]
                    logits, v = policy(X[idx], M[idx])
                    dist = torch.distributions.Categorical(logits=logits)
                    logratio = dist.log_prob(A[idx]) - LP[idx]
                    ratio = logratio.exp()
                    pg = -torch.min(ratio * ADV[idx], ratio.clamp(1 - args.clip, 1 + args.clip) * ADV[idx]).mean()
                    vloss = 0.5 * (v - RET[idx]).pow(2).mean()
                    ent = dist.entropy().mean()
                    loss = pg + 0.5 * vloss - ent_coef * ent
                    opt.zero_grad()
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
                    opt.step()
                    with torch.no_grad():
                        stats["pg"].append(pg.item())
                        stats["v"].append(vloss.item())
                        stats["ent"].append(ent.item())
                        stats["kl"].append(((ratio - 1) - logratio).mean().item())
                        stats["clip"].append(((ratio - 1).abs() > args.clip).float().mean().item())

            # ---- report & checkpoint
            t_done = time.time()
            update += 1
            places = np.array(recent)
            win = float((places == 1).mean()) if len(places) else 0.0
            elapsed = time.time() - start
            speed = (games - games_at_start) / (time.time() - t_update)
            mix = np.bincount(buf_a.reshape(-1), minlength=len(ACTIONS)) / buf_a.size
            ci = 1.96 * np.sqrt(win * (1 - win) / max(len(places), 1)) * 100
            checkpoint()
            out.line(
                f"[{fmt_duration(elapsed)} / {fmt_duration(budget)}, {fmt_duration(budget - elapsed)} left] "
                f"update {update:4d} | games {games_before + games:9,d} ({speed:4.0f}/s) | "
                f"win {win * 100:5.1f}% ±{ci:.1f} (best {best * 100:.1f}%) | "
                + " ".join(f"{a} {p * 100:.0f}" for a, p in zip(SHORT, mix))
            )
            if args.verbose:
                dist_places = np.bincount(places, minlength=4)[1:] / max(len(places), 1) * 100
                out.line(
                    f"        places 1/2/3 {dist_places[0]:.0f}/{dist_places[1]:.0f}/{dist_places[2]:.0f}% · "
                    f"{np.mean(recent_hands) if recent_hands else 0:.1f} hands/game · "
                    f"reward/decision {buf_r.mean():+.4f} · "
                    f"loss π {np.mean(stats['pg']):+.4f} V {np.mean(stats['v']):.4f} · "
                    f"entropy {np.mean(stats['ent']):.2f} (bonus {ent_coef:.4f}) · "
                    f"KL {np.mean(stats['kl']):.4f} clipped {np.mean(stats['clip']) * 100:.0f}% · lr {lr:.2e}"
                )
                out.line(
                    f"        time: playing {t_learn - t_update:.1f}s (game servers {pool.server_time:.1f}s) · "
                    f"learning {t_done - t_learn:.1f}s"
                )
            if len(places) >= 3000 and win > best:
                best = win
                save(policy, best_path, games=games_before + games, win=win)
                out.line(f"  ★ new best {win * 100:.1f}% over the last {len(places):,} games → saved {best_path}")
    except KeyboardInterrupt:
        out.line("\nStopped by Ctrl+C")
        checkpoint()
    finally:
        pool.close()

    out.line(
        f"\nDone after {fmt_duration(time.time() - start)}: {games:,} games this run "
        f"({games_before + games:,} total) · last win rate {win * 100:.1f}% · best {best * 100:.1f}%"
    )
    out.line(f"Saved {latest}" + (f" and {best_path}" if best_path.exists() else ""))


if __name__ == "__main__":
    main()
