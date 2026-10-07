"""Let the trained agent play the real game in a browser.

It reads the table from the page (cards, stacks, bets, pot, buttons), decides,
and clicks the same buttons a person would. The game runs fast-forwarded via `?speed=`.

    npm run dev                                   # in another terminal
    ai/.venv/bin/python ai/play_browser.py --games 200 --speed 30 [--headed]
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

from common import ACTIONS, CHECKPOINTS, GameServer, load

READ_TABLE = """() => {
  const felt = document.querySelector('.table-felt');
  if (!felt || !document.querySelector('[data-action]')) return null;
  const seat = (pos) => {
    const el = document.querySelector(`.seat[data-position="${pos}"]`);
    const d = el.dataset;
    return {
      stack: Number(d.stack), bet: Number(d.bet), out: d.out === 'true',
      folded: d.folded === 'true', allIn: d.allin === 'true', dealer: d.dealer === 'true',
      lastAction: d.lastAction || '',
    };
  };
  const cards = (sel) => [...document.querySelectorAll(sel)].map((e) => e.dataset.card);
  const range = document.querySelector('.raise-slider input[type=range]');
  return {
    seats: [seat('bottom'), seat('left'), seat('right')],
    hole: cards('.seat-bottom .seat-cards [data-card]'),
    board: cards('.board [data-card]'),
    sb: Number(felt.dataset.sb), bb: Number(felt.dataset.bb), level: Number(felt.dataset.level),
    pot: Number(felt.dataset.pot),
    canCheck: !!document.querySelector('[data-action=check]'),
    canRaise: !!document.querySelector('[data-action=raise]'),
    minRaiseTo: range ? Number(range.min) : 0,
    maxRaiseTo: range ? Number(range.max) : 0,
  };
}"""

PROFILE = {"bankroll": 1e9, "played": 0, "wins": 0, "profit": 0, "heroName": "AI"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3000")
    ap.add_argument("--speed", type=int, default=30)
    ap.add_argument("--games", type=int, default=100)
    ap.add_argument("--checkpoint", type=Path, default=CHECKPOINTS / "best.pt")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    args = ap.parse_args()

    policy = load(args.checkpoint)
    features = GameServer()
    places: list[int] = []
    decisions = 0
    t0 = time.time()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=not args.headed)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.add_init_script(f"localStorage.setItem('expresso-trainer:v1', JSON.stringify({json.dumps(PROFILE)}))")
        page.goto(f"{args.url}/?speed={args.speed}")
        page.get_by_role("button", name="Play Expresso ·").click()

        last_decision = None
        while len(places) < args.games:
            result = page.query_selector(".result-place")
            if result:
                place = int(result.inner_text()[0])
                places.append(place)
                wins = places.count(1)
                print(f"game {len(places):4d}: {result.inner_text():>3}   win rate {wins / len(places) * 100:5.1f}%", flush=True)
                page.get_by_role("button", name="Play again").click()
                continue

            skip = page.query_selector(".wheel-skip")
            if skip:
                skip.click()
                continue

            obs = page.evaluate(READ_TABLE)
            if obs is None or len(obs["hole"]) != 2:
                page.wait_for_timeout(5)
                continue
            key = json.dumps(obs, sort_keys=True)
            if key == last_decision:  # our click hasn't landed yet
                page.wait_for_timeout(5)
                continue

            reply = features.call({"cmd": "featurize", "obs": obs})
            a = int(policy.act(np.asarray([reply["x"]], np.float32), np.asarray([reply["mask"]]), greedy=True)[0])
            move = reply["actions"][a]
            try:
                if move["type"] == "raise":
                    page.fill(".raise-input", str(move["amount"]), timeout=1000)
                    page.click("[data-action=raise]", timeout=1000)
                else:
                    page.click(f"[data-action={move['type']}]", timeout=1000)
            except Exception:
                continue  # the table moved on (e.g. shot clock); read it again
            last_decision = key
            decisions += 1
            if args.headed:
                print(f"   {''.join(obs['hole'])} | {' '.join(obs['board']) or '-':14} → {ACTIONS[a]}", flush=True)

        browser.close()
    features.close()

    p = np.array(places)
    win = (p == 1).mean()
    ci = 1.96 * math.sqrt(win * (1 - win) / len(p))
    print(f"\n{len(p)} browser games in {(time.time() - t0) / 60:.1f} min, {decisions} decisions")
    print(f"win {win * 100:.1f}% ± {ci * 100:.1f}   places 1/2/3 = {np.bincount(p, minlength=4)[1:].tolist()}")


if __name__ == "__main__":
    main()
