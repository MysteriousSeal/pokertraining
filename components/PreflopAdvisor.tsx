"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ACTIONS, EQUITY_FEATURE, EQUITY_ITERATIONS, actionTable, featurize, observe, type ConcreteAction } from "@/ai/agent";
import { RANKS as RANK_ORDER, SUITS, SUIT_SYMBOL, cardKey, rankLabel, type Card, type Rank, type Suit } from "@/lib/poker/cards";
import { advance, applyAction, createGame, legalActions, potTotal, startHand, type GameState } from "@/lib/poker/engine";

type Seat = "btn" | "sb" | "bb";
type Players = 2 | 3;
type MoveKind = "fold" | "call" | "raise" | "allin";

const SEATS: Record<Players, { id: Seat; name: string; spot: string }[]> = {
  3: [
    { id: "btn", name: "Button", spot: "No blind, first to act" },
    { id: "sb", name: "Small blind", spot: "Acts second preflop" },
    { id: "bb", name: "Big blind", spot: "Acts last preflop" },
  ],
  2: [
    { id: "btn", name: "Button", spot: "Posts the small blind, acts first" },
    { id: "bb", name: "Big blind", spot: "Acts last preflop, first after" },
  ],
};
/** Seat the hero is in on the following hand, once the button has moved one seat. */
const NEXT_SEAT: Record<Players, Record<Seat, Seat>> = {
  3: { btn: "bb", bb: "sb", sb: "btn" },
  2: { btn: "bb", bb: "btn", sb: "bb" },
};

const HERO = 0;
/** 25 BB each 3-handed; heads-up the two left share the table's 1,500 chips. */
const STACK: Record<Players, number> = { 3: 500, 2: 750 };
const BB = 20;

interface LayerJson {
  in: number;
  out: number;
  w: number[];
  b: number[];
}

interface ModelJson {
  checkpoint: string;
  games: number;
  win: number;
  layers: LayerJson[];
}

interface Model {
  checkpoint: string;
  games: number;
  win: number;
  layers: { in: number; out: number; w: Float32Array; b: Float32Array }[];
}

const RANKS: Record<string, Rank> = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, t: 10, j: 11, q: 12, k: 13, a: 14 };
/** Ranks from ace down to deuce: the order of the rows and columns of a range chart. */
const MATRIX_RANKS: Rank[] = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const SUIT_NAME: Record<Suit, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };

function parseHand(value: string): [Card, Card] | null {
  const hand = value.toLowerCase().replace(/\s+/g, "");
  const exact = hand.match(/^([2-9tjqka])([shdc])([2-9tjqka])([shdc])$/);
  if (exact) {
    const cards: [Card, Card] = [
      { rank: RANKS[exact[1]], suit: exact[2] as Suit },
      { rank: RANKS[exact[3]], suit: exact[4] as Suit },
    ];
    return cards[0].rank === cards[1].rank && cards[0].suit === cards[1].suit ? null : cards;
  }

  // Standard shorthand, e.g. AKs, AKo, or TT. Exact suit choices do not
  // matter to this policy beyond whether the cards are suited.
  const shorthand = hand.match(/^([2-9tjqka])([2-9tjqka])([so])?$/);
  if (!shorthand) return null;
  const first = RANKS[shorthand[1]];
  const second = RANKS[shorthand[2]];
  if (first === second) return [{ rank: first, suit: "s" }, { rank: second, suit: "h" }];
  return shorthand[3] === "s"
    ? [{ rank: first, suit: "s" }, { rank: second, suit: "s" }]
    : [{ rank: first, suit: "s" }, { rank: second, suit: "h" }];
}

/** Shorthand such as AKs, T9o or 77 for a pair of cards. */
function handLabel(a: Card, b: Card): string {
  const [hi, lo] = a.rank >= b.rank ? [a, b] : [b, a];
  if (hi.rank === lo.rank) return `${rankLabel(hi.rank)}${rankLabel(lo.rank)}`;
  return `${rankLabel(hi.rank)}${rankLabel(lo.rank)}${hi.suit === lo.suit ? "s" : "o"}`;
}

/** The hand a range-chart cell stands for: suited above the diagonal, offsuit below, pairs on it. */
function matrixHand(row: number, column: number): [Card, Card] {
  const rowRank = MATRIX_RANKS[row];
  const columnRank = MATRIX_RANKS[column];
  if (row === column) return [{ rank: rowRank, suit: "s" }, { rank: rowRank, suit: "h" }];
  if (column > row) return [{ rank: rowRank, suit: "s" }, { rank: columnRank, suit: "s" }];
  return [{ rank: columnRank, suit: "s" }, { rank: rowRank, suit: "h" }];
}

function parseBoard(value: string): Card[] | null {
  const text = value.toLowerCase().replace(/\s+/g, "");
  if (text === "") return [];
  if (!/^(?:[2-9tjqka][shdc]){1,5}$/.test(text)) return null;
  const cards = (text.match(/[2-9tjqka][shdc]/g) ?? []).map((key) => ({ rank: RANKS[key[0]], suit: key[1] as Suit }));
  return new Set(cards.map(cardKey)).size === cards.length ? cards : null;
}

/* ------------------------------------------------------------------ model */

function runPolicy(model: Model, input: number[], mask: boolean[]) {
  let values = Float32Array.from(input);
  model.layers.forEach((layer, index) => {
    const next = new Float32Array(layer.out);
    for (let output = 0; output < layer.out; output++) {
      let sum = layer.b[output];
      const start = output * layer.in;
      for (let inputIndex = 0; inputIndex < layer.in; inputIndex++) sum += layer.w[start + inputIndex] * values[inputIndex];
      next[output] = index === model.layers.length - 1 ? sum : Math.tanh(sum);
    }
    values = next;
  });
  const logits = Array.from(values, (value, index) => (mask[index] ? value : -Infinity));
  const largest = Math.max(...logits);
  const weights = logits.map((value) => (Number.isFinite(value) ? Math.exp(value - largest) : 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function advise(model: Model, game: GameState) {
  const observation = observe(game, HERO);
  const features = featurize(observation, EQUITY_ITERATIONS.play);
  const { actions, mask } = actionTable(observation);
  const probabilities = runPolicy(model, features, mask);
  const best = probabilities.indexOf(Math.max(...probabilities));
  return { observation, actions, mask, probabilities, best, equity: features[EQUITY_FEATURE] };
}

type Advice = ReturnType<typeof advise>;

function moveKind(action: ConcreteAction, advice: Advice): MoveKind {
  if (action.type === "fold") return "fold";
  if (action.type === "check" || action.type === "call") return "call";
  return action.amount === advice.observation.maxRaiseTo ? "allin" : "raise";
}

const bbText = (chips: number) => `${+(chips / BB).toFixed(2)} BB`;

function describeMove(action: ConcreteAction, advice: Advice) {
  const obs = advice.observation;
  const currentBet = Math.max(...obs.seats.map((seat) => seat.bet));
  if (action.type === "fold") return "Fold";
  if (action.type === "check") return "Check";
  if (action.type === "call") return `Call ${bbText(currentBet - obs.seats[0].bet)}`;
  if (action.amount === obs.maxRaiseTo) return "All-in";
  return `${currentBet === 0 ? "Bet" : "Raise to"} ${bbText(action.amount ?? 0)}`;
}

/** Why a move has the size it has: the policy only knows these fixed sizes. */
function sizeHint(index: number, action: ConcreteAction, advice: Advice): string {
  const obs = advice.observation;
  const toCall = Math.max(...obs.seats.map((seat) => seat.bet)) - obs.seats[0].bet;
  if (action.type === "fold") return "";
  if (action.type === "check") return "no chips";
  if (action.type === "call") return `${toCall} chips`;
  const chips = action.amount ?? 0;
  const label = index === 2 ? "minimum" : index === 3 ? "half the pot" : index === 4 ? "the pot" : "everything";
  return `${label} · ${chips} chips`;
}

/* ------------------------------------------------------------------- game */

/** A fresh hand at 10/20 with the hero in the chosen seat. Heads-up, the third seat is already eliminated. */
function newHand(seat: Seat, players: Players): GameState {
  const game = createGame(["You", "Player 2", "Player 3"], STACK[players], { heroIndex: HERO });
  if (players === 2) {
    const gone = game.players[2];
    Object.assign(gone, { out: true, folded: true, stack: 0, place: 3 });
  }
  // startHand moves the button one seat (skipping eliminated players) before dealing.
  const dealer = players === 3 ? (seat === "btn" ? 2 : seat === "sb" ? 1 : 0) : seat === "bb" ? 0 : 1;
  return startHand({ ...game, dealer }, 0);
}

/** The same hand with the hero holding the chosen cards (the engine dealt random ones). */
function withHole(game: GameState, hole: Card[]): GameState {
  if (hole.length !== 2) return game;
  return { ...game, players: game.players.map((player) => (player.id === HERO ? { ...player, hole: hole.slice() } : player)) };
}

function seatName(game: GameState, id: number): string {
  if (id === game.dealer) return "Button";
  return id === game.sbSeat ? "Small blind" : "Big blind";
}

const BOARD_NEEDED: Record<GameState["street"], number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const STREET_NAME: Record<GameState["street"], string> = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" };

/** Close the street when betting is over and deal the next one; its cards are then chosen by the user. */
function settle(game: GameState): GameState {
  if (game.phase !== "streetEnd" || game.street === "river") return game;
  const before = game.board.length;
  const next = advance(game);
  return { ...next, board: next.board.slice(0, before) };
}

function historyLines(game: GameState): string[] {
  return game.history.map((entry) => {
    const who = entry.player === HERO ? "You" : seatName(game, entry.player);
    const verb = entry.player === HERO ? { fold: "fold", check: "check", call: "call", bet: "bet", raise: "raise to" } : { fold: "folds", check: "checks", call: "calls", bet: "bets", raise: "raises to" };
    const amount = entry.type === "fold" || entry.type === "check" ? "" : entry.type === "call" ? `, ${bbText(entry.to)} in` : ` ${bbText(entry.to)}`;
    return `${STREET_NAME[entry.street]} · ${who} ${entry.allIn ? (entry.player === HERO ? "go" : "goes") + " all-in for" : verb[entry.type]}${amount}`;
  });
}

/* --------------------------------------------------------------------- ui */

interface DeckProps {
  label: string;
  selected: string[];
  locked?: string[];
  taken?: string[];
  open: boolean;
  onPick: (card: Card) => void;
}

function DeckGrid({ label, selected, locked = [], taken = [], open, onPick }: DeckProps) {
  return (
    <div className="advisor-deck" role="grid" aria-label={label}>
      {SUITS.map((suit) => (
        <div role="row" key={suit} className="advisor-deck-row">
          {[...RANK_ORDER].reverse().map((rank) => {
            const card: Card = { rank, suit };
            const key = cardKey(card);
            const isSelected = selected.includes(key);
            const isTaken = taken.includes(key);
            return (
              <button
                type="button"
                role="gridcell"
                key={key}
                className={`advisor-deck-card suit-${suit} ${isSelected ? "selected" : ""} ${isTaken ? "in-hand" : ""}`}
                aria-selected={isSelected}
                aria-label={`${rankLabel(rank)} of ${SUIT_NAME[suit]}${isTaken ? ", already used" : ""}`}
                disabled={isTaken || locked.includes(key) || (!isSelected && !open)}
                onClick={() => onPick(card)}
              >
                {rankLabel(rank)}{SUIT_SYMBOL[suit]}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function BigCard({ card, size }: { card: Card; size?: "sm" }) {
  const rank = rankLabel(card.rank) === "T" ? "10" : rankLabel(card.rank);
  return (
    <span className={`advisor-card suit-${card.suit} ${size === "sm" ? "sm" : ""}`} aria-label={`${rank} of ${SUIT_NAME[card.suit]}`}>
      <b>{rank}</b>
      <i>{SUIT_SYMBOL[card.suit]}</i>
      <em>{SUIT_SYMBOL[card.suit]}</em>
    </span>
  );
}

export function PreflopAdvisor() {
  const [seat, setSeat] = useState<Seat>("btn");
  const [players, setPlayers] = useState<Players>(3);
  const [hole, setHole] = useState<Card[]>([]);
  const [handText, setHandText] = useState("");
  const [boardText, setBoardText] = useState("");
  // Created after mount: dealing uses random numbers, which must not run during prerender.
  const [game, setGame] = useState<GameState | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [raiseText, setRaiseText] = useState("");
  const [played, setPlayed] = useState(0);
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setGame(newHand("btn", 3)), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    fetch("/api/model")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Unable to load model.");
        return response.json() as Promise<ModelJson>;
      })
      .then((raw) => setModel({ ...raw, layers: raw.layers.map((layer) => ({ ...layer, w: Float32Array.from(layer.w), b: Float32Array.from(layer.b) })) }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load model."));
  }, []);

  const live = useMemo(() => (game ? withHole(game, hole) : null), [game, hole]);
  if (!live || !game) return <main className="advisor-page"><p className="muted">Dealing…</p></main>;
  return <Advisor {...{ live, game, setGame, hole, setHole, handText, setHandText, boardText, setBoardText, chosen, setChosen, raiseText, setRaiseText, played, setPlayed, model, error, seat, setSeat, players, setPlayers }} />;
}

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
interface AdvisorProps {
  live: GameState;
  game: GameState;
  setGame: Setter<GameState | null>;
  hole: Card[];
  setHole: Setter<Card[]>;
  handText: string;
  setHandText: Setter<string>;
  boardText: string;
  setBoardText: Setter<string>;
  chosen: number | null;
  setChosen: Setter<number | null>;
  raiseText: string;
  setRaiseText: Setter<string>;
  played: number;
  setPlayed: Setter<number>;
  model: Model | null;
  error: string | null;
  seat: Seat;
  setSeat: Setter<Seat>;
  players: Players;
  setPlayers: Setter<Players>;
}

function Advisor({ live, game, setGame, hole, setHole, handText, setHandText, boardText, setBoardText, chosen, setChosen, raiseText, setRaiseText, played, setPlayed, model, error, seat, setSeat, players, setPlayers }: AdvisorProps) {
  const hero = live.players[HERO];
  const street = live.street;
  const preflop = street === "preflop";
  const started = live.history.length > 0;
  const boardNeeded = BOARD_NEEDED[street];
  const boardReady = live.board.length >= boardNeeded;
  const heroTurn = live.phase === "betting" && live.toAct === HERO;
  const villainTurn = live.phase === "betting" && live.toAct !== null && live.toAct !== HERO;
  const over = live.phase === "handOver" || live.phase === "gameOver" || live.phase === "runout" || (live.phase === "streetEnd" && street === "river");
  const villainLegal = villainTurn ? legalActions(live) : null;
  const holeKeys = new Set(hole.map(cardKey));

  const advice = useMemo(
    () => (model && heroTurn && boardReady && hole.length === 2 ? advise(model, live) : null),
    [boardReady, heroTurn, hole.length, live, model],
  );

  // Every starting hand's top move in this exact spot, for the range chart.
  const matrix = useMemo(() => {
    if (!model || !preflop || !heroTurn) return null;
    return MATRIX_RANKS.map((_, row) =>
      MATRIX_RANKS.map((_, column) => {
        const cards = matrixHand(row, column);
        const result = advise(model, withHole(game, cards));
        return {
          cards,
          label: handLabel(cards[0], cards[1]),
          kind: moveKind(result.actions[result.best], result),
          move: describeMove(result.actions[result.best], result),
          confidence: result.probabilities[result.best],
        };
      }),
    );
  }, [game, heroTurn, model, preflop]);

  const resetHand = (nextSeat: Seat, nextPlayers: Players = players) => {
    const fixedSeat = nextPlayers === 2 && nextSeat === "sb" ? "btn" : nextSeat;
    setSeat(fixedSeat);
    setPlayers(nextPlayers);
    setGame(newHand(fixedSeat, nextPlayers));
    setBoardText("");
    setChosen(null);
    setRaiseText("");
  };

  const typeHand = (value: string) => {
    setHandText(value);
    const cards = parseHand(value);
    if (cards) setHole(cards);
    else if (value.trim() === "") setHole([]);
  };

  const pickHand = (cards: [Card, Card]) => {
    setHole(cards);
    setHandText(handLabel(cards[0], cards[1]));
  };

  // Two taps set both cards; a tap on a chosen card removes it, and once two
  // are chosen the next tap replaces the older one.
  const pickHoleCard = (card: Card) => {
    const key = cardKey(card);
    const cards = holeKeys.has(key) ? hole.filter((c) => cardKey(c) !== key) : hole.length < 2 ? [...hole, card] : [hole[1], card];
    setHole(cards);
    setHandText(cards.map(cardKey).join(" "));
  };

  const setBoard = (cards: Card[]) => {
    setGame((current) => (current ? { ...current, board: cards } : current));
    setBoardText(cards.map(cardKey).join(" "));
    setChosen(null);
  };

  const lockedBoard = street === "flop" ? 0 : street === "turn" ? 3 : street === "river" ? 4 : 0;

  const toggleBoardCard = (card: Card) => {
    const key = cardKey(card);
    const index = live.board.findIndex((c) => cardKey(c) === key);
    if (index >= 0) {
      if (index < lockedBoard) return;
      setBoard(live.board.filter((_, i) => i !== index));
    } else if (live.board.length < boardNeeded) {
      setBoard([...live.board, card]);
    }
  };

  const typeBoard = (value: string) => {
    setBoardText(value);
    const cards = parseBoard(value);
    if (!cards || cards.length > boardNeeded || cards.some((card) => holeKeys.has(cardKey(card)))) return;
    const locked = live.board.slice(0, lockedBoard);
    if (!locked.every((card, index) => cards[index] && cardKey(cards[index]) === cardKey(card))) return;
    setGame((current) => (current ? { ...current, board: cards } : current));
    setChosen(null);
  };

  const act = (action: Parameters<typeof applyAction>[1]) => {
    setGame((current) => (current ? settle(applyAction(current, action)) : current));
    setChosen(null);
    setRaiseText("");
  };

  const pick = advice ? (chosen !== null && advice.mask[chosen] ? chosen : advice.best) : null;

  const playChosen = () => {
    if (!advice || pick === null) return;
    const move = advice.actions[pick];
    act(move.type === "raise" ? { type: "raise", amount: move.amount } : { type: move.type });
  };

  const villainRaise = () => {
    if (!villainLegal?.canRaise) return;
    const chips = Math.round(parseFloat(raiseText) * BB);
    act({ type: "raise", amount: Number.isFinite(chips) ? chips : villainLegal.minRaiseTo });
  };

  const nextHand = () => {
    setHole([]);
    setHandText("");
    setPlayed((count) => count + 1);
    resetHand(NEXT_SEAT[players][seat]);
  };

  const selectedLabel = hole.length === 2 ? handLabel(hole[0], hole[1]) : hole.length === 1 ? "One more card" : "Pick two cards";
  const typedInvalid = handText.trim() !== "" && !parseHand(handText) && handText !== hole.map(cardKey).join(" ");
  const boardInvalid = boardText.trim() !== "" && !parseBoard(boardText);
  const streetPrompt = street === "flop" ? "Set the flop" : street === "turn" ? "Set the turn card" : street === "river" ? "Set the river card" : "";
  const pot = potTotal(live);
  const outcome = (() => {
    if (live.phase === "runout") return `All-in for ${bbText(pot)}. No more decisions: run out the board and see who wins.`;
    if (live.phase === "streetEnd" && street === "river") return `Showdown for ${bbText(pot)}.`;
    if (live.result) return hero.folded ? "You folded. The hand is over." : `Everyone folded. You win ${bbText(live.result.won[HERO] ?? pot)}.`;
    return "";
  })();
  const history = historyLines(live);
  const villainName = villainTurn ? seatName(live, live.toAct!) : "";
  const showHoleDeck = preflop && !over;
  const needsCards = hole.length < 2;

  return (
    <main className="advisor-page">
      <header className="advisor-header">
        <Link href="/" className="ghost-btn">← Table</Link>
        <div className="advisor-title">
          <div className="brand-name">Hand Advisor</div>
          <div className="muted">Play a real hand, 3-handed or heads-up. Report what the others do; the Expresso bot advises your every move.</div>
        </div>
      </header>

      <div className="advisor-layout">
        <section className={`advisor-chart ${needsCards && preflop && !over ? "advisor-first" : ""} ${!preflop ? "advisor-board" : ""}`} aria-label="Table">
          <div className="advisor-board-head">
            <div className="advisor-players" role="group" aria-label="Players at the table">
              {([3, 2] as const).map((count) => (
                <button type="button" key={count} className={players === count ? "on" : ""} aria-pressed={players === count} disabled={started} onClick={() => resetHand(seat, count)}>
                  {count === 3 ? "3 players" : "Heads-up"}
                </button>
              ))}
            </div>
            {started && !over && <button type="button" className="ghost-btn" onClick={() => resetHand(seat)}>Start over</button>}
          </div>
          <div className="advisor-board-head">
            <div className="advisor-seat" role="group" aria-label="Your seat">
              {SEATS[players].map((option) => (
                <button type="button" key={option.id} className={seat === option.id ? "on" : ""} aria-pressed={seat === option.id} disabled={started} onClick={() => resetHand(option.id)}>
                  <strong>{option.name}</strong>
                  <span>{option.spot}</span>
                </button>
              ))}
            </div>
          </div>

          {showHoleDeck && (
            <>
              <div className="advisor-deck-title">
                <span>Your cards</span>
                <span className="muted">Tap your two cards{heroTurn ? ", or a hand in the chart below" : ""}</span>
              </div>
              <DeckGrid label="Pick your two cards" selected={[...holeKeys]} open onPick={pickHoleCard} />
            </>
          )}

          {!preflop && (
            <>
              <div className="advisor-deck-title">
                <span>{over ? "Board" : streetPrompt}</span>
                <span className="muted">
                  {over ? "" : boardReady ? "Board set. Tap a card to swap it." : `Pick ${boardNeeded - live.board.length} more card${boardNeeded - live.board.length === 1 ? "" : "s"}, or type them.`}
                </span>
              </div>
              <div className="advisor-board-cards" aria-label="Board cards">
                {Array.from({ length: 5 }, (_, index) => live.board[index]
                  ? <BigCard key={cardKey(live.board[index])} card={live.board[index]} size="sm" />
                  : <span key={index} className={`advisor-card-slot ${index < boardNeeded ? "wanted" : ""}`} aria-hidden="true">{index < 3 ? "Flop" : index === 3 ? "Turn" : "River"}</span>)}
              </div>
              {!over && (
                <label className="advisor-hand-input advisor-board-input">
                  <span>Type the board</span>
                  <input value={boardText} onChange={(event) => typeBoard(event.target.value)} placeholder="As Kd 7h" spellCheck={false} autoComplete="off" aria-invalid={boardInvalid} />
                  <small className={boardInvalid ? "advisor-error" : ""}>{boardInvalid ? "Use cards like As Kd 7h, with no repeats." : "Cards like As Kd 7h, in the order they came."}</small>
                </label>
              )}
              <DeckGrid
                label="Pick board cards"
                selected={live.board.map(cardKey)}
                locked={live.board.slice(0, lockedBoard).map(cardKey)}
                taken={[...holeKeys]}
                open={!over && live.board.length < boardNeeded}
                onPick={toggleBoardCard}
              />
            </>
          )}

          {matrix && (
            <>
              <div className="advisor-deck-title">
                <span>Range chart for this spot</span>
                <span className="muted">Suited above the diagonal, offsuit below</span>
              </div>
              <div className="advisor-matrix" role="grid" aria-label="Starting hands. Suited hands above the diagonal, offsuit below, pairs on it.">
                {matrix.map((cells, row) => (
                  <div role="row" key={row} className="advisor-matrix-row">
                    {cells.map((cell) => {
                      const selected = cell.label === selectedLabel;
                      return (
                        <button
                          type="button"
                          role="gridcell"
                          key={cell.label}
                          className={`advisor-cell kind-${cell.kind} ${selected ? "selected" : ""}`}
                          style={{ "--confidence": cell.confidence } as React.CSSProperties}
                          aria-selected={selected}
                          aria-label={`${cell.label}: ${cell.move}, ${Math.round(cell.confidence * 100)}%`}
                          title={`${cell.label} · ${cell.move} · ${Math.round(cell.confidence * 100)}%`}
                          onClick={() => pickHand(cell.cards)}
                        >
                          {cell.label}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="advisor-legend" aria-label="Colour key">
                {(["fold", "call", "raise", "allin"] as const).map((kind) => (
                  <span key={kind}><i className={`advisor-swatch kind-${kind}`} aria-hidden="true" />{{ fold: "Fold", call: "Call", raise: "Raise", allin: "All-in" }[kind]}</span>
                ))}
                <span className="muted">Brighter means more confident</span>
              </div>
            </>
          )}
        </section>

        <section className="advisor-verdict" aria-live="polite">
          <div className="advisor-hand">
            <div className="advisor-hand-cards">
              {[0, 1].map((index) => hole[index]
                ? <BigCard key={cardKey(hole[index])} card={hole[index]} />
                : <span key={index} className="advisor-card-slot wanted" aria-hidden="true">{index === 0 ? "1st" : "2nd"}</span>)}
            </div>
            <div className="advisor-hand-name">
              <span className="muted">
                {over ? "Hand over" : STREET_NAME[street]} · {seatName(live, HERO)} · pot {bbText(pot)} · {bbText(hero.stack)} behind
              </span>
              <strong>{selectedLabel}</strong>
            </div>
          </div>

          {error ? (
            <p className="advisor-error">{error}</p>
          ) : over ? (
            <div className="advisor-best">
              <span className="muted">Result</span>
              <strong className="advisor-outcome">{outcome}</strong>
            </div>
          ) : !boardReady ? (
            <div className="advisor-best">
              <span className="muted">{villainTurn ? `${villainName} to act` : "Best move"}</span>
              <strong className="pending">{streetPrompt} first</strong>
            </div>
          ) : villainTurn && villainLegal ? (
            <div className="advisor-ask">
              <span className="muted">{villainName} to act</span>
              <strong>What did they do?</strong>
              <div className="advisor-ask-buttons">
                {villainLegal.canFold && <button type="button" onClick={() => act({ type: "fold" })}>Fold</button>}
                {villainLegal.canCheck && <button type="button" onClick={() => act({ type: "check" })}>Check</button>}
                {villainLegal.canCall && <button type="button" onClick={() => act({ type: "call" })}>Call {bbText(villainLegal.callAmount)}</button>}
                {villainLegal.canRaise && (
                  <>
                    <span className="advisor-ask-raise">
                      <span>{live.currentBet === 0 ? "Bet" : "Raise to"}</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={villainLegal.minRaiseTo / BB}
                        max={villainLegal.maxRaiseTo / BB}
                        step={0.5}
                        placeholder={String(villainLegal.minRaiseTo / BB)}
                        value={raiseText}
                        onChange={(event) => setRaiseText(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") villainRaise(); }}
                        aria-label={`${live.currentBet === 0 ? "Bet" : "Raise to"} amount in big blinds, ${villainLegal.minRaiseTo / BB} to ${villainLegal.maxRaiseTo / BB}`}
                      />
                      <span>BB</span>
                      <button type="button" onClick={villainRaise}>{live.currentBet === 0 ? "Bet" : "Raise"}</button>
                    </span>
                    <button type="button" className="allin" onClick={() => act({ type: "raise", amount: villainLegal.maxRaiseTo })}>All-in {bbText(villainLegal.maxRaiseTo)}</button>
                  </>
                )}
              </div>
              <small className="muted">{villainLegal.canRaise ? `Minimum ${live.currentBet === 0 ? "bet" : "raise"} ${bbText(villainLegal.minRaiseTo)}.` : "They can only call or fold."}</small>
            </div>
          ) : needsCards ? (
            <div className="advisor-best">
              <span className="muted">Best move</span>
              <strong className="pending">Pick your cards first</strong>
            </div>
          ) : !advice ? (
            <div className="advisor-best">
              <span className="muted">Best move</span>
              <strong className="pending">Loading…</strong>
            </div>
          ) : (
            <>
              <div className={`advisor-best kind-${moveKind(advice.actions[advice.best], advice)}`}>
                <span className="muted">Best move</span>
                <strong>{describeMove(advice.actions[advice.best], advice)}</strong>
                <span className="advisor-stats">
                  <b>{(advice.probabilities[advice.best] * 100).toFixed(0)}%</b> confidence
                  <i aria-hidden="true">·</i>
                  <b>{(advice.equity * 100).toFixed(0)}%</b> equity vs {live.players.filter((p) => p.id !== HERO && !p.folded && !p.out).length === 2 ? "2 players" : "1 player"}
                </span>
              </div>
              <ol className="advisor-probabilities" aria-label="All legal moves. Pick the one you played.">
                {ACTIONS.map((action, index) => advice.mask[index] && (
                  <li key={action}>
                    <button
                      type="button"
                      className={`advisor-option ${index === advice.best ? "best" : ""} ${index === pick ? "picked" : ""}`}
                      aria-pressed={index === pick}
                      onClick={() => setChosen(index)}
                    >
                      <span>
                        {describeMove(advice.actions[index], advice)}
                        <small>{sizeHint(index, advice.actions[index], advice)}</small>
                      </span>
                      <b>{(advice.probabilities[index] * 100).toFixed(0)}%</b>
                      <i style={{ width: `${advice.probabilities[index] * 100}%` }} />
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}

          {over ? (
            <div className="advisor-next">
              <button type="button" className="primary-btn" onClick={nextHand}>Next hand</button>
              <span className="muted">
                Clears the cards and moves the button: you will be the {SEATS[players].find((option) => option.id === NEXT_SEAT[players][seat])?.name.toLowerCase()}.
                {played > 0 && <small>{played} {played === 1 ? "hand" : "hands"} played</small>}
              </span>
            </div>
          ) : heroTurn ? (
            <div className="advisor-next">
              <button type="button" className="primary-btn" disabled={pick === null} onClick={playChosen}>
                I played{advice && pick !== null ? `: ${describeMove(advice.actions[pick], advice)}` : ""}
              </button>
              <span className="muted">
                {pick !== null && advice && pick !== advice.best ? "Your pick, not the model's." : "Tap another move above if you played differently."}
              </span>
            </div>
          ) : null}

          {history.length > 0 && (
            <ol className="advisor-history" aria-label="This hand so far">
              {history.map((line, index) => <li key={index}>{line}</li>)}
            </ol>
          )}

          {preflop && !over && (
            <label className="advisor-hand-input">
              <span>Or type a hand</span>
              <input value={handText} onChange={(event) => typeHand(event.target.value)} placeholder="AKs" spellCheck={false} autoComplete="off" aria-invalid={typedInvalid} />
              <small className={typedInvalid ? "advisor-error" : ""}>
                {typedInvalid ? "Use a hand like AKs, AKo, TT, or exact cards like As Kd." : "AKs, AKo, TT, or exact cards like As Kd."}
              </small>
            </label>
          )}

          {model && (
            <p className="muted advisor-model">
              10/20 blinds, {players === 3 ? "25 BB stacks, 3 players" : "37.5 BB stacks, heads-up"}. Model {model.checkpoint}, {model.games.toLocaleString("en-GB")} training games.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
