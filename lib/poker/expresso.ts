import { randomInt } from "./cards";

/**
 * Winamax Expresso format, from https://www.winamax.fr/expresso (checked 2026-10-07):
 * 3 players, starting blinds 10-20, prize pool = buy-in × a multiplier drawn before the game.
 */

export type FormatId = "expresso" | "nitro";

export interface Format {
  id: FormatId;
  name: string;
  startingStack: number;
  levelMs: number;
}

export const FORMATS: Record<FormatId, Format> = {
  expresso: { id: "expresso", name: "Expresso", startingStack: 500, levelMs: 90_000 },
  nitro: { id: "nitro", name: "Expresso Nitro", startingStack: 300, levelMs: 60_000 },
};

export interface BlindLevel {
  sb: number;
  bb: number;
}

/**
 * Level 1 (10/20) is the only level Winamax publishes. The rest is a typical
 * hyper-turbo progression: replace it with the schedule from the Winamax client
 * (tournament lobby → Structure) to match it exactly.
 */
export const BLIND_LEVELS: BlindLevel[] = [
  { sb: 10, bb: 20 },
  { sb: 15, bb: 30 },
  { sb: 20, bb: 40 },
  { sb: 25, bb: 50 },
  { sb: 30, bb: 60 },
  { sb: 40, bb: 80 },
  { sb: 50, bb: 100 },
  { sb: 60, bb: 120 },
  { sb: 80, bb: 160 },
  { sb: 100, bb: 200 },
  { sb: 125, bb: 250 },
  { sb: 150, bb: 300 },
  { sb: 200, bb: 400 },
  { sb: 250, bb: 500 },
  { sb: 300, bb: 600 },
  { sb: 400, bb: 800 },
];

export function blindsAt(level: number): BlindLevel {
  return BLIND_LEVELS[Math.min(level, BLIND_LEVELS.length - 1)];
}

export const BUY_INS = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500];

interface MultiplierTable {
  /** Probabilities are `weight / outOf`. */
  outOf: number;
  /** [multiplier, weight] from smallest to biggest. */
  tiers: [number, number][];
}

/** Official Winamax multiplier draw per buy-in. */
export const MULTIPLIER_TABLES: Record<string, MultiplierTable> = {
  "0.25": { outOf: 10_000_000, tiers: [[2, 5363694], [3, 3324204], [4, 800000], [5, 400000], [10, 100000], [20, 10000], [100, 2000], [1000, 100], [100000, 2]] },
  "0.5": { outOf: 10_000_000, tiers: [[2, 5363694], [3, 3324204], [4, 800000], [5, 400000], [10, 100000], [20, 10000], [100, 2000], [1000, 100], [100000, 2]] },
  "1": { outOf: 10_000_000, tiers: [[2, 5313688], [3, 3324208], [4, 850000], [5, 400000], [10, 100000], [20, 10000], [100, 2000], [1000, 100], [100000, 4]] },
  "2": { outOf: 10_000_000, tiers: [[2, 5363697], [3, 3324202], [4, 800000], [5, 400000], [10, 100000], [20, 10000], [100, 2000], [1000, 100], [500000, 1]] },
  "5": { outOf: 10_000_000, tiers: [[2, 5248697], [3, 3334202], [4, 900000], [5, 400000], [10, 100000], [20, 15000], [100, 2000], [1000, 100], [200000, 1]] },
  "10": { outOf: 10_000_000, tiers: [[2, 5248694], [3, 3334204], [4, 900000], [5, 400000], [10, 100000], [20, 15000], [100, 2000], [1000, 100], [100000, 2]] },
  "25": { outOf: 10_000_000, tiers: [[2, 5248685], [3, 3334210], [4, 900000], [5, 400000], [10, 100000], [20, 15000], [100, 2000], [1000, 100], [40000, 5]] },
  "50": { outOf: 10_000_000, tiers: [[2, 5248670], [3, 3334220], [4, 900000], [5, 400000], [10, 100000], [20, 15000], [100, 2000], [1000, 100], [20000, 10]] },
  "100": { outOf: 10_000_000, tiers: [[2, 5248640], [3, 3334240], [4, 900000], [5, 400000], [10, 100000], [20, 15000], [100, 2000], [1000, 100], [10000, 20]] },
  "250": { outOf: 1_000_000, tiers: [[2, 520813], [3, 337458], [4, 90000], [5, 40000], [10, 10000], [20, 1500], [100, 200], [400, 25], [4000, 4]] },
  "500": { outOf: 1_000_000, tiers: [[2, 520813], [3, 337458], [4, 90000], [5, 40000], [10, 10000], [20, 1500], [100, 200], [400, 25], [4000, 4]] },
};

export interface MultiplierTier {
  multiplier: number;
  weight: number;
  outOf: number;
  /** Share of the prize pool for 1st, 2nd, 3rd. */
  payouts: [number, number, number];
}

/** Jackpots of 50× the buy-in or more are shared 80 / 12 / 8 %; below that the winner takes all. */
function payoutsFor(multiplier: number): [number, number, number] {
  return multiplier >= 50 ? [0.8, 0.12, 0.08] : [1, 0, 0];
}

export function multiplierTiers(buyIn: number): MultiplierTier[] {
  const table = MULTIPLIER_TABLES[String(buyIn)] ?? MULTIPLIER_TABLES["1"];
  return table.tiers.map(([multiplier, weight]) => ({ multiplier, weight, outOf: table.outOf, payouts: payoutsFor(multiplier) }));
}

export function drawMultiplier(buyIn: number): MultiplierTier {
  const tiers = multiplierTiers(buyIn);
  let roll = randomInt(tiers[0].outOf);
  for (const t of tiers) {
    if (roll < t.weight) return t;
    roll -= t.weight;
  }
  return tiers[0];
}

export function maxJackpot(buyIn: number): number {
  const tiers = multiplierTiers(buyIn);
  return buyIn * tiers[tiers.length - 1].multiplier;
}

/** Colour band for a multiplier badge. */
export function multiplierClass(m: number): string {
  if (m <= 2) return "mult-a";
  if (m === 3) return "mult-b";
  if (m <= 5) return "mult-c";
  if (m <= 20) return "mult-d";
  if (m <= 100) return "mult-e";
  if (m <= 1000) return "mult-f";
  return "mult-g";
}

export function formatMoney(value: number): string {
  return value.toLocaleString("en-GB", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: value % 1 === 0 && value >= 10 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
