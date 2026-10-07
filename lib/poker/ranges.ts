/**
 * Hand ranges: the 169 starting-hand classes, all 1,326 two-card combos, and
 * equity of a hand against what opponents are *likely* to hold.
 */
import { type Card, type Rank, type Suit, SUITS, fullDeck } from "./cards";
import { evaluateScore } from "./evaluator";
import PREFLOP_EQUITY from "./data/preflop_equity.json";

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

export const cardId = (c: Card) => (c.rank - 2) * 4 + SUITS.indexOf(c.suit);

const PREFLOP: Record<string, number[]> = PREFLOP_EQUITY;

/** All 169 classes, strongest first (by equity against one random hand). */
export const CLASSES: string[] = Object.keys(PREFLOP).sort((a, b) => PREFLOP[b][0] - PREFLOP[a][0]);
export const CLASS_INDEX: Record<string, number> = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
export const N_CLASSES = CLASSES.length;

export interface Combo {
  cards: [Card, Card];
  ids: [number, number];
  cls: number;
}

/** Every two-card starting hand. */
export const COMBOS: Combo[] = (() => {
  const deck = fullDeck();
  const out: Combo[] = [];
  for (let i = 0; i < deck.length; i++)
    for (let j = i + 1; j < deck.length; j++) {
      const cards: [Card, Card] = [deck[i], deck[j]];
      out.push({ cards, ids: [cardId(deck[i]), cardId(deck[j])], cls: CLASS_INDEX[handClass(cards)] });
    }
  return out;
})();

/** Combos per class: 6 for pairs, 4 suited, 12 offsuit. */
export const CLASS_COMBOS: number[] = (() => {
  const n = new Array<number>(N_CLASSES).fill(0);
  for (const c of COMBOS) n[c.cls]++;
  return n;
})();

/** A range: weight 0..1 per class (index into CLASSES). */
export type Range = Float32Array;

/** The strongest `fraction` of all hands (by combos), e.g. 0.2 = top 20%. */
export function topRange(fraction: number): Range {
  const r = new Float32Array(N_CLASSES);
  const target = Math.max(0, Math.min(1, fraction)) * COMBOS.length;
  let acc = 0;
  for (let i = 0; i < N_CLASSES && acc < target; i++) {
    const room = target - acc;
    r[i] = Math.min(1, room / CLASS_COMBOS[i]);
    acc += CLASS_COMBOS[i];
  }
  return r;
}

/** Share of all combos a range contains. */
export function rangeSize(r: Range): number {
  let n = 0;
  for (let i = 0; i < N_CLASSES; i++) n += r[i] * CLASS_COMBOS[i];
  return n / COMBOS.length;
}

/** Decides whether a sampled opponent hand fits their postflop actions (see botHard.ts). */
export type ComboFilter = (villain: number, combo: Combo) => boolean;

/**
 * Monte Carlo equity of `hole` against one hand from each range, given the board.
 * `filter` lets callers narrow ranges further (e.g. "they bet the flop, so they
 * usually connected"). Ties count as split.
 */
export function equityVsRanges(hole: Card[], board: Card[], ranges: Range[], iterations = 250, filter?: ComboFilter): number {
  const dead = new Set([...hole, ...board].map(cardId));
  const pools = ranges.map((r) => COMBOS.filter((c) => r[c.cls] > 0 && !dead.has(c.ids[0]) && !dead.has(c.ids[1])));
  const rest = fullDeck().filter((c) => !dead.has(cardId(c)));
  const need = 5 - board.length;
  const mine: Card[] = [...hole, ...board, ...rest.slice(0, need)];
  const theirs: Card[] = [rest[0], rest[1], ...board, ...rest.slice(0, need)];
  const firstDrawn = 2 + board.length;
  const used = new Set<number>();
  const picked: Combo[] = [];
  let total = 0;
  let counted = 0;

  for (let it = 0; it < iterations; it++) {
    used.clear();
    picked.length = 0;
    let ok = true;
    for (let v = 0; v < ranges.length && ok; v++) {
      const pool = pools[v];
      ok = false;
      for (let tries = 0; tries < 60 && pool.length; tries++) {
        const c = pool[(Math.random() * pool.length) | 0];
        if (used.has(c.ids[0]) || used.has(c.ids[1])) continue;
        if (Math.random() >= ranges[v][c.cls]) continue;
        if (filter && tries < 40 && !filter(v, c)) continue; // relax the filter if it rejects everything
        used.add(c.ids[0]);
        used.add(c.ids[1]);
        picked.push(c);
        ok = true;
        break;
      }
    }
    if (!ok) continue;

    // Deal the rest of the board from cards nobody holds.
    let k = 0;
    for (let i = 0; i < rest.length && k < need; i++) {
      const j = i + ((Math.random() * (rest.length - i)) | 0);
      const tmp = rest[i];
      rest[i] = rest[j];
      rest[j] = tmp;
      if (used.has(cardId(rest[i]))) continue;
      mine[firstDrawn + k] = theirs[firstDrawn + k] = rest[i];
      k++;
    }
    if (k < need) continue;

    const my = evaluateScore(mine);
    let ties = 0;
    let lost = false;
    for (const c of picked) {
      theirs[0] = c.cards[0];
      theirs[1] = c.cards[1];
      const score = evaluateScore(theirs);
      if (score > my) {
        lost = true;
        break;
      }
      if (score === my) ties++;
    }
    counted++;
    if (!lost) total += 1 / (ties + 1);
  }
  return counted ? total / counted : 0.5;
}

/** Hand category (0 = high card … 8 = straight flush) from an `evaluateScore` value. */
export const scoreCategory = (score: number) => Math.floor(score / 16 ** 5);

export function parseClass(cls: string): [Card, Card] {
  const r = (ch: string) => (RANK_CHARS.indexOf(ch) + 2) as Rank;
  const suits: [Suit, Suit] = cls.length === 3 && cls[2] === "s" ? ["s", "s"] : ["s", "h"];
  return [
    { rank: r(cls[0]), suit: suits[0] },
    { rank: r(cls[1]), suit: suits[1] },
  ];
}
