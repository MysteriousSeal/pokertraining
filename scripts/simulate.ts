// Bot-vs-bot stress test: run with `npx tsx scripts/simulate.ts [games]`
import { advance, applyAction, createGame, startHand, type GameState } from "../lib/poker/engine";
import { decideBotAction } from "../lib/poker/bot";
import { evaluate, describeHand } from "../lib/poker/evaluator";
import type { Card } from "../lib/poker/cards";

const c = (s: string): Card => {
  const r = "23456789TJQKA".indexOf(s[0]) + 2;
  return { rank: r as Card["rank"], suit: s[1] as Card["suit"] };
};
const hand = (s: string) => s.split(" ").map(c);
const checks: [string, string][] = [
  ["Ah Kh Qh Jh Th 2c 3d", "Royal flush"],
  ["As 2d 3h 4c 5s Kd Kc", "Straight, Five high"],
  ["Ks Kd Kh 2c 2s 2d 9h", "Full house, Kings full of Twos"],
  ["7s 7d 4h 4c 2s 2d Ah", "Two pair, Sevens and Fours"],
  ["9h 8h 2h 3h Kh 9d 9c", "Flush, King high"],
];
for (const [h, want] of checks) {
  const got = describeHand(evaluate(hand(h)));
  if (got !== want) throw new Error(`eval ${h}: got ${got}, want ${want}`);
}
// Two pair kicker: third pair must not beat a higher single.
if (evaluate(hand("Ah Ad Kc Ks 2c 2d Qh")).ranks[2] !== 12) throw new Error("two pair kicker");

const games = Number(process.argv[2] ?? 2000);
const TOTAL = 1500;
let hands = 0;
const wins = [0, 0, 0];
for (let g = 0; g < games; g++) {
  let s: GameState = createGame(["A", "B", "C"]);
  let level = 0;
  let guard = 0;
  while (s.phase !== "gameOver") {
    if (++guard > 100000) throw new Error("stuck");
    if (s.phase === "handOver") {
      hands++;
      if (s.handNumber % 6 === 0) level++;
      s = startHand(s, level);
    } else if (s.phase === "betting") s = applyAction(s, decideBotAction(s));
    else s = advance(s);
    const chips = s.players.reduce((a, p) => a + p.stack + p.committed, 0);
    const settled = s.phase === "handOver" || s.phase === "gameOver";
    const sum = settled ? s.players.reduce((a, p) => a + p.stack, 0) : chips;
    if (sum !== TOTAL) throw new Error(`chips ${sum} in phase ${s.phase}\n${s.log.join("\n")}`);
    if (s.players.some((p) => p.stack < 0)) throw new Error("negative stack");
  }
  const places = s.players.map((p) => p.place).sort();
  if (places.join() !== "1,2,3") throw new Error(`places ${places}`);
  wins[s.players.find((p) => p.place === 1)!.id]++;
}
console.log(`OK: ${games} games, ${hands} hands, avg ${(hands / games).toFixed(1)} hands/game, wins ${wins}`);

// Deterministic side pot: A (100) has the best hand, B (300) second, C (300) worst.
{
  let s = createGame(["A", "B", "C"]);
  s.players[0].stack = 100; s.players[1].stack = 300; s.players[2].stack = 300;
  s.dealer = 2; // button moves to A
  s = startHand(s, 0);
  const hole: Record<number, string> = { 0: "Ah Ad", 1: "Kh Kd", 2: "Qh Qd" };
  s.players.forEach((p) => (p.hole = hand(hole[p.id])));
  // Board 2c 7s 9d Jc 3s, dealt by pop() after one burn per street.
  s.deck = hand("3s 4c Jc 5c 9d 7s 2c 6c").concat([]);
  while (s.phase === "betting") s = applyAction(s, { type: "raise", amount: 10_000 });
  while (s.phase !== "handOver" && s.phase !== "gameOver") s = advance(s);
  const stacks = s.players.map((p) => p.stack).join();
  if (stacks !== "300,400,0") throw new Error(`side pot stacks ${stacks}\n${s.log.join("\n")}`);
  if (s.players[2].place !== 3) throw new Error("C should be 3rd");
  console.log("OK: side pots", stacks);
}
