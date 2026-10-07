"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ACTIONS, EQUITY_FEATURE, EQUITY_ITERATIONS, actionTable, featurize, type Observation, type SeatObs } from "@/ai/agent";
import { RANKS as RANK_ORDER, SUITS, SUIT_SYMBOL, cardKey, fullDeck, rankLabel, shuffle, type Card, type Rank, type Suit } from "@/lib/poker/cards";

type Seat = "btn" | "sb" | "bb";

const SEATS: { id: Seat; name: string; spot: string; summary: string }[] = [
  { id: "btn", name: "Button", spot: "No blind, 3 players, first to act", summary: "Button, 3 players, no blind posted" },
  { id: "sb", name: "Small blind", spot: "Heads-up, you open the action", summary: "Small blind, heads-up, 25 BB deep" },
  { id: "bb", name: "Big blind", spot: "Heads-up, facing a min-raise to 2 BB", summary: "Big blind, heads-up, facing 2 BB" },
];
type MoveKind = "fold" | "call" | "raise" | "allin";

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
  // matter to this preflop policy beyond whether the cards are suited.
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

function preflopObservation(hole: Card[], seat: Seat): Observation {
  if (seat === "btn") {
    // Three players, 25 BB each, blinds just posted. Seats follow action order:
    // hero on the button, then the small blind, then the big blind.
    return {
      seats: [
        { stack: 500, bet: 0, folded: false, out: false, allIn: false, dealer: true, lastAction: "" },
        { stack: 490, bet: 10, folded: false, out: false, allIn: false, dealer: false, lastAction: "SB" },
        { stack: 480, bet: 20, folded: false, out: false, allIn: false, dealer: false, lastAction: "BB" },
      ],
      hole: hole.map(cardKey),
      board: [],
      sb: 10,
      bb: 20,
      level: 0,
      pot: 30,
      canCheck: false,
      canRaise: true,
      minRaiseTo: 40,
      maxRaiseTo: 500,
    };
  }
  const isSmallBlind = seat === "sb";
  // The trained policy always has three seat inputs. The third seat represents
  // the eliminated player in this heads-up, 25 BB decision.
  return {
    seats: [
      {
        stack: isSmallBlind ? 490 : 480,
        bet: isSmallBlind ? 10 : 20,
        folded: false,
        out: false,
        allIn: false,
        dealer: isSmallBlind,
        lastAction: isSmallBlind ? "SB" : "BB",
      },
      {
        stack: isSmallBlind ? 480 : 460,
        bet: isSmallBlind ? 20 : 40,
        folded: false,
        out: false,
        allIn: false,
        dealer: !isSmallBlind,
        lastAction: isSmallBlind ? "BB" : "Raise",
      },
      { stack: 0, bet: 0, folded: false, out: true, allIn: false, dealer: false, lastAction: "" },
    ],
    hole: hole.map(cardKey),
    board: [],
    sb: 10,
    bb: 20,
    level: 0,
    pot: isSmallBlind ? 30 : 60,
    canCheck: false,
    canRaise: true,
    minRaiseTo: isSmallBlind ? 40 : 60,
    maxRaiseTo: 500,
  };
}

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

/* ----------------------------------------------------------- hand flow */

type Street = "preflop" | "flop" | "turn" | "river" | "over";
const STREET_CARDS: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5, over: 5 };
/** Board cards dealt before the current street, which can no longer change. */
const lockedCards = (street: Street) => (street === "flop" ? 0 : street === "turn" ? 3 : street === "river" ? 4 : 5);
const STREET_NAME: Record<Street, string> = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River", over: "Hand over" };

/** The hand in progress after at least one street has been played. */
interface Hand {
  street: Street;
  board: Card[];
  heroStack: number;
  oppStack: number;
  pot: number;
  history: string[];
  outcome: string | null;
}

/** Postflop spot: a new street, nobody has bet yet, and the opponent checks to the hero when they are in position. */
function postflopObservation(hole: Card[], seat: Seat, hand: Hand): Observation {
  const heroDealer = seat !== "bb";
  const hero: SeatObs = { stack: hand.heroStack, bet: 0, folded: false, out: false, allIn: false, dealer: heroDealer, lastAction: "" };
  const opp: SeatObs = { stack: hand.oppStack, bet: 0, folded: false, out: false, allIn: false, dealer: !heroDealer, lastAction: heroDealer ? "Check" : "" };
  const gone: SeatObs = seat === "btn"
    ? { stack: 490, bet: 0, folded: true, out: false, allIn: false, dealer: false, lastAction: "Fold" }
    : { stack: 0, bet: 0, folded: false, out: true, allIn: false, dealer: false, lastAction: "" };
  return {
    seats: seat === "btn" ? [hero, gone, opp] : [hero, opp, gone],
    hole: hole.map(cardKey),
    board: hand.board.slice(0, STREET_CARDS[hand.street]).map(cardKey),
    sb: 10,
    bb: 20,
    level: 0,
    pot: hand.pot,
    canCheck: true,
    canRaise: hand.heroStack > 0 && hand.oppStack > 0,
    minRaiseTo: Math.min(20, hand.heroStack),
    maxRaiseTo: hand.heroStack,
  };
}

function advise(model: Model, hole: [Card, Card], seat: Seat, hand: Hand | null) {
  const observation = hand && hand.street !== "preflop" ? postflopObservation(hole, seat, hand) : preflopObservation(hole, seat);
  const features = featurize(observation, EQUITY_ITERATIONS.play);
  const { actions, mask } = actionTable(observation);
  const probabilities = runPolicy(model, features, mask);
  const best = probabilities.indexOf(Math.max(...probabilities));
  return { observation, actions, mask, probabilities, best, equity: features[EQUITY_FEATURE] };
}

type Action = ReturnType<typeof actionTable>["actions"][number];

function moveKind(action: Action, obs: Observation): MoveKind {
  if (action.type === "fold") return "fold";
  if (action.type === "check" || action.type === "call") return "call";
  return action.amount === obs.maxRaiseTo ? "allin" : "raise";
}

function describeMove(action: Action, obs: Observation) {
  if (action.type === "fold") return "Fold";
  if (action.type === "check") return "Check";
  if (action.type === "call") return `Call ${(Math.max(...obs.seats.map((seat) => seat.bet)) - obs.seats[0].bet) / obs.bb} BB`;
  if (action.amount === obs.maxRaiseTo) return "All-in";
  return `${Math.max(...obs.seats.map((seat) => seat.bet)) === 0 ? "Bet" : "Raise to"} ${(action.amount ?? 0) / obs.bb} BB`;
}

/** Why a move has the size it has: the policy only knows these fixed sizes. */
function sizeHint(index: number, action: Action, obs: Observation): string {
  const toCall = Math.max(...obs.seats.map((seat) => seat.bet)) - obs.seats[0].bet;
  if (action.type === "fold") return "";
  if (action.type === "check") return "no chips";
  if (action.type === "call") return `${toCall} chips`;
  const chips = action.amount ?? 0;
  const label = index === 2 ? "minimum" : index === 3 ? "half the pot" : index === 4 ? "the pot" : "everything";
  return `${label} · ${chips} chips`;
}

const bbText = (chips: number) => `${+(chips / 20).toFixed(2)} BB`;

/**
 * Apply the hero's move and move on to the next street. Opponents are
 * assumed to call a raise or bet and to check otherwise; on the button the
 * small blind folds and the big blind continues.
 */
function playMove(seat: Seat, hand: Hand | null, obs: Observation, action: Action): Hand {
  const street: Street = hand?.street ?? "preflop";
  const next: Street = street === "preflop" ? "flop" : street === "flop" ? "turn" : street === "turn" ? "river" : "over";
  const hero = obs.seats[0];
  const opp = obs.seats.find((s) => !s.out && !s.folded && s !== hero)!;
  const base = { board: hand?.board ?? [], history: hand?.history ?? [] };

  if (action.type === "fold") {
    return { ...base, street: "over", heroStack: hero.stack, oppStack: opp.stack, pot: obs.pot, history: [...base.history, `${STREET_NAME[street]}: you folded`], outcome: "You folded. The hand is over." };
  }
  const currentBet = Math.max(...obs.seats.map((s) => s.bet));
  const heroTotal = action.type === "raise" ? (action.amount ?? currentBet) : currentBet;
  const oppTotal = Math.min(heroTotal, opp.stack + opp.bet);
  const heroStack = hero.stack + hero.bet - heroTotal;
  const oppStack = opp.stack + opp.bet - oppTotal;
  // obs.pot already holds every chip in the middle, including the blinds.
  const pot = obs.pot - hero.bet - opp.bet + heroTotal + oppTotal;
  const allIn = heroStack === 0 || oppStack === 0;
  const oppName = street === "preflop" ? (seat === "sb" ? "big blind" : seat === "bb" ? "small blind" : "big blind") : "opponent";
  const oppDid = action.type === "check" || (action.type === "call" && seat !== "bb" && street === "preflop") ? "checked" : "called";
  const reply = `${seat === "btn" && street === "preflop" ? "small blind folded, " : ""}${oppName} ${oppDid}`;
  const did = action.type === "check" ? "checked"
    : action.type === "call" ? `called ${bbText(heroTotal - hero.bet)}`
    : heroTotal === hero.stack + hero.bet ? "went all-in"
    : `${currentBet === 0 ? "bet" : "raised to"} ${bbText(heroTotal)}`;
  const line = `${STREET_NAME[street]}: you ${did}, ${reply}`;
  const history = [...base.history, line];
  if (allIn) return { ...base, street: "over", heroStack, oppStack, pot, history, outcome: street === "river" ? `All-in showdown for ${bbText(pot)}.` : `All-in for ${bbText(pot)}. No more decisions: run out the board and see who wins.` };
  if (next === "over") return { ...base, street: "over", heroStack, oppStack, pot, history, outcome: `Showdown for ${bbText(pot)}.` };
  return { ...base, street: next, heroStack, oppStack, pot, history, outcome: null };
}

function parseBoard(value: string): Card[] | null {
  const text = value.toLowerCase().replace(/\s+/g, "");
  if (text === "") return [];
  const matches = text.match(/^(?:[2-9tjqka][shdc]){1,5}$/);
  if (!matches) return null;
  const cards = (text.match(/[2-9tjqka][shdc]/g) ?? []).map((key) => ({ rank: RANKS[key[0]], suit: key[1] as Suit }));
  const keys = new Set(cards.map(cardKey));
  return keys.size === cards.length ? cards : null;
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
  const [hole, setHole] = useState<[Card, Card]>([{ rank: 14, suit: "s" }, { rank: 13, suit: "s" }]);
  const [handText, setHandText] = useState("AKs");
  const [seat, setSeat] = useState<Seat>("sb");
  const [hand, setHand] = useState<Hand | null>(null);
  const [boardText, setBoardText] = useState("");
  const [chosen, setChosen] = useState<number | null>(null);
  const [played, setPlayed] = useState(0);
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);

  const street: Street = hand?.street ?? "preflop";
  const preflop = street === "preflop";
  const boardNeeded = STREET_CARDS[street];
  const board = hand?.board ?? [];
  const boardReady = board.length >= boardNeeded;
  const holeKeys = new Set(hole.map(cardKey));

  const typeHand = (value: string) => {
    setHandText(value);
    const cards = parseHand(value);
    if (cards) setHole(cards);
  };

  const pickHand = (cards: [Card, Card]) => {
    setHole(cards);
    setHandText(handLabel(cards[0], cards[1]));
  };

  const updateBoard = (update: (cards: Card[]) => Card[]) => {
    setHand((current) => {
      if (!current) return current;
      const cards = update(current.board);
      setBoardText(cards.map(cardKey).join(" "));
      return cards === current.board ? current : { ...current, board: cards };
    });
    setChosen(null);
  };

  const typeBoard = (value: string) => {
    setBoardText(value);
    const cards = parseBoard(value);
    if (!cards || cards.length > boardNeeded || cards.some((card) => holeKeys.has(cardKey(card)))) return;
    // Keep earlier streets fixed: only the cards of the current street can change.
    const locked = board.slice(0, lockedCards(street));
    if (!locked.every((card, index) => cards[index] && cardKey(cards[index]) === cardKey(card))) return;
    setHand((current) => (current ? { ...current, board: cards } : current));
    setChosen(null);
  };

  const toggleBoardCard = (card: Card) => {
    const key = cardKey(card);
    updateBoard((cards) => {
      const index = cards.findIndex((c) => cardKey(c) === key);
      if (index >= 0) return index < lockedCards(street) ? cards : cards.filter((_, i) => i !== index);
      return cards.length >= boardNeeded ? cards : [...cards, card];
    });
  };

  const startOver = () => {
    setHand(null);
    setBoardText("");
    setChosen(null);
  };

  // Next hand: the button moves one seat and a fresh random hand is dealt.
  const nextHand = () => {
    const [a, b] = shuffle(fullDeck());
    pickHand([a, b]);
    setSeat((current) => SEATS[(SEATS.findIndex((option) => option.id === current) + 1) % SEATS.length].id);
    setPlayed((count) => count + 1);
    startOver();
  };

  useEffect(() => {
    fetch("/api/model")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Unable to load model.");
        return response.json() as Promise<ModelJson>;
      })
      .then((raw) => setModel({ ...raw, layers: raw.layers.map((layer) => ({ ...layer, w: Float32Array.from(layer.w), b: Float32Array.from(layer.b) })) }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load model."));
  }, []);

  const advice = useMemo(
    () => (model && street !== "over" && boardReady ? advise(model, hole, seat, hand) : null),
    [boardReady, hand, hole, model, seat, street],
  );

  // Every starting hand's top move, for the range chart. 169 tiny forward passes.
  const matrix = useMemo(() => {
    if (!model) return null;
    return MATRIX_RANKS.map((_, row) =>
      MATRIX_RANKS.map((_, column) => {
        const cards = matrixHand(row, column);
        const result = advise(model, cards, seat, null);
        return {
          cards,
          label: handLabel(cards[0], cards[1]),
          kind: moveKind(result.actions[result.best], result.observation),
          move: describeMove(result.actions[result.best], result.observation),
          confidence: result.probabilities[result.best],
        };
      }),
    );
  }, [model, seat]);

  const selectedLabel = handLabel(hole[0], hole[1]);
  const typedInvalid = handText.trim() !== "" && !parseHand(handText);
  const boardInvalid = boardText.trim() !== "" && !parseBoard(boardText);
  const pick = advice ? (chosen !== null && advice.mask[chosen] ? chosen : advice.best) : null;
  const seatInfo = SEATS.find((option) => option.id === seat)!;
  const streetPrompt = street === "flop" ? "Set the flop" : street === "turn" ? "Set the turn card" : street === "river" ? "Set the river card" : "";

  const playChosen = () => {
    if (!advice || pick === null) return;
    setHand(playMove(seat, hand, advice.observation, advice.actions[pick]));
    setChosen(null);
    setBoardText(board.map(cardKey).join(" "));
  };

  return (
    <main className="advisor-page">
      <header className="advisor-header">
        <Link href="/" className="ghost-btn">← Table</Link>
        <div className="advisor-title">
          <div className="brand-name">Hand Advisor</div>
          <div className="muted">What the trained Expresso bot would do, street by street</div>
        </div>
      </header>

      <div className="advisor-layout">
        {preflop ? (
          <section className="advisor-chart" aria-label="Range chart">
            <div className="advisor-seat" role="group" aria-label="Your seat">
              {SEATS.map((option) => (
                <button type="button" key={option.id} className={seat === option.id ? "on" : ""} aria-pressed={seat === option.id} onClick={() => setSeat(option.id)}>
                  <strong>{option.name}</strong>
                  <span>{option.spot}</span>
                </button>
              ))}
            </div>

            <div className="advisor-matrix" role="grid" aria-label="Starting hands. Suited hands above the diagonal, offsuit below, pairs on it.">
              {(matrix ?? MATRIX_RANKS.map((_, row) => MATRIX_RANKS.map((_, column) => {
                const cards = matrixHand(row, column);
                return { cards, label: handLabel(cards[0], cards[1]), kind: "fold" as MoveKind, move: "", confidence: 0 };
              }))).map((cells, row) => (
                <div role="row" key={row} className="advisor-matrix-row">
                  {cells.map((cell) => {
                    const selected = cell.label === selectedLabel;
                    return (
                      <button
                        type="button"
                        role="gridcell"
                        key={cell.label}
                        className={`advisor-cell kind-${cell.kind} ${selected ? "selected" : ""} ${matrix ? "" : "pending"}`}
                        style={{ "--confidence": cell.confidence } as React.CSSProperties}
                        aria-selected={selected}
                        aria-label={matrix ? `${cell.label}: ${cell.move}, ${Math.round(cell.confidence * 100)}%` : cell.label}
                        title={matrix ? `${cell.label} · ${cell.move} · ${Math.round(cell.confidence * 100)}%` : cell.label}
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
          </section>
        ) : (
          <section className="advisor-chart advisor-board" aria-label="Board">
            <div className="advisor-board-head">
              <div>
                <div className="advisor-board-title">{street === "over" ? "Hand over" : streetPrompt}</div>
                <div className="muted">
                  {street === "over" ? hand?.outcome : boardReady ? "Board set. Tap a card to swap it, or play your move." : `Pick ${boardNeeded - board.length} more card${boardNeeded - board.length === 1 ? "" : "s"}, or type them below.`}
                </div>
              </div>
              <button type="button" className="ghost-btn" onClick={startOver}>Start over</button>
            </div>

            <div className="advisor-board-cards" aria-label="Board cards">
              {Array.from({ length: 5 }, (_, index) => board[index]
                ? <BigCard key={cardKey(board[index])} card={board[index]} size="sm" />
                : <span key={index} className={`advisor-card-slot ${index < boardNeeded ? "wanted" : ""}`} aria-hidden="true">{index < 3 ? "Flop" : index === 3 ? "Turn" : "River"}</span>)}
            </div>

            {street !== "over" && (
              <label className="advisor-hand-input advisor-board-input">
                <span>Type the board</span>
                <input value={boardText} onChange={(event) => typeBoard(event.target.value)} placeholder="As Kd 7h" spellCheck={false} autoComplete="off" aria-invalid={boardInvalid} />
                <small className={boardInvalid ? "advisor-error" : ""}>{boardInvalid ? "Use cards like As Kd 7h, with no repeats." : "Cards like As Kd 7h, in the order they came."}</small>
              </label>
            )}

            <div className="advisor-deck" role="grid" aria-label="Pick board cards">
              {SUITS.map((suit) => (
                <div role="row" key={suit} className="advisor-deck-row">
                  {[...RANK_ORDER].reverse().map((rank) => {
                    const card: Card = { rank, suit };
                    const key = cardKey(card);
                    const onBoard = board.findIndex((c) => cardKey(c) === key);
                    const inHand = holeKeys.has(key);
                    const locked = onBoard >= 0 && onBoard < lockedCards(street);
                    const full = onBoard < 0 && board.length >= boardNeeded;
                    return (
                      <button
                        type="button"
                        role="gridcell"
                        key={key}
                        className={`advisor-deck-card suit-${suit} ${onBoard >= 0 ? "selected" : ""} ${inHand ? "in-hand" : ""}`}
                        aria-selected={onBoard >= 0}
                        aria-label={`${rankLabel(rank)} of ${SUIT_NAME[suit]}${inHand ? ", in your hand" : ""}`}
                        disabled={inHand || locked || full || street === "over"}
                        onClick={() => toggleBoardCard(card)}
                      >
                        {rankLabel(rank)}{SUIT_SYMBOL[suit]}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="advisor-verdict" aria-live="polite">
          <div className="advisor-hand">
            <div className="advisor-hand-cards">
              <BigCard card={hole[0]} />
              <BigCard card={hole[1]} />
            </div>
            <div className="advisor-hand-name">
              <span className="muted">
                {preflop ? seatInfo.summary : `${STREET_NAME[street]} · ${seatInfo.name} · pot ${bbText(hand!.pot)} · ${bbText(hand!.heroStack)} behind`}
              </span>
              <strong>{selectedLabel}</strong>
            </div>
          </div>

          {error ? (
            <p className="advisor-error">{error}</p>
          ) : street === "over" ? (
            <div className="advisor-best">
              <span className="muted">Result</span>
              <strong className="advisor-outcome">{hand?.outcome}</strong>
            </div>
          ) : !boardReady ? (
            <div className="advisor-best">
              <span className="muted">Best move</span>
              <strong className="pending">{streetPrompt} first</strong>
            </div>
          ) : !advice ? (
            <div className="advisor-best">
              <span className="muted">Best move</span>
              <strong className="pending">Loading…</strong>
            </div>
          ) : (
            <>
              <div className={`advisor-best kind-${moveKind(advice.actions[advice.best], advice.observation)}`}>
                <span className="muted">Best move</span>
                <strong>{describeMove(advice.actions[advice.best], advice.observation)}</strong>
                <span className="advisor-stats">
                  <b>{(advice.probabilities[advice.best] * 100).toFixed(0)}%</b> confidence
                  <i aria-hidden="true">·</i>
                  <b>{(advice.equity * 100).toFixed(0)}%</b> equity {seat === "btn" && preflop ? "3-way" : "heads-up"}
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
                        {describeMove(advice.actions[index], advice.observation)}
                        <small>{sizeHint(index, advice.actions[index], advice.observation)}</small>
                      </span>
                      <b>{(advice.probabilities[index] * 100).toFixed(0)}%</b>
                      <i style={{ width: `${advice.probabilities[index] * 100}%` }} />
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}

          {street === "over" ? (
            <div className="advisor-next">
              <button type="button" className="primary-btn" onClick={nextHand}>Next hand</button>
              <span className="muted">
                Deals a random hand and moves the button.
                {played > 0 && <small>{played} {played === 1 ? "hand" : "hands"} played</small>}
              </span>
            </div>
          ) : (
            <div className="advisor-next">
              <button type="button" className="primary-btn" disabled={pick === null} onClick={playChosen}>
                I played{advice && pick !== null ? `: ${describeMove(advice.actions[pick], advice.observation)}` : ""}
              </button>
              <span className="muted">
                {pick !== null && advice && pick !== advice.best ? "Your pick, not the model's." : "Tap another move above if you played differently."}
                <small>{street === "river" ? "Then showdown." : `Then the ${street === "preflop" ? "flop" : street === "flop" ? "turn" : "river"}. The opponent is assumed to call or check.`}</small>
              </span>
            </div>
          )}

          {hand && hand.history.length > 0 && (
            <ol className="advisor-history" aria-label="This hand so far">
              {hand.history.map((line) => <li key={line}>{line}</li>)}
            </ol>
          )}

          {preflop && (
            <label className="advisor-hand-input">
              <span>Or type a hand</span>
              <input
                value={handText}
                onChange={(event) => typeHand(event.target.value)}
                placeholder="AKs"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={typedInvalid}
              />
              <small className={typedInvalid ? "advisor-error" : ""}>
                {typedInvalid ? "Use a hand like AKs, AKo, TT, or exact cards like As Kd." : "AKs, AKo, TT, or exact cards like As Kd."}
              </small>
            </label>
          )}

          {model && (
            <p className="muted advisor-model">
              10/20 blinds, 25 BB stacks. Model {model.checkpoint}, {model.games.toLocaleString("en-GB")} training games.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
