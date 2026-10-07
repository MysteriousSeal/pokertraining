/**
 * Line-delimited JSON bridge between the Python trainer and the TypeScript game.
 *
 *   {"cmd":"init","n":64,"levels":[1,100]} -> start n simulated games; bots get random levels in that range
 *   {"cmd":"step","actions":[...]}   -> one action per game; finished games restart automatically
 *   {"cmd":"featurize","obs":{...}}  -> features for an observation read from the browser
 *
 * Replies: {"x":[[...]],"mask":[[...]],"reward":[...],"done":[...],"place":[...]}
 */
import { createInterface } from "node:readline";
import { EQUITY_ITERATIONS, N_ACTIONS, type Observation, actionTable, featurize } from "./agent";
import { ExpressoEnv, type LevelRange, type StepResult } from "./env";

let envs: ExpressoEnv[] = [];

function encode(results: StepResult[]) {
  const x: number[][] = [];
  const mask: boolean[][] = [];
  for (const r of results) {
    // A finished game was already restarted; `next` holds its first decision.
    const obs = r.obs!;
    x.push(featurize(obs).map((v) => Math.round(v * 1e4) / 1e4));
    mask.push(actionTable(obs).mask);
  }
  return { x, mask };
}

function handle(msg: { cmd: string; [k: string]: unknown }) {
  switch (msg.cmd) {
    case "init": {
      envs = Array.from({ length: msg.n as number }, () => new ExpressoEnv((msg.levels as LevelRange) ?? [1, 100]));
      const results = envs.map((e) => e.reset());
      return { ...encode(results), n_actions: N_ACTIONS };
    }
    case "step": {
      const actions = msg.actions as number[];
      const reward: number[] = [];
      const done: boolean[] = [];
      const place: (number | null)[] = [];
      const hands: number[] = [];
      const results = envs.map((env, i) => {
        let r = env.step(actions[i]);
        reward.push(Math.round(r.reward * 1e5) / 1e5);
        done.push(r.done);
        place.push(r.place);
        hands.push(r.hands);
        if (r.done) r = env.reset();
        return r;
      });
      return { ...encode(results), reward, done, place, hands };
    }
    case "featurize": {
      const obs = msg.obs as Observation;
      const { actions, mask } = actionTable(obs);
      return { x: featurize(obs, EQUITY_ITERATIONS.play), mask, actions };
    }
    default:
      return { error: `unknown cmd ${msg.cmd}` };
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let reply: unknown;
  try {
    reply = handle(JSON.parse(line));
  } catch (e) {
    reply = { error: String((e as Error).stack ?? e) };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
});
