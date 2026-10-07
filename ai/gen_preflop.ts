// Precompute preflop equity of all 169 starting hands vs 1 and 2 random hands.
// Run once: `npx tsx ai/gen_preflop.ts`
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Rank } from "../lib/poker/cards";
import { estimateEquity } from "../lib/poker/bot";
import { handClass } from "./agent";

const ITER = 6000;
const table: Record<string, [number, number]> = {};
for (let hi = 2; hi <= 14; hi++) {
  for (let lo = 2; lo <= hi; lo++) {
    const variants: Card[][] =
      hi === lo
        ? [[{ rank: hi as Rank, suit: "s" }, { rank: lo as Rank, suit: "h" }]]
        : [
            [{ rank: hi as Rank, suit: "s" }, { rank: lo as Rank, suit: "s" }],
            [{ rank: hi as Rank, suit: "s" }, { rank: lo as Rank, suit: "h" }],
          ];
    for (const hole of variants) {
      const r = (x: number) => Math.round(x * 10000) / 10000;
      table[handClass(hole)] = [r(estimateEquity(hole, [], 1, ITER)), r(estimateEquity(hole, [], 2, ITER))];
    }
  }
}
writeFileSync(join(__dirname, "preflop_equity.json"), JSON.stringify(table));
console.log(`${Object.keys(table).length} hands · AA ${table.AA} · 72o ${table["72o"]}`);
