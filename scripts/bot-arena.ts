/**
 * Win rates of a player in seat 0 against two bots, for each bot level.
 *   npx tsx scripts/bot-arena.ts [games]
 */
import { decideEasyBotAction, decideBotAction } from "../lib/poker/bot";
import { decideHardBotAction } from "../lib/poker/botHard";
import { type Action, type BotLevel, type GameState, advance, applyAction, createGame, legalActions, startHand } from "../lib/poker/engine";
import { FORMATS } from "../lib/poker/expresso";

const games = Number(process.argv[2] ?? 2000);
type Policy = (s: GameState) => Action;

const allIn: Policy = (s) => {
  const l = legalActions(s)!;
  return l.canRaise ? { type: "raise", amount: l.maxRaiseTo } : { type: "call" };
};
const random: Policy = (s) => {
  const l = legalActions(s)!;
  const r = Math.random();
  if (r < 0.3) return { type: "fold" };
  if (r < 0.7 || !l.canRaise) return { type: "call" };
  return { type: "raise", amount: l.minRaiseTo + Math.random() * (l.maxRaiseTo - l.minRaiseTo) };
};

function winRate(hero: Policy, opponents: [BotLevel, BotLevel]): number {
  let wins = 0;
  for (let g = 0; g < games; g++) {
    let s = startHand(createGame(["P", "A", "B"], FORMATS.expresso.startingStack, { botLevels: [null, ...opponents] }), 0);
    let clock = 0;
    while (s.phase !== "gameOver" && !s.players[0].out) {
      if (s.phase === "betting") {
        s = applyAction(s, s.toAct === 0 ? hero(s) : decideBotAction(s));
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

const rows: [string, Policy][] = [
  ["easy bot", decideEasyBotAction],
  ["hard bot", decideHardBotAction],
  ["always all-in", allIn],
  ["random", random],
];
const t0 = Date.now();
console.log(`${games} games per cell · 33.3% = break-even\n`);
console.log("seat 0 plays…".padEnd(16) + "vs 2 easy".padStart(11) + "vs 2 hard".padStart(11) + "vs easy+hard".padStart(14));
for (const [name, policy] of rows) {
  const cells = (
    [
      ["easy", "easy"],
      ["hard", "hard"],
      ["easy", "hard"],
    ] as [BotLevel, BotLevel][]
  ).map((o) => winRate(policy, o));
  const ci = 1.96 * Math.sqrt(0.25 / games) * 100;
  console.log(name.padEnd(16) + cells.map((c, i) => `${(c * 100).toFixed(1)}%`.padStart(i === 2 ? 14 : 11)).join("") + `   (±${ci.toFixed(1)})`);
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);
