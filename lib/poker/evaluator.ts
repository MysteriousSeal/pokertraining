import type { Card } from "./cards";

export enum HandCategory {
  HighCard = 0,
  Pair,
  TwoPair,
  Trips,
  Straight,
  Flush,
  FullHouse,
  Quads,
  StraightFlush,
}

export const CATEGORY_NAME: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High card",
  [HandCategory.Pair]: "Pair",
  [HandCategory.TwoPair]: "Two pair",
  [HandCategory.Trips]: "Three of a kind",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full house",
  [HandCategory.Quads]: "Four of a kind",
  [HandCategory.StraightFlush]: "Straight flush",
};

const PLURAL: Record<number, string> = {
  2: "Twos", 3: "Threes", 4: "Fours", 5: "Fives", 6: "Sixes", 7: "Sevens", 8: "Eights",
  9: "Nines", 10: "Tens", 11: "Jacks", 12: "Queens", 13: "Kings", 14: "Aces",
};
const SINGULAR: Record<number, string> = {
  2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven", 8: "Eight",
  9: "Nine", 10: "Ten", 11: "Jack", 12: "Queen", 13: "King", 14: "Ace",
};

export interface HandValue {
  /** Comparable score: higher wins. */
  score: number;
  category: HandCategory;
  /** Ranks that define the hand, most significant first. */
  ranks: number[];
}

function pack(category: HandCategory, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 16 + (ranks[i] ?? 0);
  return score;
}

/** Highest straight top-card in a 15-bit rank mask (bit r set = rank r present), or 0. */
function straightHigh(mask: number): number {
  // Wheel: ace plays low.
  if (mask & (1 << 14)) mask |= 1 << 1;
  for (let high = 14; high >= 5; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  return 0;
}

/** Evaluate the best 5-card hand from 5 to 7 cards. */
export function evaluate(cards: Card[]): HandValue {
  const counts = new Array<number>(15).fill(0);
  const suitMasks: Record<string, number> = { s: 0, h: 0, d: 0, c: 0 };
  const suitCounts: Record<string, number> = { s: 0, h: 0, d: 0, c: 0 };
  let rankMask = 0;
  for (const c of cards) {
    counts[c.rank]++;
    rankMask |= 1 << c.rank;
    suitMasks[c.suit] |= 1 << c.rank;
    suitCounts[c.suit]++;
  }

  let flushSuit: string | null = null;
  for (const s of ["s", "h", "d", "c"]) if (suitCounts[s] >= 5) flushSuit = s;

  if (flushSuit) {
    const sf = straightHigh(suitMasks[flushSuit]);
    if (sf) return { score: pack(HandCategory.StraightFlush, [sf]), category: HandCategory.StraightFlush, ranks: [sf] };
  }

  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quads.push(r);
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
    else if (counts[r] === 1) singles.push(r);
  }

  if (quads.length) {
    const q = quads[0];
    const kicker = [...trips, ...pairs, ...singles].filter((r) => r !== q).sort((a, b) => b - a)[0];
    const ranks = [q, kicker];
    return { score: pack(HandCategory.Quads, ranks), category: HandCategory.Quads, ranks };
  }

  if (trips.length && (trips.length > 1 || pairs.length)) {
    const t = trips[0];
    const p = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    const ranks = [t, p];
    return { score: pack(HandCategory.FullHouse, ranks), category: HandCategory.FullHouse, ranks };
  }

  if (flushSuit) {
    const ranks: number[] = [];
    for (let r = 14; r >= 2 && ranks.length < 5; r--) if (suitMasks[flushSuit] & (1 << r)) ranks.push(r);
    return { score: pack(HandCategory.Flush, ranks), category: HandCategory.Flush, ranks };
  }

  const st = straightHigh(rankMask);
  if (st) return { score: pack(HandCategory.Straight, [st]), category: HandCategory.Straight, ranks: [st] };

  if (trips.length) {
    const ranks = [trips[0], ...singles.slice(0, 2)];
    return { score: pack(HandCategory.Trips, ranks), category: HandCategory.Trips, ranks };
  }

  if (pairs.length >= 2) {
    const kicker = [...pairs.slice(2), ...singles].sort((a, b) => b - a)[0];
    const ranks = [pairs[0], pairs[1], kicker];
    return { score: pack(HandCategory.TwoPair, ranks), category: HandCategory.TwoPair, ranks };
  }

  if (pairs.length === 1) {
    const ranks = [pairs[0], ...singles.slice(0, 3)];
    return { score: pack(HandCategory.Pair, ranks), category: HandCategory.Pair, ranks };
  }

  const ranks = singles.slice(0, 5);
  return { score: pack(HandCategory.HighCard, ranks), category: HandCategory.HighCard, ranks };
}

export function describeHand(v: HandValue): string {
  const [a, b] = v.ranks;
  switch (v.category) {
    case HandCategory.StraightFlush:
      return a === 14 ? "Royal flush" : `Straight flush, ${SINGULAR[a]} high`;
    case HandCategory.Quads:
      return `Four of a kind, ${PLURAL[a]}`;
    case HandCategory.FullHouse:
      return `Full house, ${PLURAL[a]} full of ${PLURAL[b]}`;
    case HandCategory.Flush:
      return `Flush, ${SINGULAR[a]} high`;
    case HandCategory.Straight:
      return `Straight, ${SINGULAR[a]} high`;
    case HandCategory.Trips:
      return `Three of a kind, ${PLURAL[a]}`;
    case HandCategory.TwoPair:
      return `Two pair, ${PLURAL[a]} and ${PLURAL[b]}`;
    case HandCategory.Pair:
      return `Pair of ${PLURAL[a]}`;
    default:
      return `${SINGULAR[a]} high`;
  }
}

/* ------------------------------------------------------------- fast scoring */

const SUIT_INDEX: Record<string, number> = { s: 0, h: 1, d: 2, c: 3 };
const counts = new Uint8Array(15);
const suitMasks = new Int32Array(4);
const suitCounts = new Uint8Array(4);
const singles = new Uint8Array(7);
const pairs = new Uint8Array(3);
const trips = new Uint8Array(2);

const packRanks = (category: number, a = 0, b = 0, c = 0, d = 0, e = 0) =>
  ((((category * 16 + a) * 16 + b) * 16 + c) * 16 + d) * 16 + e;

/**
 * Same score as `evaluate(cards).score`, without allocating: the hot path for
 * Monte Carlo equity. Not re-entrant (shared buffers), which is fine in JS.
 */
export function evaluateScore(cards: Card[]): number {
  counts.fill(0);
  suitMasks.fill(0);
  suitCounts.fill(0);
  singles.fill(0);
  pairs.fill(0);
  trips.fill(0);
  let rankMask = 0;
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].rank;
    const s = SUIT_INDEX[cards[i].suit];
    counts[r]++;
    rankMask |= 1 << r;
    suitMasks[s] |= 1 << r;
    suitCounts[s]++;
  }

  let flush = -1;
  for (let s = 0; s < 4; s++) if (suitCounts[s] >= 5) flush = s;
  if (flush >= 0) {
    const sf = straightHigh(suitMasks[flush]);
    if (sf) return packRanks(HandCategory.StraightFlush, sf);
  }

  let quad = 0;
  let nS = 0;
  let nP = 0;
  let nT = 0;
  for (let r = 14; r >= 2; r--) {
    const n = counts[r];
    if (n === 4) quad = r;
    else if (n === 3) trips[nT++] = r;
    else if (n === 2) pairs[nP++] = r;
    else if (n === 1) singles[nS++] = r;
  }

  if (quad) {
    let kicker = 0;
    for (let r = 14; r >= 2; r--) if (r !== quad && counts[r]) { kicker = r; break; }
    return packRanks(HandCategory.Quads, quad, kicker);
  }
  if (nT && (nT > 1 || nP)) {
    return packRanks(HandCategory.FullHouse, trips[0], Math.max(nT > 1 ? trips[1] : 0, nP ? pairs[0] : 0));
  }
  if (flush >= 0) {
    const f = [0, 0, 0, 0, 0];
    let k = 0;
    for (let r = 14; r >= 2 && k < 5; r--) if (suitMasks[flush] & (1 << r)) f[k++] = r;
    return packRanks(HandCategory.Flush, f[0], f[1], f[2], f[3], f[4]);
  }
  const st = straightHigh(rankMask);
  if (st) return packRanks(HandCategory.Straight, st);
  if (nT) return packRanks(HandCategory.Trips, trips[0], singles[0], nS > 1 ? singles[1] : 0);
  if (nP >= 2) {
    const kicker = Math.max(nP > 2 ? pairs[2] : 0, nS ? singles[0] : 0);
    return packRanks(HandCategory.TwoPair, pairs[0], pairs[1], kicker);
  }
  if (nP === 1) return packRanks(HandCategory.Pair, pairs[0], singles[0], singles[1], singles[2]);
  return packRanks(HandCategory.HighCard, singles[0], singles[1], singles[2], singles[3], singles[4]);
}
