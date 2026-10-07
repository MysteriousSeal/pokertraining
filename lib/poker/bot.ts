import { type Card, fullDeck, randomInt } from "./cards";
import { evaluateScore } from "./evaluator";
import { type Action, type GameState, legalActions, potTotal } from "./engine";

/** Chen formula: quick preflop hand strength, roughly -1 (72o) to 20 (AA). */
export function chenScore([a, b]: Card[]): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const base = (r: number) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let score = base(hi);
  if (hi === lo) return Math.max(5, score * 2);
  if (a.suit === b.suit) score += 2;
  const gap = hi - lo - 1;
  score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) score += 1;
  return Math.ceil(score);
}

/**
 * Monte Carlo equity of `hole` against `opponents` random hands. Ties count as split.
 * Hot path for bots and the AI trainer: uses the fast Math.random (an estimate, not
 * a deal) and reuses its arrays instead of allocating per sample.
 */
export function estimateEquity(hole: Card[], board: Card[], opponents: number, iterations = 300): number {
  const known = new Set([...hole, ...board].map((c) => c.rank * 4 + "shdc".indexOf(c.suit)));
  const deck = fullDeck().filter((c) => !known.has(c.rank * 4 + "shdc".indexOf(c.suit)));
  const n = deck.length;
  const need = 5 - board.length;
  const draw = need + opponents * 2;
  const mine: Card[] = [...hole, ...board, ...deck.slice(0, need)];
  const theirs: Card[] = [deck[0], deck[1], ...board, ...deck.slice(0, need)];
  const firstDrawn = 2 + board.length;
  let total = 0;
  for (let it = 0; it < iterations; it++) {
    // Partial Fisher–Yates: draw only the cards we need. Starting from the previous
    // sample's order is fine: the drawn prefix is still uniformly random.
    for (let i = 0; i < draw; i++) {
      const j = i + ((Math.random() * (n - i)) | 0);
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    for (let k = 0; k < need; k++) mine[firstDrawn + k] = theirs[firstDrawn + k] = deck[k];
    const my = evaluateScore(mine);
    let ties = 0;
    let lost = false;
    for (let o = 0; o < opponents; o++) {
      theirs[0] = deck[need + o * 2];
      theirs[1] = deck[need + o * 2 + 1];
      const score = evaluateScore(theirs);
      if (score > my) {
        lost = true;
        break;
      }
      if (score === my) ties++;
    }
    if (!lost) total += 1 / (ties + 1);
  }
  return total / iterations;
}

const chance = (p: number) => randomInt(10_000) < p * 10_000;

export function decideBotAction(s: GameState): Action {
  const legal = legalActions(s)!;
  const me = s.players[s.toAct!];
  const bb = s.blinds.bb;
  const opponents = s.players.filter((p) => p.id !== me.id && !p.out && !p.folded);
  const maxOppStack = Math.max(...opponents.map((p) => p.stack + p.bet));
  const effBB = Math.min(me.stack + me.bet, maxOppStack) / bb;
  const pot = potTotal(s);

  const allIn: Action = { type: "raise", amount: legal.maxRaiseTo };
  const passive: Action = legal.canCheck ? { type: "check" } : { type: "fold" };
  const call: Action = legal.canCall ? { type: "call" } : { type: "check" };
  const raiseTo = (amount: number): Action => {
    if (!legal.canRaise) return call;
    const target = Math.round(Math.max(legal.minRaiseTo, amount));
    // Committing most of the stack anyway: just shove.
    if (target >= legal.maxRaiseTo * 0.6) return allIn;
    return { type: "raise", amount: target };
  };

  if (s.street === "preflop") {
    const chen = chenScore(me.hole);
    const activePlayers = opponents.length + 1;
    const facingRaise = s.currentBet > bb;
    const toCallBB = legal.toCall / bb;
    const callCommits = legal.toCall >= me.stack * 0.5 || legal.toCall >= me.stack;

    if (!facingRaise) {
      // Unopened pot (or limped to the big blind).
      if (effBB <= 12) {
        const threshold = (effBB <= 5 ? 2 : effBB <= 8 ? 4 : effBB <= 10 ? 5 : 6) + (activePlayers === 3 ? 1 : 0);
        if (legal.canRaise && chen >= threshold) return allIn;
        if (legal.canCheck) return { type: "check" };
        // Small blind completing heads-up with a speculative hand.
        if (toCallBB <= 0.5 && chen >= threshold - 3 && chance(0.25)) return call;
        return passive;
      }
      if (legal.canCheck) {
        // Big blind after a limp.
        if (chen >= 9 || (chen >= 7 && chance(0.4))) return raiseTo(s.currentBet * 3.5);
        return { type: "check" };
      }
      const openThreshold = activePlayers === 3 ? 6 : 4;
      if (chen >= openThreshold) return raiseTo(bb * (effBB > 20 ? 2.5 : 2));
      if (chen >= openThreshold - 2 && chance(0.3)) return call;
      return passive;
    }

    // Facing a raise.
    if (callCommits || effBB <= 12) {
      const needed = legal.toCall >= 10 * bb ? 9 : legal.toCall >= 6 * bb ? 8 : legal.toCall >= 3 * bb ? 6 : 4;
      if (chen >= needed + 2 && legal.canRaise) return allIn;
      if (chen >= needed) return call;
      return passive;
    }
    if (chen >= 11) return effBB <= 25 ? allIn : raiseTo(s.currentBet * 3);
    if (chen >= 9 && chance(0.35)) return raiseTo(s.currentBet * 3);
    if (chen >= 6 || (chen >= 4 && toCallBB <= 1.5)) return call;
    return passive;
  }

  // Postflop.
  const equity = estimateEquity(me.hole, s.board, opponents.length, 300);
  const spr = me.stack / Math.max(pot, 1);
  const wasAggressor = s.preflopAggressor === me.id;

  if (legal.canCheck) {
    if (equity > 0.72) return spr < 1.2 ? allIn : raiseTo(pot * (chance(0.5) ? 0.75 : 0.5));
    if (equity > 0.55 && chance(0.6)) return raiseTo(pot * 0.5);
    if (s.street === "flop" && wasAggressor && chance(0.55)) return raiseTo(pot * 0.4);
    if (s.street === "river" && opponents.length === 1 && chance(0.12)) return raiseTo(pot * 0.7);
    return { type: "check" };
  }

  const potOdds = legal.toCall / (pot + legal.toCall);
  if (equity > 0.8 && legal.canRaise && chance(0.65)) return spr < 2 ? allIn : raiseTo(s.currentBet * 3);
  if (equity >= potOdds + 0.04) return call;
  if (legal.canRaise && opponents.length === 1 && chance(0.04)) return raiseTo(s.currentBet * 2.8);
  return { type: "fold" };
}
