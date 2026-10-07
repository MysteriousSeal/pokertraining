# Expresso Trainer

A 3-handed hyper-turbo sit & go modelled on Winamax Expresso: you play against two bots in the browser.

- **Formats** (as on [winamax.fr/expresso](https://www.winamax.fr/expresso)):
  - **Expresso:** 500 chips, blinds go up every 1 min 30 s.
  - **Expresso Nitro:** 300 chips, blinds go up every minute.
  - Both start at 10/20, and new blinds apply from the next hand.
- **Prize pool:** buy-in × a multiplier drawn on a reel before the first hand, using Winamax's official odds for each buy-in (€0.25 to €500, jackpots up to x500,000). The winner takes all below x50. From x50 the jackpot is split 80% / 12% / 8%.
- **Rules:** full No-Limit Hold'em, including heads-up button/blind rules, side pots, uncalled bets returned, and incomplete all-in raises that don't reopen the betting.
- **Bots:** short-stack push/fold play with the Chen formula. Deeper stacks open, 3-bet and call. After the flop they compare Monte Carlo equity to pot odds and mix in c-bets and some bluffs.
- **Table:** a 15 s shot clock (auto check/fold), Check/Fold and Call any pre-actions, preset bet sizes and a slider, BB display, a four-colour deck and a hand history.
- **Keyboard:** `F` fold · `C` check/call · `R` raise · `A` all-in.
- **Bankroll:** play money (€1,000 to start), saved in `localStorage`.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
```

## Engine test

Runs thousands of bot-only tournaments, checking that no chips are created or lost, that every game ends, and that side pots go to the right players:

```bash
npx tsx scripts/simulate.ts 2000
```

## Layout

| Path | What |
| --- | --- |
| `lib/poker/engine.ts` | Pure game state machine (deal, bet, side pots, eliminations) |
| `lib/poker/evaluator.ts` | 7-card hand evaluator |
| `lib/poker/bot.ts` | Bot decisions and equity estimation |
| `lib/poker/expresso.ts` | Formats, blind levels, buy-ins, official multiplier tables and payouts |
| `hooks/useExpressoGame.ts` | Game loop: bot timing, street pacing, blind clock, shot clock |
| `components/` | Lobby, multiplier reel, table, seats, action bar |

Winamax only publishes level 1 (10/20) of the blind schedule. To match the client exactly, paste the later levels into `BLIND_LEVELS` in `lib/poker/expresso.ts`.
