// Win rate of simple policies in the agent's seat: `npx tsx ai/baseline.ts [games]`
import { decideBotAction } from "../lib/poker/bot";
import { advance, applyAction, createGame, startHand, type GameState } from "../lib/poker/engine";
import { FORMATS } from "../lib/poker/expresso";
import { randomInt } from "../lib/poker/cards";
import { ExpressoEnv } from "./env";
import { actionTable, featurize, N_ACTIONS } from "./agent";

const games = Number(process.argv[2] ?? 2000);

function run(name: string, pick: (mask: boolean[]) => number) {
  const env = new ExpressoEnv();
  let wins = 0, hands = 0, decisions = 0;
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    let r = env.reset();
    while (!r.done) {
      featurize(r.obs!); // include feature cost in timing
      r = env.step(pick(actionTable(r.obs!).mask));
      decisions++;
    }
    if (r.place === 1) wins++;
    hands += r.hands;
  }
  const dt = (Date.now() - t0) / 1000;
  console.log(`${name.padEnd(12)} win ${(100 * wins / games).toFixed(1)}%  ${(hands / games).toFixed(1)} hands/game  ${(decisions / games).toFixed(1)} decisions/game  ${(games / dt).toFixed(0)} games/s`);
}

run("random", (m) => { const ok = m.flatMap((v, i) => (v ? [i] : [])); return ok[randomInt(ok.length)]; });
run("call-only", () => 1);
run("all-in", (m) => (m[5] ? 5 : 1));

// The table bot itself in the agent's seat (uses engine state directly).
{
  let wins = 0;
  for (let g = 0; g < games; g++) {
    let s: GameState = startHand(createGame(["Agent", "A", "B"], FORMATS.expresso.startingStack), 0);
    let clock = 0;
    while (s.phase !== "gameOver" && !s.players[0].out) {
      if (s.phase === "betting") { s = applyAction(s, decideBotAction(s)); clock += 1.2; }
      else if (s.phase === "handOver") { clock += 2; s = startHand(s, Math.floor(clock / 90)); }
      else { s = advance(s); clock += 0.8; }
    }
    if (s.players[0].place === 1) wins++;
  }
  console.log(`${"table bot".padEnd(12)} win ${(100 * wins / games).toFixed(1)}%`);
}
void N_ACTIONS;
