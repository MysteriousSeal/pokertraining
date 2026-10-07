/**
 * What the agent can see (an Observation, readable from the rendered table)
 * and how that becomes the network's input vector and action space.
 *
 * The simulator builds observations straight from the engine state; the browser
 * driver builds the same object from the page's DOM. Both go through `featurize`,
 * so training and live play see identical inputs.
 */
import type { Card, Rank, Suit } from "../lib/poker/cards";
import { cardKey } from "../lib/poker/cards";
import { evaluate } from "../lib/poker/evaluator";
import { estimateEquity } from "../lib/poker/bot";
import { type GameState, legalActions, potTotal } from "../lib/poker/engine";
// Bundled as data so this module also runs in the browser (Chrome extension).
import PREFLOP_EQUITY from "./preflop_equity.json";

export interface SeatObs {
  stack: number;
  bet: number;
  folded: boolean;
  out: boolean;
  allIn: boolean;
  dealer: boolean;
  /** "", "SB", "BB", "Check", "Call", "Bet", "Raise", "All-in", "Fold" */
  lastAction: string;
}

export interface Observation {
  /** Hero, then the seat acting after the hero (left on screen), then the right seat. */
  seats: [SeatObs, SeatObs, SeatObs];
  hole: string[];
  board: string[];
  sb: number;
  bb: number;
  level: number;
  /** Total chips in the middle, including bets in front of players. */
  pot: number;
  canCheck: boolean;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

/* ------------------------------------------------------------------ actions */

export const ACTIONS = ["fold", "check/call", "raise min", "raise ½ pot", "raise pot", "all-in"] as const;
export const N_ACTIONS = ACTIONS.length;

export interface ConcreteAction {
  type: "fold" | "check" | "call" | "raise";
  amount?: number;
}

/** Concrete move for each action index, and which indices are legal (duplicates masked out). */
export function actionTable(obs: Observation): { actions: ConcreteAction[]; mask: boolean[] } {
  const hero = obs.seats[0];
  const currentBet = Math.max(...obs.seats.map((s) => s.bet));
  const toCall = currentBet - hero.bet;
  const clamp = (v: number) => Math.round(Math.min(obs.maxRaiseTo, Math.max(obs.minRaiseTo, v)));
  const potRaise = (f: number) => clamp(currentBet + f * (obs.pot + toCall));

  const half = potRaise(0.5);
  const pot = potRaise(1);
  const actions: ConcreteAction[] = [
    { type: "fold" },
    { type: obs.canCheck ? "check" : "call" },
    { type: "raise", amount: obs.minRaiseTo },
    { type: "raise", amount: half },
    { type: "raise", amount: pot },
    { type: "raise", amount: obs.maxRaiseTo },
  ];
  const r = obs.canRaise;
  const mask = [
    !obs.canCheck, // never fold when checking is free
    true,
    r && obs.minRaiseTo < obs.maxRaiseTo,
    r && half > obs.minRaiseTo && half < obs.maxRaiseTo,
    r && pot > Math.max(half, obs.minRaiseTo) && pot < obs.maxRaiseTo,
    r,
  ];
  return { actions, mask };
}

/* ------------------------------------------------------------- observation */

export function observe(s: GameState, heroId: number): Observation {
  const legal = legalActions(s);
  const seat = (offset: number): SeatObs => {
    const p = s.players[(heroId + offset) % s.players.length];
    return {
      stack: p.out ? 0 : p.stack,
      bet: p.out ? 0 : p.bet,
      folded: !p.out && p.folded,
      out: p.out,
      allIn: !p.out && p.allIn,
      dealer: s.dealer === p.id,
      lastAction: p.out ? "" : (p.lastAction ?? ""),
    };
  };
  return {
    seats: [seat(0), seat(1), seat(2)],
    hole: s.players[heroId].hole.map(cardKey),
    board: s.board.map(cardKey),
    sb: s.blinds.sb,
    bb: s.blinds.bb,
    level: s.level,
    pot: potTotal(s),
    canCheck: legal?.canCheck ?? false,
    canRaise: legal?.canRaise ?? false,
    minRaiseTo: legal?.canRaise ? legal.minRaiseTo : 0,
    maxRaiseTo: legal?.canRaise ? legal.maxRaiseTo : 0,
  };
}

/* ---------------------------------------------------------------- features */

const RANK_OF: Record<string, Rank> = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
export function parseCard(key: string): Card {
  const r = key.slice(0, -1);
  return { rank: (RANK_OF[r] ?? Number(r)) as Rank, suit: key.slice(-1) as Suit };
}

const preflopTable: Record<string, number[]> = PREFLOP_EQUITY;
function preflopEquity(hole: Card[]): number[] {
  return preflopTable[handClass(hole)];
}

const RANK_CHARS = "23456789TJQKA";
/** "AKs", "AKo", "QQ" */
export function handClass([a, b]: Card[]): string {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const h = RANK_CHARS[hi - 2];
  const l = RANK_CHARS[lo - 2];
  if (hi === lo) return h + l;
  return h + l + (a.suit === b.suit ? "s" : "o");
}

const LAST_ACTIONS = ["", "blind", "Check", "Call", "raise", "All-in", "Fold"];
function lastActionIndex(a: string): number {
  if (a === "SB" || a === "BB") return 1;
  if (a === "Bet" || a === "Raise") return 4;
  const i = LAST_ACTIONS.indexOf(a);
  return i < 0 ? 0 : i;
}

const oneHot = (n: number, i: number) => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));

export const EQUITY_ITERATIONS = { train: 150, play: 600 };

/** Position of the hand-equity value in `featurize`'s output (after 2×13 rank one-hots, suited, pair, 2 preflop equities). */
export const EQUITY_FEATURE = 30;

export function featurize(obs: Observation, equityIterations = EQUITY_ITERATIONS.train): number[] {
  const hole = obs.hole.map(parseCard);
  const board = obs.board.map(parseCard);
  const [hero, left, right] = obs.seats;
  const bb = obs.bb;
  const chips = (v: number) => Math.min(v / bb / 25, 5);
  const total = obs.seats.reduce((a, s) => a + s.stack + s.bet, 0) + (obs.pot - obs.seats.reduce((a, s) => a + s.bet, 0));

  const activeOpps = [left, right].filter((s) => !s.out && !s.folded).length;
  const alive = obs.seats.filter((s) => !s.out).length;
  const currentBet = Math.max(...obs.seats.map((s) => s.bet));
  const toCall = Math.max(0, currentBet - hero.bet);

  // Cards
  const hi = Math.max(hole[0].rank, hole[1].rank);
  const lo = Math.min(hole[0].rank, hole[1].rank);
  const suited = hole[0].suit === hole[1].suit ? 1 : 0;
  const pair = hi === lo ? 1 : 0;
  const [pre1, pre2] = preflopEquity(hole);

  let equity: number;
  if (board.length === 0) equity = activeOpps >= 2 ? pre2 : pre1;
  else equity = activeOpps === 0 ? 1 : estimateEquity(hole, board, activeOpps, equityIterations);

  const made = board.length ? evaluate([...hole, ...board]).category : pair ? 1 : 0;
  const boardCat = board.length ? evaluate(board).category : 0;
  const suitCounts = (cards: Card[]) => {
    const c: Record<string, number> = { s: 0, h: 0, d: 0, c: 0 };
    for (const x of cards) c[x.suit]++;
    return Math.max(...Object.values(c));
  };
  const boardSuit = board.length ? suitCounts(board) : 0;
  const flushDraw = board.length && board.length < 5 && suitCounts([...hole, ...board]) === 4 && suitCounts(board) < 4 ? 1 : 0;
  const streetIdx = board.length === 0 ? 0 : board.length === 3 ? 1 : board.length === 4 ? 2 : 3;

  // Position: seats are in action order (hero, left, right).
  let position: number;
  if (alive === 2) position = hero.dealer ? 0 : 2; // heads-up: button is the small blind
  else position = hero.dealer ? 0 : right.dealer ? 1 : 2;

  const seatFlags = (s: SeatObs) => [s.folded ? 1 : 0, s.out ? 1 : 0, s.allIn ? 1 : 0, s.dealer ? 1 : 0];
  const effective = Math.min(hero.stack + hero.bet, Math.max(...[left, right].filter((s) => !s.out && !s.folded).map((s) => s.stack + s.bet), 0));

  return [
    ...oneHot(13, hi - 2),
    ...oneHot(13, lo - 2),
    suited,
    pair,
    pre1,
    pre2,
    equity,
    ...oneHot(9, made),
    boardCat / 8,
    ...oneHot(4, streetIdx),
    boardSuit / 5,
    flushDraw,
    chips(hero.stack),
    chips(left.stack),
    chips(right.stack),
    chips(hero.bet),
    chips(left.bet),
    chips(right.bet),
    chips(obs.pot),
    chips(toCall),
    chips(obs.minRaiseTo),
    chips(obs.maxRaiseTo),
    chips(effective),
    toCall / (obs.pot + toCall || 1),
    Math.min(effective / Math.max(obs.pot, 1), 10) / 10,
    (hero.stack + hero.bet) / total,
    (left.stack + left.bet) / total,
    (right.stack + right.bet) / total,
    bb / 500,
    obs.level / 15,
    ...seatFlags(hero),
    ...seatFlags(left),
    ...seatFlags(right),
    ...oneHot(3, position),
    alive === 2 ? 1 : 0,
    activeOpps / 2,
    obs.canCheck ? 1 : 0,
    obs.canRaise ? 1 : 0,
    ...oneHot(LAST_ACTIONS.length, lastActionIndex(hero.lastAction)),
    ...oneHot(LAST_ACTIONS.length, lastActionIndex(left.lastAction)),
    ...oneHot(LAST_ACTIONS.length, lastActionIndex(right.lastAction)),
  ];
}
