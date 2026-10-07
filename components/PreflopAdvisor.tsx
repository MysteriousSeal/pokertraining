"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ACTIONS, EQUITY_FEATURE, actionTable, featurize, type Observation } from "@/ai/agent";
import { SUIT_SYMBOL, cardKey, rankLabel, type Card, type Rank, type Suit } from "@/lib/poker/cards";

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

function makeObservation(hole: Card[], seat: Seat): Observation {
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

function advise(model: Model, hole: [Card, Card], seat: Seat) {
  const observation = makeObservation(hole, seat);
  const features = featurize(observation);
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

function BigCard({ card }: { card: Card }) {
  const rank = rankLabel(card.rank) === "T" ? "10" : rankLabel(card.rank);
  return (
    <span className={`advisor-card suit-${card.suit}`} aria-label={`${rank} of ${SUIT_NAME[card.suit]}`}>
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
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);

  const typeHand = (value: string) => {
    setHandText(value);
    const cards = parseHand(value);
    if (cards) setHole(cards);
  };

  const pickHand = (cards: [Card, Card]) => {
    setHole(cards);
    setHandText(handLabel(cards[0], cards[1]));
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

  const advice = useMemo(() => (model ? advise(model, hole, seat) : null), [hole, model, seat]);

  // Every starting hand's top move, for the range chart. 169 tiny forward passes.
  const matrix = useMemo(() => {
    if (!model) return null;
    return MATRIX_RANKS.map((_, row) =>
      MATRIX_RANKS.map((_, column) => {
        const cards = matrixHand(row, column);
        const result = advise(model, cards, seat);
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

  return (
    <main className="advisor-page">
      <header className="advisor-header">
        <Link href="/" className="ghost-btn">← Table</Link>
        <div className="advisor-title">
          <div className="brand-name">Preflop Advisor</div>
          <div className="muted">What the trained Expresso bot would do with each starting hand</div>
        </div>
      </header>

      <div className="advisor-layout">
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

        <section className="advisor-verdict" aria-live="polite">
          <div className="advisor-hand">
            <div className="advisor-hand-cards">
              <BigCard card={hole[0]} />
              <BigCard card={hole[1]} />
            </div>
            <div className="advisor-hand-name">
              <span className="muted">{SEATS.find((option) => option.id === seat)?.summary}</span>
              <strong>{selectedLabel}</strong>
            </div>
          </div>

          {error ? (
            <p className="advisor-error">{error}</p>
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
                  <b>{(advice.equity * 100).toFixed(0)}%</b> equity {seat === "btn" ? "3-way" : "heads-up"}
                </span>
              </div>
              <ol className="advisor-probabilities" aria-label="All legal moves">
                {ACTIONS.map((action, index) => advice.mask[index] && (
                  <li className={index === advice.best ? "advisor-option best" : "advisor-option"} key={action}>
                    <span>{describeMove(advice.actions[index], advice.observation)}</span>
                    <b>{(advice.probabilities[index] * 100).toFixed(0)}%</b>
                    <i style={{ width: `${advice.probabilities[index] * 100}%` }} />
                  </li>
                ))}
              </ol>
            </>
          )}

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

          {advice && (
            <p className="muted advisor-model">
              {advice.observation.sb}/{advice.observation.bb} blinds, 25 BB stacks{seat === "btn" ? "" : ", heads-up"}. Model {model?.checkpoint}, {model?.games.toLocaleString("en-GB")} training games.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
