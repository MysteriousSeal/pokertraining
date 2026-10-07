/**
 * How strong each bot level is: win rate of a level-L bot in seat 0 against two
 * other bots (33.3% = break-even). Personalities are random each game.
 *   npx tsx scripts/bot-arena.ts [games per cell]
 */
import { decideBotAction } from "../lib/poker/bot";
import { type Action, type GameState, advance, applyAction, createGame, legalActions, startHand } from "../lib/poker/engine";
import { FORMATS } from "../lib/poker/expresso";

const games = Number(process.argv[2] ?? 500);
const LEVELS = [1, 10, 25, 40, 50, 60, 75, 90, 100];

type Seat0 = { level: number } | { policy: (s: GameState) => Action };
type Opponents = () => [number, number];

function winRate(seat0: Seat0, opponents: Opponents): number {
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const level0 = "level" in seat0 ? seat0.level : 50;
    let s = startHand(createGame(["P", "A", "B"], FORMATS.expresso.startingStack, { heroIndex: -1, botLevels: [level0, ...opponents()] }), 0);
    let clock = 0;
    while (s.phase !== "gameOver" && !s.players[0].out) {
      if (s.phase === "betting") {
        s = applyAction(s, s.toAct === 0 && "policy" in seat0 ? seat0.policy(s) : decideBotAction(s));
        clock += 1.2;
      } else if (s.phase === "handOver") {
        clock += 2;
        s = startHand(s, Math.floor(clock / (FORMATS.expresso.levelMs / 1000)));
      } else {
        s = advance(s);
        clock += 0.8;
      }
    }
    if (s.players[0].place === 1) wins++;
  }
  return wins / games;
}

const randomLevel = () => 1 + Math.floor(Math.random() * 100);
const columns: [string, Opponents][] = [
  ["vs 2 × L1", () => [1, 1]],
  ["vs 2 × L50", () => [50, 50]],
  ["vs 2 × L100", () => [100, 100]],
  ["vs random 1-100", () => [randomLevel(), randomLevel()]],
];
const allIn = (s: GameState): Action => {
  const l = legalActions(s)!;
  return l.canRaise ? { type: "raise", amount: l.maxRaiseTo } : { type: "call" };
};

const t0 = Date.now();
const ci = 1.96 * Math.sqrt(0.25 / games) * 100;
console.log(`${games} games per cell (±${ci.toFixed(1)} points) · 33.3% = break-even\n`);
console.log("seat 0".padEnd(15) + columns.map(([c]) => c.padStart(17)).join(""));
const rows: [string, Seat0][] = [...LEVELS.map((l) => [`level ${l}`, { level: l }] as [string, Seat0]), ["always all-in", { policy: allIn }]];
for (const [name, seat0] of rows) {
  const cells = columns.map(([, opp]) => `${(winRate(seat0, opp) * 100).toFixed(1)}%`.padStart(17));
  console.log(name.padEnd(15) + cells.join(""));
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);
