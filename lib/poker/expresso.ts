import { randomInt } from "./cards";

/**
 * Expresso-style format: 3 players, 500 starting chips, hyper-turbo blinds,
 * prize pool = buy-in × a multiplier drawn before the game starts.
 *
 * The multiplier odds and payout splits below are an approximation of the
 * real Winamax tables (which vary per buy-in); tune them here.
 */

export const STARTING_STACK = 500;
export const LEVEL_DURATION_MS = 3 * 60 * 1000;

export interface BlindLevel {
  sb: number;
  bb: number;
}

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

export const BUY_INS = [0.25, 1, 2, 5, 10, 25, 50, 100, 250];

export interface MultiplierTier {
  multiplier: number;
  /** Chance out of 1,000,000. */
  weight: number;
  /** Share of the prize pool for 1st, 2nd, 3rd. */
  payouts: [number, number, number];
}

export const MULTIPLIERS: MultiplierTier[] = [
  { multiplier: 2, weight: 750_000, payouts: [1, 0, 0] },
  { multiplier: 3, weight: 160_000, payouts: [1, 0, 0] },
  { multiplier: 5, weight: 65_000, payouts: [1, 0, 0] },
  { multiplier: 10, weight: 20_000, payouts: [1, 0, 0] },
  { multiplier: 100, weight: 4_000, payouts: [0.8, 0.1, 0.1] },
  { multiplier: 1000, weight: 900, payouts: [0.8, 0.1, 0.1] },
  { multiplier: 10000, weight: 100, payouts: [0.8, 0.1, 0.1] },
];

export function drawMultiplier(): MultiplierTier {
  const total = MULTIPLIERS.reduce((s, m) => s + m.weight, 0);
  let roll = randomInt(total);
  for (const m of MULTIPLIERS) {
    if (roll < m.weight) return m;
    roll -= m.weight;
  }
  return MULTIPLIERS[0];
}

export function formatMoney(value: number): string {
  return value.toLocaleString("en-GB", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: value % 1 === 0 && value >= 10 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
