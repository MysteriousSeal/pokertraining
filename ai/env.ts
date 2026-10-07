/**
 * Headless Expresso against the two real table bots, from the agent's seat.
 * Same engine and bot code as the browser game; a game clock replays the
 * table's pacing so blind levels rise at the same rate as on screen.
 */
import { type GameState, advance, applyAction, createGame, startHand } from "../lib/poker/engine";
import { decideBotAction } from "../lib/poker/bot";
import { FORMATS } from "../lib/poker/expresso";
import { type Observation, actionTable, observe } from "./agent";

const FORMAT = FORMATS.expresso;
const TOTAL_CHIPS = FORMAT.startingStack * 3;
const HERO = 0;

/** Seconds of table time each event takes in the browser (see hooks/useExpressoGame.ts). */
const CLOCK = { bot: 1.25, hero: 1.0, streetEnd: 0.65, runout: 1.3, handOverFold: 1.4, handOverShowdown: 3.2 };

/** Bonus / penalty on top of the per-hand chip reward. */
export const REWARD = { win: 1.0, lose: -0.5 };

export interface StepResult {
  obs: Observation | null;
  reward: number;
  done: boolean;
  /** Finishing place when done. */
  place: number | null;
  hands: number;
}

export class ExpressoEnv {
  private s!: GameState;
  private clock = 0;
  private settled = 0;

  reset(): StepResult {
    this.clock = 0;
    this.s = startHand(createGame(["Agent", "Bot A", "Bot B"], FORMAT.startingStack), 0);
    this.settled = FORMAT.startingStack;
    return this.runUntilDecision(0);
  }

  step(actionIndex: number): StepResult {
    const obs = observe(this.s, HERO);
    const { actions, mask } = actionTable(obs);
    const a = mask[actionIndex] ? actions[actionIndex] : actions[1];
    this.s = applyAction(this.s, a);
    this.clock += CLOCK.hero;
    return this.runUntilDecision(0);
  }

  private level() {
    return Math.floor(this.clock / (FORMAT.levelMs / 1000));
  }

  private runUntilDecision(reward: number): StepResult {
    for (;;) {
      const s = this.s;
      switch (s.phase) {
        case "betting":
          if (s.toAct === HERO) return { obs: observe(s, HERO), reward, done: false, place: null, hands: s.handNumber };
          this.s = applyAction(s, decideBotAction(s));
          this.clock += CLOCK.bot;
          break;
        case "streetEnd":
          this.s = advance(s);
          this.clock += CLOCK.streetEnd;
          break;
        case "runout":
          this.s = advance(s);
          this.clock += CLOCK.runout;
          break;
        case "handOver":
        case "gameOver": {
          const hero = s.players[HERO];
          reward += (hero.stack - this.settled) / TOTAL_CHIPS;
          this.settled = hero.stack;
          if (hero.out || s.phase === "gameOver") {
            const place = hero.place ?? 1;
            reward += place === 1 ? REWARD.win : REWARD.lose;
            return { obs: null, reward, done: true, place, hands: s.handNumber };
          }
          this.clock += s.result?.showdown ? CLOCK.handOverShowdown : CLOCK.handOverFold;
          this.s = startHand(s, this.level());
          break;
        }
      }
    }
  }
}
