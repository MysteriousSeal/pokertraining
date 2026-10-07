# Expresso Trainer

A 3-handed hyper-turbo sit & go modelled on Winamax Expresso: you play against two bots in the browser.

- **Formats** (as on [winamax.fr/expresso](https://www.winamax.fr/expresso)):
  - **Expresso:** 500 chips, blinds go up every 1 min 30 s.
  - **Expresso Nitro:** 300 chips, blinds go up every minute.
  - Both start at 10/20, and new blinds apply from the next hand.
- **Prize pool:** buy-in × a multiplier drawn on a reel before the first hand, using Winamax's official odds for each buy-in (€0.25 to €500, jackpots up to x500,000). The winner takes all below x50. From x50 the jackpot is split 80% / 12% / 8%.
- **Rules:** full No-Limit Hold'em, including heads-up button/blind rules, side pots, uncalled bets returned, and incomplete all-in raises that don't reopen the betting.
- **Bots:** two levels, picked in the lobby (Easy, Hard, or Mixed: one of each). Each bot's level is shown on its seat.
  - **Easy:** fixed rules. It plays all-in-or-fold with short stacks using the Chen formula, opens, 3-bets and calls when deeper, and compares its equity against a *random* hand to the pot odds after the flop. It has no memory.
  - **Hard:** shoves from **equilibrium push/fold charts** when short-stacked. It judges calls by its equity against the opponent's **likely range**, read from their actions this hand and their habits so far: someone who shoves constantly gets a wide range and gets called lighter. After the flop it narrows ranges from betting, then value-bets, bluffs and folds accordingly.
- **Table:** a 15 s shot clock (auto check/fold), Check/Fold and Call any pre-actions, preset bet sizes and a slider, BB display, a four-colour deck and a hand history.
- **Keyboard:** `F` fold · `C` check/call · `R` raise · `A` all-in.
- **Bankroll:** play money (€1,000 to start), saved in `localStorage`.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
```

## Engine test

Runs thousands of bot-only tournaments (easy and hard bots mixed), checking that no chips are created or lost, that every game ends, and that side pots go to the right players:

```bash
npx tsx scripts/simulate.ts 2000
```

## Bot levels

```bash
npx tsx scripts/bot-arena.ts 2000      # win rate of each player type vs 2 easy / 2 hard / easy+hard bots
npx tsx scripts/gen-pushfold.ts        # re-solve the push/fold charts (lib/poker/data/pushfold.json, committed)
```

The push/fold charts come from solving heads-up all-in-or-fold at 1–30 big blinds.
The solver computes the equity of every starting hand against every other (with card removal), then runs *fictitious play* (each side best-responds to the other's average strategy) until both settle.
It reproduces the known heads-up results: at 10 BB the small blind shoves 58% of hands and the big blind calls 37%.
In 3-handed pots the button shoves tighter, at 1.5× the stack threshold.

Arena results (600 games per cell, ±4 points, 33.3% = break-even):

| Seat 0 plays… | vs 2 easy | vs 2 hard | vs easy + hard |
|---|---|---|---|
| easy bot | 32.0% | 27.0% | 30.2% |
| hard bot | 47.3% | 36.3% | 36.2% |
| always all-in | 44.7% | 26.0% | 36.2% |
| random | 16.7% | 18.8% | 13.5% |

## AI agent

A reinforcement-learning agent (PPO, PyTorch) that learns to play the Expresso table against the two bots.
It trains in a headless simulator that runs the same TypeScript engine and bots as the browser game.
Then it plays the real game in Chrome, reading the table from the page and clicking the buttons.

**One model for every bot level.** By default each training game seats a random mix: two easy bots, two hard bots, or one of each (`--opponents mix`).
The model reads each opponent's level from the table, like everything else it sees.
So `ai/checkpoints/best.pt` is a single model meant to play well against any combination.
You can still train or evaluate against one level with `--opponents easy` or `--opponents hard`.

Models trained before levels existed (105 inputs) load fine: the new level inputs start with zero weight, so they play exactly as before and learn to use them with `--resume`.

**Rewards:** chips won or lost each hand (as a share of all chips in play), +1 for winning the Expresso, and −0.5 for not winning.

### Setup (once)

```bash
python3 -m venv ai/.venv
ai/.venv/bin/pip install torch numpy playwright
npx tsx ai/gen_preflop.ts          # builds lib/poker/data/preflop_equity.json (already committed)
```

### Train

```bash
ai/.venv/bin/python ai/train.py --minutes 60                      # start from a blank network (mixed bots)
ai/.venv/bin/python ai/train.py --resume --minutes 60             # continue from the last checkpoint
ai/.venv/bin/python ai/train.py --resume --minutes 60 --opponents hard  # focus on one bot level
ai/.venv/bin/python ai/train.py --resume --minutes 60 --ent 0.005 # continue, exploring less
ai/.venv/bin/python ai/train.py --resume --minutes 60 -v          # extra detail per update
```

Each update prints the elapsed and remaining time, the games played, the win rate over the last 5,000 games, and the action mix.
`-v` adds finishing places, hands per game, losses, entropy, KL, the learning rate, and a timing breakdown (playing vs learning).
Ctrl+C stops cleanly and saves.

`best.pt` is only replaced by a model with a better win rate *against the same opponents*.
If the current `best.pt` was trained against other opponents (e.g. an easy-only model), it is kept as `best-easy.pt` the first time a new best replaces it.

**Speed / CPU:** games are simulated in parallel by `--workers` Node processes (default 6, one CPU core each).
The network uses `--threads` PyTorch threads (default 2).
Almost all of the time goes to simulating games, mostly the Monte Carlo equity estimates used by the bots and the agent, not to the network.
On an 8-core M2, 4–8 workers give about the same speed (~1 s per update of 18k decisions), so adding more processes doesn't help.
Use `-v` to see the timing breakdown on your machine:

```bash
ai/.venv/bin/python ai/train.py --resume --minutes 60 --workers 6 --threads 2 -v
```

### Evaluate in the simulator

```bash
ai/.venv/bin/python ai/eval.py --games 20000                                   # best.pt vs mixed bots, most likely action
ai/.venv/bin/python ai/eval.py --games 20000 --opponents hard                  # vs hard bots only (also: easy)
ai/.venv/bin/python ai/eval.py --games 20000 --checkpoint ai/checkpoints/latest.pt
ai/.venv/bin/python ai/eval.py --games 20000 --sample -v                       # sampled actions + action mix
```

### Play in the browser

```bash
npm run dev                                                        # in another terminal
ai/.venv/bin/python ai/play_browser.py --games 100 --speed 30           # headless
ai/.venv/bin/python ai/play_browser.py --games 20 --speed 10 --headed   # watch it play
```

```bash
ai/.venv/bin/python ai/play_browser.py --games 20 --buy-in 5            # stake per game in € (default 1)
ai/.venv/bin/python ai/play_browser.py --games 20 --bots hard           # opponents: random (default) | easy | hard | mixed
ai/.venv/bin/python ai/play_browser.py --games 50 --checkpoint ai/checkpoints/latest.pt
```

`--bots random` (default) re-draws the opponents before every game, like training: 2 easy bots (25%), 2 hard bots (25%) or one of each (50%).
The summary then shows the win rate per table type.

`?speed=N` on the game URL fast-forwards bot thinking, pauses and the blind clock.
The agent uses `best.pt` by default and always plays its most likely action.

The console prints one line per game (place, multiplier, buy-in, prize, running win rate and net).
With `--headed` it also prints each decision.
At the end it prints a summary:

```
20 browser games in 3.1 min, 640 decisions
win 55.0% ± 21.8   places 1/2/3 = [11, 3, 6]
multipliers drawn: x2×12, x3×6, x4×2
amount bet: €20.00
amount won: €28.00
net result: +€8.00   (ROI +40.0%)
```

Amounts are read from the game's own result screen.

### Chrome extension (AI coach)

`extension/` is a Chrome extension that runs the trained agent while *you* play on `http://localhost:3000`.
It only activates on that address.

- **Coach:** a panel shows the AI's recommended move, your hand's equity, and how likely the AI is to pick each action.
- **Autoplay:** switch it on in the extension popup and the AI clicks for you. Before each move it waits a random 1–3 s, like a person thinking. You can set the minimum and maximum in the popup.

The network runs in the page itself (no Python needed), using the same feature code as training (`ai/agent.ts`).

```bash
npm run extension          # export ai/checkpoints/best.pt → extension/model.json and build extension/dist/content.js
```

Then load it once in Chrome:
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Open `http://localhost:3000` and pin the extension to reach its popup.

After more training, run `npm run extension` again, then click ↻ on the extension in `chrome://extensions` and reload the game tab.
To ship a specific checkpoint, run `ai/.venv/bin/python ai/export_weights.py --checkpoint ai/checkpoints/latest.pt && npm run extension:build`.

### Baselines

```bash
npx tsx ai/baseline.ts 2000   # win rate of random, call-only, always all-in, and the table bot in the agent's seat
```

### Files

| Path | What |
| --- | --- |
| `ai/agent.ts` | What the agent sees (table observation → input features) and its 6 actions |
| `ai/env.ts` | Headless game from the agent's seat, rewards, blind clock |
| `ai/server.ts` | JSON bridge between Python and the TypeScript game |
| `ai/train.py` · `ai/eval.py` · `ai/play_browser.py` | Training, evaluation, browser play |
| `ai/checkpoints/` | `best.pt` (best win rate) and `latest.pt` (most recent), plus `best-<opponents>.pt` archives; not committed |
| `ai/export_weights.py` | Exports a checkpoint to `extension/model.json` |
| `extension/` | Chrome extension: `src/content.ts` (coach + autoplay), `popup.html`/`popup.js`, `manifest.json` |

## Layout

| Path | What |
| --- | --- |
| `lib/poker/engine.ts` | Pure game state machine (deal, bet, side pots, eliminations) |
| `lib/poker/evaluator.ts` | 7-card hand evaluator |
| `lib/poker/bot.ts` | Easy bot, equity estimation, and dispatch by seat level |
| `lib/poker/botHard.ts` | Hard bot: push/fold charts, range reading, postflop play |
| `lib/poker/ranges.ts` | Hand classes, combos, "top X%" ranges, equity against ranges |
| `lib/poker/data/` | Preflop equity table and solved push/fold charts |
| `lib/poker/expresso.ts` | Formats, blind levels, buy-ins, official multiplier tables and payouts |
| `hooks/useExpressoGame.ts` | Game loop: bot timing, street pacing, blind clock, shot clock |
| `components/` | Lobby, multiplier reel, table, seats, action bar |

Winamax only publishes level 1 (10/20) of the blind schedule. To match the client exactly, paste the later levels into `BLIND_LEVELS` in `lib/poker/expresso.ts`.
