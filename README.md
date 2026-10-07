# Expresso Trainer

A 3-handed hyper-turbo sit & go modelled on Winamax Expresso: you play against two bots in the browser.

- **Format:** 3 players, 500 starting chips, blinds go up every 3 minutes (10/20 → 15/30 → …), new blinds apply from the next hand.
- **Prize pool:** buy-in × a multiplier drawn on a reel before the first hand (x2 up to x10,000). Up to x10 the winner takes all. From x100 up, 2nd and 3rd are paid too.
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
| `lib/poker/expresso.ts` | Blind structure, buy-ins, multiplier odds and payouts (tune here) |
| `hooks/useExpressoGame.ts` | Game loop: bot timing, street pacing, blind clock, shot clock |
| `components/` | Lobby, multiplier reel, table, seats, action bar |

The multiplier odds and payout splits are approximations; the real Winamax tables vary by buy-in.
