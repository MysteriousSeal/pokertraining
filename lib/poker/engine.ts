import { type Card, fullDeck, shuffle, randomInt } from "./cards";
import { describeHand, evaluate } from "./evaluator";
import { blindsAt, type BlindLevel } from "./expresso";

export type Street = "preflop" | "flop" | "turn" | "river";

/**
 * betting   – waiting for `toAct` to act
 * streetEnd – betting round closed; call `advance` to deal the next street
 * runout    – everyone left is all-in; call `advance` to deal the next street
 * handOver  – pots awarded; call `nextHand`
 * gameOver  – one player holds every chip
 */
export type Phase = "betting" | "streetEnd" | "runout" | "handOver" | "gameOver";

export type ActionType = "fold" | "check" | "call" | "raise";

/** Strength of a computer player: "easy" (lib/poker/bot.ts) or "hard" (lib/poker/botHard.ts). */
export type BotLevel = "easy" | "hard";

/** One action in the current hand, for opponents to read (what a player at the table sees). */
export interface HandAction {
  street: Street;
  player: number;
  type: "fold" | "check" | "call" | "bet" | "raise";
  allIn: boolean;
  /** The player's total bet on this street after the action. */
  to: number;
}

/** What the other players have observed about a player so far this tournament. */
export interface PlayerStats {
  hands: number;
  /** Hands where they put money in preflop voluntarily. */
  vpip: number;
  /** Hands where they raised preflop (all-ins included). */
  raises: number;
  /** Hands where they went all-in preflop as a raise. */
  shoves: number;
}

export interface Action {
  type: ActionType;
  /** For "raise": the total amount the player's bet is raised TO this street. */
  amount?: number;
}

export interface Player {
  id: number;
  name: string;
  isHero: boolean;
  stack: number;
  hole: Card[];
  /** Chips put in on the current street. */
  bet: number;
  /** Chips put in during the whole hand (includes `bet`). */
  committed: number;
  stackAtStart: number;
  folded: boolean;
  allIn: boolean;
  /** Eliminated from the tournament. */
  out: boolean;
  hasActed: boolean;
  /** Faced an incomplete all-in raise after acting: may only call or fold. */
  raiseLocked: boolean;
  lastAction: string | null;
  place: number | null;
  /** null for the human / AI seat. */
  botLevel: BotLevel | null;
  stats: PlayerStats;
}

export interface PotResult {
  amount: number;
  winners: number[];
  handName: string | null;
}

export interface HandResult {
  showdown: boolean;
  pots: PotResult[];
  /** Hand description per player id, for players who showed. */
  hands: Record<number, string>;
  /** Total chips won per player id. */
  won: Record<number, number>;
}

export interface GameState {
  players: Player[];
  dealer: number;
  sbSeat: number;
  bbSeat: number;
  level: number;
  blinds: BlindLevel;
  deck: Card[];
  board: Card[];
  street: Street;
  phase: Phase;
  toAct: number | null;
  currentBet: number;
  minRaise: number;
  handNumber: number;
  /** Last player to raise preflop this hand. */
  preflopAggressor: number | null;
  /** Actions taken so far in this hand. */
  history: HandAction[];
  /** Hole cards are face up (all-in with action closed, or showdown). */
  cardsExposed: boolean;
  result: HandResult | null;
  log: string[];
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  toCall: number;
}

/* ------------------------------------------------------------------ helpers */

const clone = (s: GameState): GameState => ({
  ...s,
  players: s.players.map((p) => ({ ...p, hole: p.hole.slice(), stats: { ...p.stats } })),
  history: s.history.slice(),
  deck: s.deck.slice(),
  board: s.board.slice(),
  log: s.log.slice(),
});

function nextSeat(s: GameState, from: number, pred: (p: Player) => boolean): number {
  const n = s.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (pred(s.players[idx])) return idx;
  }
  return -1;
}

const alive = (p: Player) => !p.out;
const inHand = (p: Player) => !p.out && !p.folded;
const canAct = (p: Player) => !p.out && !p.folded && !p.allIn;

export const potTotal = (s: GameState) => s.players.reduce((sum, p) => sum + p.committed, 0);
/** Chips already gathered in the middle (excludes bets still in front of players). */
export const collectedPot = (s: GameState) => s.players.reduce((sum, p) => sum + p.committed - p.bet, 0);

function putIn(p: Player, amount: number) {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.bet += a;
  p.committed += a;
  if (p.stack === 0) p.allIn = true;
  return a;
}

function log(s: GameState, line: string) {
  s.log.push(line);
  if (s.log.length > 60) s.log.shift();
}

/* --------------------------------------------------------------- lifecycle */

export interface GameOptions {
  heroIndex?: number;
  /** Bot level per seat (the hero's entry is ignored). Defaults to "easy". */
  botLevels?: (BotLevel | null)[];
}

export function createGame(names: string[], startingStack: number, { heroIndex = 0, botLevels = [] }: GameOptions = {}): GameState {
  const players: Player[] = names.map((name, id) => ({
    id,
    name,
    isHero: id === heroIndex,
    stack: startingStack,
    hole: [],
    bet: 0,
    committed: 0,
    stackAtStart: startingStack,
    folded: false,
    allIn: false,
    out: false,
    hasActed: false,
    raiseLocked: false,
    lastAction: null,
    place: null,
    botLevel: id === heroIndex ? null : (botLevels[id] ?? "easy"),
    stats: { hands: 0, vpip: 0, raises: 0, shoves: 0 },
  }));
  return {
    players,
    // startHand moves the button one seat, so the first button lands on a random seat.
    dealer: randomInt(players.length),
    sbSeat: -1,
    bbSeat: -1,
    level: 0,
    blinds: blindsAt(0),
    deck: [],
    board: [],
    street: "preflop",
    phase: "handOver",
    toAct: null,
    currentBet: 0,
    minRaise: 0,
    handNumber: 0,
    preflopAggressor: null,
    history: [],
    cardsExposed: false,
    result: null,
    log: [],
  };
}

export function startHand(prev: GameState, level: number): GameState {
  const s = clone(prev);
  s.level = level;
  s.blinds = blindsAt(level);
  s.handNumber += 1;
  s.board = [];
  s.street = "preflop";
  s.result = null;
  s.preflopAggressor = null;
  s.history = [];
  s.cardsExposed = false;
  s.deck = shuffle(fullDeck());

  for (const p of s.players) {
    p.hole = [];
    p.bet = 0;
    p.committed = 0;
    p.stackAtStart = p.stack;
    p.folded = p.out;
    p.allIn = false;
    p.hasActed = false;
    p.raiseLocked = false;
    p.lastAction = null;
    if (!p.out) p.stats.hands++;
  }

  s.dealer = nextSeat(s, s.dealer, alive);
  const headsUp = s.players.filter(alive).length === 2;
  if (headsUp) {
    s.sbSeat = s.dealer;
    s.bbSeat = nextSeat(s, s.dealer, alive);
  } else {
    s.sbSeat = nextSeat(s, s.dealer, alive);
    s.bbSeat = nextSeat(s, s.sbSeat, alive);
  }

  log(s, `— Hand #${s.handNumber} · Blinds ${s.blinds.sb}/${s.blinds.bb} —`);

  const sb = s.players[s.sbSeat];
  const bb = s.players[s.bbSeat];
  putIn(sb, s.blinds.sb);
  putIn(bb, s.blinds.bb);
  sb.lastAction = "SB";
  bb.lastAction = "BB";
  log(s, `${sb.name} posts SB ${sb.bet}`);
  log(s, `${bb.name} posts BB ${bb.bet}`);

  s.currentBet = s.blinds.bb;
  s.minRaise = s.blinds.bb;

  // Deal two cards each, one at a time starting left of the button.
  const order: number[] = [];
  let seat = s.dealer;
  for (let i = 0; i < s.players.filter(alive).length; i++) {
    seat = nextSeat(s, seat, alive);
    order.push(seat);
  }
  for (let round = 0; round < 2; round++) for (const i of order) s.players[i].hole.push(s.deck.pop()!);

  s.phase = "betting";
  const first = headsUp ? s.sbSeat : nextSeat(s, s.bbSeat, alive);
  s.toAct = canAct(s.players[first]) ? first : nextSeat(s, first, canAct);
  if (s.toAct === -1 || roundComplete(s)) {
    s.toAct = null;
    s.phase = "streetEnd";
  }
  return s;
}

/* ----------------------------------------------------------------- betting */

export function legalActions(s: GameState): LegalActions | null {
  if (s.phase !== "betting" || s.toAct === null) return null;
  const p = s.players[s.toAct];
  const toCall = Math.max(0, s.currentBet - p.bet);
  const othersCanRespond = s.players.some((o) => o.id !== p.id && canAct(o));
  const maxRaiseTo = p.bet + p.stack;
  const minRaiseTo = Math.min(s.currentBet + s.minRaise, maxRaiseTo);
  return {
    canFold: toCall > 0,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: Math.min(toCall, p.stack),
    canRaise: !p.raiseLocked && othersCanRespond && p.stack > toCall,
    minRaiseTo,
    maxRaiseTo,
    toCall,
  };
}

function roundComplete(s: GameState): boolean {
  const actors = s.players.filter(canAct);
  if (actors.length === 0) return true;
  if (actors.length === 1 && s.players.filter(inHand).length > 1) {
    // Nobody left to bet against: done once this player has matched the bet.
    return actors[0].bet >= s.currentBet;
  }
  return actors.every((p) => p.hasActed && p.bet === s.currentBet);
}

export function applyAction(prev: GameState, action: Action): GameState {
  const legal = legalActions(prev);
  if (!legal) return prev;
  const s = clone(prev);
  const p = s.players[s.toAct!];

  let type = action.type;
  if (type === "fold" && legal.canCheck) type = "check";
  if (type === "check" && !legal.canCheck) type = "call";
  if (type === "call" && !legal.canCall) type = "check";
  if (type === "raise" && !legal.canRaise) type = legal.canCall ? "call" : "check";

  switch (type) {
    case "fold":
      p.folded = true;
      p.lastAction = "Fold";
      log(s, `${p.name} folds`);
      break;
    case "check":
      p.lastAction = "Check";
      log(s, `${p.name} checks`);
      break;
    case "call": {
      putIn(p, legal.toCall);
      p.lastAction = p.allIn ? "All-in" : "Call";
      log(s, `${p.name} calls ${p.bet}${p.allIn ? " (all-in)" : ""}`);
      break;
    }
    case "raise": {
      const target = Math.max(legal.minRaiseTo, Math.min(action.amount ?? legal.minRaiseTo, legal.maxRaiseTo));
      const wasBet = s.currentBet === 0;
      putIn(p, target - p.bet);
      const increase = p.bet - s.currentBet;
      if (increase >= s.minRaise) {
        s.minRaise = increase;
        for (const o of s.players) if (o.id !== p.id && canAct(o)) {
          o.hasActed = false;
          o.raiseLocked = false;
        }
      } else {
        // Incomplete all-in raise: does not reopen the betting for players who already acted.
        for (const o of s.players) if (o.id !== p.id && canAct(o) && o.hasActed) {
          o.hasActed = false;
          o.raiseLocked = true;
        }
      }
      s.currentBet = p.bet;
      if (s.street === "preflop") s.preflopAggressor = p.id;
      p.lastAction = p.allIn ? "All-in" : wasBet ? "Bet" : "Raise";
      log(s, `${p.name} ${p.allIn ? "goes all-in for" : wasBet ? "bets" : "raises to"} ${p.bet}`);
      break;
    }
  }
  p.hasActed = true;
  record(s, p, type);

  const remaining = s.players.filter(inHand);
  if (remaining.length === 1) return awardUncontested(s, remaining[0]);

  if (roundComplete(s)) {
    s.toAct = null;
    s.phase = "streetEnd";
  } else {
    s.toAct = nextSeat(s, s.toAct!, (o) => canAct(o) && !(o.hasActed && o.bet === s.currentBet));
  }
  return s;
}

function record(s: GameState, p: Player, type: ActionType) {
  const kind: HandAction["type"] = type === "raise" ? (s.history.some((h) => h.street === s.street && (h.type === "bet" || h.type === "raise")) || s.street === "preflop" ? "raise" : "bet") : type;
  if (s.street === "preflop" && (type === "call" || type === "raise")) {
    const mine = s.history.filter((h) => h.street === "preflop" && h.player === p.id);
    if (!mine.some((h) => h.type === "call" || h.type === "raise")) p.stats.vpip++;
    if (type === "raise" && !mine.some((h) => h.type === "raise")) {
      p.stats.raises++;
      if (p.allIn) p.stats.shoves++;
    }
  }
  s.history.push({ street: s.street, player: p.id, type: kind, allIn: p.allIn, to: p.bet });
}

function returnUncalled(s: GameState) {
  const sorted = s.players.slice().sort((a, b) => b.bet - a.bet);
  const [top, second] = sorted;
  const excess = top.bet - (second?.bet ?? 0);
  if (excess > 0) {
    top.bet -= excess;
    top.committed -= excess;
    top.stack += excess;
    if (top.stack > 0) top.allIn = false;
    log(s, `Uncalled ${excess} returned to ${top.name}`);
  }
}

function awardUncontested(s: GameState, winner: Player): GameState {
  returnUncalled(s);
  const amount = potTotal(s);
  winner.stack += amount;
  log(s, `${winner.name} wins ${amount}`);
  s.result = {
    showdown: false,
    pots: [{ amount, winners: [winner.id], handName: null }],
    hands: {},
    won: { [winner.id]: amount },
  };
  s.toAct = null;
  s.phase = "handOver";
  return finishHand(s);
}

/* ------------------------------------------------------------ street flow */

/** Close the current street and deal the next one (or go to showdown). */
export function advance(prev: GameState): GameState {
  if (prev.phase !== "streetEnd" && prev.phase !== "runout") return prev;
  const s = clone(prev);
  returnUncalled(s);
  for (const p of s.players) {
    p.bet = 0;
    p.hasActed = false;
    p.raiseLocked = false;
    if (!p.folded && !p.allIn) p.lastAction = null;
  }
  s.currentBet = 0;
  s.minRaise = s.blinds.bb;

  if (s.street === "river") return showdown(s);

  s.deck.pop(); // burn
  if (s.street === "preflop") {
    s.street = "flop";
    s.board.push(s.deck.pop()!, s.deck.pop()!, s.deck.pop()!);
  } else {
    s.street = s.street === "flop" ? "turn" : "river";
    s.board.push(s.deck.pop()!);
  }
  log(s, `${s.street[0].toUpperCase()}${s.street.slice(1)}: ${s.board.map(cardText).join(" ")}`);

  if (s.players.filter(canAct).length <= 1) {
    s.cardsExposed = true;
    s.phase = "runout";
    s.toAct = null;
  } else {
    s.phase = "betting";
    s.toAct = nextSeat(s, s.dealer, canAct);
  }
  return s;
}

function cardText(c: Card) {
  const r = ({ 10: "T", 11: "J", 12: "Q", 13: "K", 14: "A" } as Record<number, string>)[c.rank] ?? String(c.rank);
  return r + ({ s: "♠", h: "♥", d: "♦", c: "♣" } as const)[c.suit];
}

function showdown(s: GameState): GameState {
  s.cardsExposed = true;
  const contenders = s.players.filter(inHand);
  const values = new Map(contenders.map((p) => [p.id, evaluate([...p.hole, ...s.board])]));

  // Build main pot + side pots from each player's total contribution.
  const contrib = new Map(s.players.map((p) => [p.id, p.committed]));
  const pots: { amount: number; eligible: number[] }[] = [];
  while (contenders.some((p) => contrib.get(p.id)! > 0)) {
    const eligible = contenders.filter((p) => contrib.get(p.id)! > 0).map((p) => p.id);
    const level = Math.min(...eligible.map((id) => contrib.get(id)!));
    let amount = 0;
    for (const p of s.players) {
      const take = Math.min(contrib.get(p.id)!, level);
      amount += take;
      contrib.set(p.id, contrib.get(p.id)! - take);
    }
    // Merge layers with identical eligibility (e.g. a folded player's partial contribution).
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  // Dead money from folded players above every contender's contribution.
  const leftover = [...contrib.values()].reduce((a, b) => a + b, 0);
  if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;

  const result: HandResult = { showdown: true, pots: [], hands: {}, won: {} };
  for (const p of contenders) result.hands[p.id] = describeHand(values.get(p.id)!);

  for (const pot of pots) {
    const best = Math.max(...pot.eligible.map((id) => values.get(id)!.score));
    const winners = pot.eligible.filter((id) => values.get(id)!.score === best);
    // Odd chips go to the first winner left of the button.
    const ordered: number[] = [];
    let seat = s.dealer;
    for (let i = 0; i < s.players.length; i++) {
      seat = (seat + 1) % s.players.length;
      if (winners.includes(seat)) ordered.push(seat);
    }
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const id of ordered) {
      const amt = share + (odd-- > 0 ? 1 : 0);
      s.players[id].stack += amt;
      result.won[id] = (result.won[id] ?? 0) + amt;
    }
    result.pots.push({ amount: pot.amount, winners: ordered, handName: describeHand(values.get(ordered[0])!) });
    log(s, `${ordered.map((id) => s.players[id].name).join(" & ")} win${ordered.length > 1 ? "" : "s"} ${pot.amount} with ${describeHand(values.get(ordered[0])!)}`);
  }

  s.result = result;
  s.toAct = null;
  s.phase = "handOver";
  return finishHand(s);
}

function finishHand(s: GameState): GameState {
  const busted = s.players.filter((p) => !p.out && p.stack === 0);
  if (busted.length) {
    const remaining = s.players.filter((p) => !p.out).length;
    // Bigger starting stack finishes higher when several bust on the same hand.
    busted.sort((a, b) => a.stackAtStart - b.stackAtStart);
    busted.forEach((p, i) => {
      p.out = true;
      p.place = remaining - i;
      p.lastAction = null;
      log(s, `${p.name} is eliminated (${ordinal(p.place)})`);
    });
  }
  const left = s.players.filter((p) => !p.out);
  if (left.length === 1) {
    left[0].place = 1;
    s.phase = "gameOver";
    log(s, `${left[0].name} wins the tournament!`);
  }
  return s;
}

export function ordinal(n: number) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}
