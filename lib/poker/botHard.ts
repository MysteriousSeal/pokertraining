/**
 * "Hard" bot.
 *
 * Preflop, short-stacked: shoves from equilibrium push/fold charts (heads-up
 * charts solved by scripts/gen-pushfold.ts, tightened on the button 3-handed).
 * Facing bets: estimates each opponent's likely range from what they did this
 * hand and what they have done all game (e.g. a player who shoves every hand gets
 * a very wide shoving range), then calls only when its equity against that range
 * beats the price. Postflop it narrows ranges further from betting (bets usually
 * mean a made hand or a draw) and value-bets, bluffs and folds accordingly.
 */
import type { Card } from "./cards";
import { type Action, type GameState, type Player, legalActions, potTotal } from "./engine";
import { evaluateScore } from "./evaluator";
import {
  CLASSES,
  CLASS_COMBOS,
  CLASS_INDEX,
  COMBOS,
  N_CLASSES,
  type ComboFilter,
  type Range,
  equityVsRanges,
  handClass,
  rangeSize,
  scoreCategory,
  topRange,
} from "./ranges";
import PUSHFOLD from "./data/pushfold.json";

const PUSH: Record<string, number> = PUSHFOLD.push;
const CALL: Record<string, number> = PUSHFOLD.call;

/** Shoving tighter on the button 3-handed: two players left to act instead of one. */
const BUTTON_FACTOR = 1.5;
/** Below this many big blinds (effective), unopened pots are shove-or-fold. */
const PUSH_FOLD_BB = 15;

/** Share of all hands at least as strong as each class (CLASSES is strongest first). */
const TOP_SHARE: number[] = (() => {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < N_CLASSES; i++) {
    acc += CLASS_COMBOS[i];
    out.push(acc / COMBOS.length);
  }
  return out;
})();
const inTop = (cls: string, share: number) => TOP_SHARE[CLASS_INDEX[cls]] <= share + 1e-9;

function chartRange(chart: Record<string, number>, stackBB: number, factor: number): Range {
  const r = new Float32Array(N_CLASSES);
  CLASSES.forEach((c, i) => (r[i] = chart[c] >= stackBB * factor ? 1 : 0));
  return r;
}

const chance = (p: number) => Math.random() < p;
const alivePlayers = (s: GameState) => s.players.filter((p) => !p.out);
const onButton3Handed = (s: GameState, p: Player) => alivePlayers(s).length === 3 && s.dealer === p.id;

/* ------------------------------------------------------------- range reading */

/** What `v` is likely to hold given their preflop actions this hand and their habits so far. */
export function estimateRange(s: GameState, v: Player): Range {
  const preflop = s.history.filter((h) => h.street === "preflop");
  const mine = preflop.filter((h) => h.player === v.id);
  const lastRaise = [...mine].reverse().find((h) => h.type === "raise");
  const seen = v.stats.hands >= 6;
  const shoveRate = seen ? v.stats.shoves / v.stats.hands : 0;
  const raiseRate = seen ? v.stats.raises / v.stats.hands : 0;
  const stackBB = v.stackAtStart / s.blinds.bb;

  let share: number;
  if (lastRaise) {
    const firstRaise = preflop.find((h) => h.type === "raise") === lastRaise;
    const shove = lastRaise.allIn || lastRaise.to >= 0.6 * v.stackAtStart;
    if (shove) {
      const chart = firstRaise
        ? chartRange(PUSH, stackBB, onButton3Handed(s, v) ? BUTTON_FACTOR : 1)
        : chartRange(CALL, stackBB, 1); // re-shove: roughly a calling range
      // Someone who shoves far more often than the chart has a wider range.
      share = Math.max(rangeSize(chart), shoveRate * 1.1);
    } else if (firstRaise) {
      share = Math.max(0.35, raiseRate * 1.1);
    } else {
      share = 0.12; // a re-raise that isn't all-in
    }
  } else if (mine.some((h) => h.type === "call")) {
    const facedRaise = preflop.findIndex((h) => h.type === "raise") < preflop.findIndex((h) => h.player === v.id && h.type === "call");
    share = facedRaise ? 0.4 : 0.75;
  } else {
    share = 1; // checked the big blind: anything
  }
  return topRange(Math.min(1, Math.max(0.03, share)));
}

/** Narrow postflop: bettors usually have a made hand or a draw; callers often do. */
function postflopFilter(s: GameState, villains: Player[]): ComboFilter {
  const board = s.board;
  const boardCat = board.length >= 3 ? scoreCategory(evaluateScore(board)) : 0;
  const postflop = s.history.filter((h) => h.street !== "preflop");
  const role = villains.map((v) => {
    const acts = postflop.filter((h) => h.player === v.id);
    if (acts.some((h) => h.type === "bet" || h.type === "raise")) return "aggressor";
    if (acts.some((h) => h.type === "call")) return "caller";
    return "passive";
  });
  const cards: Card[] = new Array(2 + board.length);
  board.forEach((c, i) => (cards[2 + i] = c));
  return (vi, combo) => {
    if (role[vi] === "passive") return true;
    cards[0] = combo.cards[0];
    cards[1] = combo.cards[1];
    const improved = scoreCategory(evaluateScore(cards)) > boardCat;
    const suits: Record<string, number> = {};
    for (const c of cards) suits[c.suit] = (suits[c.suit] ?? 0) + 1;
    const flushDraw = board.length < 5 && Object.entries(suits).some(([su, n]) => n === 4 && combo.cards.some((c) => c.suit === su));
    if (improved || flushDraw) return true;
    return chance(role[vi] === "aggressor" ? 0.3 : 0.45);
  };
}

/* ------------------------------------------------------------------ deciding */

export function decideHardBotAction(s: GameState): Action {
  const legal = legalActions(s)!;
  const me = s.players[s.toAct!];
  const bb = s.blinds.bb;
  const villains = s.players.filter((p) => p.id !== me.id && !p.out && !p.folded);
  const maxVillainStack = Math.max(...villains.map((p) => p.stack + p.bet));
  const effBB = Math.min(me.stack + me.bet, maxVillainStack) / bb;
  const pot = potTotal(s);
  const cls = handClass(me.hole);

  const allIn: Action = { type: "raise", amount: legal.maxRaiseTo };
  const call: Action = legal.canCall ? { type: "call" } : { type: "check" };
  const passive: Action = legal.canCheck ? { type: "check" } : { type: "fold" };
  const raiseTo = (amount: number): Action => {
    if (!legal.canRaise) return call;
    const target = Math.round(Math.max(legal.minRaiseTo, amount));
    if (target >= legal.maxRaiseTo * 0.6) return allIn;
    return { type: "raise", amount: target };
  };

  if (s.street === "preflop") {
    const raises = s.history.filter((h) => h.street === "preflop" && h.type === "raise");
    const limps = s.history.filter((h) => h.street === "preflop" && h.type === "call").length;

    if (raises.length === 0) {
      if (legal.canCheck) {
        // Big blind after limps: punish weak limps.
        if (effBB <= 12) return legal.canRaise && CALL[cls] >= effBB ? allIn : passive;
        return inTop(cls, 0.22) ? raiseTo(s.currentBet * 3.5 + limps * bb) : passive;
      }
      if (limps > 0) {
        // Small blind behind a button limp.
        if (inTop(cls, 0.12)) return effBB <= 15 ? allIn : raiseTo(bb * 4);
        return inTop(cls, 0.55) ? call : passive;
      }
      if (effBB <= PUSH_FOLD_BB) {
        const factor = onButton3Handed(s, me) ? BUTTON_FACTOR : 1;
        return PUSH[cls] >= effBB * factor ? allIn : passive;
      }
      const openShare = onButton3Handed(s, me) ? 0.42 : 0.6;
      return inTop(cls, openShare) ? raiseTo(bb * (effBB > 25 ? 2.2 : 2)) : passive;
    }

    // Facing a raise or a shove: equity against what they're likely to hold.
    const equity = equityVsRanges(me.hole, [], villains.map((v) => estimateRange(s, v)), 300);
    const required = legal.toCall / (pot + legal.toCall);
    const stillToAct = s.players.filter((p) => p.id !== me.id && !p.out && !p.folded && !p.allIn && !p.hasActed).length;
    const margin = stillToAct ? 0.04 : 0.01;
    const everyoneAllIn = villains.every((v) => v.allIn);

    if (everyoneAllIn || legal.toCall >= me.stack * 0.4 || effBB <= 12) {
      if (!everyoneAllIn && legal.canRaise && equity >= 0.5 && effBB <= 25) return allIn;
      return equity >= required + margin ? call : passive;
    }
    if (legal.canRaise && equity >= 0.6) return effBB <= 25 ? allIn : raiseTo(s.currentBet * 3);
    if (legal.canRaise && effBB <= 25 && equity >= 0.52 && chance(0.4)) return allIn;
    return equity >= required + 0.06 ? call : passive;
  }

  // Postflop
  const equity = equityVsRanges(
    me.hole,
    s.board,
    villains.map((v) => estimateRange(s, v)),
    250,
    postflopFilter(s, villains),
  );
  const spr = me.stack / Math.max(pot, 1);
  const headsUp = villains.length === 1;

  if (legal.canCheck) {
    if (equity >= 0.65) return spr < 1.5 ? allIn : raiseTo(pot * (equity > 0.8 ? 0.75 : 0.6));
    if (s.street === "flop" && s.preflopAggressor === me.id && headsUp && chance(0.55)) return raiseTo(pot * 0.33);
    if (s.street === "river" && headsUp && equity < 0.2 && chance(0.3)) return raiseTo(pot * 0.75);
    return { type: "check" };
  }
  const potOdds = legal.toCall / (pot + legal.toCall);
  if (equity >= 0.78 && legal.canRaise) return spr < 2 ? allIn : raiseTo(s.currentBet * 3);
  if (equity >= potOdds + 0.02) return call;
  if (legal.canRaise && headsUp && s.street !== "river" && chance(0.05)) return raiseTo(s.currentBet * 3);
  return { type: "fold" };
}
