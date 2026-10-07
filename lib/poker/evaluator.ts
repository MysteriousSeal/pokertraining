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
