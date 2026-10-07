/**
 * Beginner personalities and plain mistakes, which low-level bots fall back on
 * (lib/poker/bot.ts decides how often from the bot's level).
 *
 *   station: calls almost anything, rarely raises ("calling station")
 *   maniac:  raises and shoves constantly, bluffs a lot
 *   nit:     only plays premium hands, folds to pressure without a strong hand
 *   fish:    loose-passive rule follower (the original easy bot, lib/poker/bot.ts)
 */
import { randomInt } from "./cards";
import { type Action, type BotStyle, type GameState, legalActions } from "./engine";
import { evaluateScore } from "./evaluator";
import { CLASS_COMBOS, CLASS_INDEX, COMBOS, N_CLASSES, handClass, scoreCategory } from "./ranges";

const chance = (p: number) => Math.random() < p;

const TOP_SHARE: number[] = (() => {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < N_CLASSES; i++) {
    acc += CLASS_COMBOS[i];
    out.push(acc / COMBOS.length);
  }
  return out;
})();
const inTop = (cls: string, share: number) => TOP_SHARE[CLASS_INDEX[cls]] <= share + 1e-9;

/** 0 = no pair … 2+ = two pair or better, using at least one hole card. */
function madeStrength(s: GameState, hole = s.players[s.toAct!].hole) {
  if (s.board.length < 3) return 0;
  const mine = scoreCategory(evaluateScore([...hole, ...s.board]));
  const board = scoreCategory(evaluateScore(s.board));
  return mine > board ? mine : 0;
}

export function styleAction(s: GameState, style: Exclude<BotStyle, "fish">): Action {
  const legal = legalActions(s)!;
  const me = s.players[s.toAct!];
  const cls = handClass(me.hole);
  const check: Action = { type: "check" };
  const call: Action = legal.canCall ? { type: "call" } : check;
  const fold: Action = legal.canCheck ? check : { type: "fold" };
  const raise = (amount: number): Action =>
    legal.canRaise ? { type: "raise", amount: Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, amount))) } : call;
  const pot = s.players.reduce((a, p) => a + p.committed, 0);
  const made = madeStrength(s);

  switch (style) {
    case "station":
      if (s.street === "preflop") {
        if (inTop(cls, 0.04) && chance(0.5)) return raise(s.currentBet * 3);
        return inTop(cls, 0.85) || legal.toCall <= s.blinds.bb ? call : fold;
      }
      if (made >= 2 && chance(0.3)) return legal.canCheck ? raise(pot * 0.5) : call;
      return made >= 1 || chance(0.6) ? call : fold;

    case "maniac":
      if (chance(0.6)) return chance(0.5) ? raise(legal.maxRaiseTo) : raise(s.currentBet * 3 || pot);
      return chance(0.7) ? call : fold;

    case "nit":
      if (s.street === "preflop") {
        if (inTop(cls, 0.03)) return raise(legal.maxRaiseTo);
        if (inTop(cls, 0.08)) return legal.toCall <= s.blinds.bb * 3 ? raise(s.currentBet * 3) : call;
        return fold;
      }
      if (made >= 2) return legal.canCheck ? raise(pot * 0.6) : call;
      if (made === 1 && legal.toCall <= pot * 0.3) return call;
      return fold;
  }
}

/** A plain blunder: any legal move, often a silly one. */
export function randomAction(s: GameState): Action {
  const legal = legalActions(s)!;
  const r = randomInt(100);
  if (legal.canRaise && r < 25) {
    return { type: "raise", amount: legal.minRaiseTo + randomInt(legal.maxRaiseTo - legal.minRaiseTo + 1) };
  }
  if (r < 60) return legal.canCall ? { type: "call" } : { type: "check" };
  return legal.canCheck ? { type: "check" } : { type: "fold" };
}
