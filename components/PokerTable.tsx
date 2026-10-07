"use client";

import { useEffect, useState } from "react";
import type { GameState } from "@/lib/poker/engine";
import { collectedPot, potTotal } from "@/lib/poker/engine";
import { blindsAt, formatMoney, multiplierClass, type Format, type MultiplierTier } from "@/lib/poker/expresso";
import { useExpressoGame } from "@/hooks/useExpressoGame";
import { PlayingCard } from "./PlayingCard";
import { Seat } from "./Seat";
import { ActionBar, type PreAction } from "./ActionBar";
import { formatChips, formatClock } from "./format";

interface Props {
  names: string[];
  format: Format;
  buyIn: number;
  tier: MultiplierTier;
  onGameOver: (final: GameState) => void;
  onQuit: () => void;
  speed?: number;
}

const POSITIONS = ["bottom", "left", "right"] as const;

export function PokerTable({ names, format, buyIn, tier, onGameOver, onQuit, speed = 1 }: Props) {
  const { state, clock, heroId, heroToAct, heroTimeMs, act } = useExpressoGame(names, format, onGameOver, speed);
  const [inBB, setInBB] = useState(false);
  const [fourColor, setFourColor] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [preAction, setPreAction] = useState<PreAction>(null);
  const [preActionHand, setPreActionHand] = useState(0);

  // Pre-selected actions fire as soon as it's the hero's turn; they only last one hand.
  const handNumber = state.handNumber;
  if (preAction && handNumber !== preActionHand) setPreAction(null);
  useEffect(() => {
    if (!heroToAct || !preAction) return;
    const id = setTimeout(() => {
      act({ type: preAction === "checkFold" ? "fold" : "call" });
      setPreAction(null);
    }, 250);
    return () => clearTimeout(id);
  }, [heroToAct, preAction, act]);

  const prize = buyIn * tier.multiplier;
  const bb = state.blinds.bb;
  const next = blindsAt(clock.level + 1);
  const pendingLevel = clock.level > state.level;
  const winners = new Set(state.result ? Object.keys(state.result.won).map(Number) : []);
  const middle = collectedPot(state);

  return (
    <div className="table-screen">
      <header className="table-header">
        <button type="button" className="ghost-btn" onClick={onQuit} title="Leave the table (counts as a loss)">
          ← Lobby
        </button>
        <div className="header-prize">
          <span className={`mult-chip ${multiplierClass(tier.multiplier)}`}>x{tier.multiplier.toLocaleString("en-GB")}</span>
          <span>
            Prize pool <strong>{formatMoney(prize)}</strong>
          </span>
          <span className="muted">
            {format.name} · Buy-in {formatMoney(buyIn)}
          </span>
        </div>
        <div className="header-level">
          <div>
            Level {state.level + 1} · <strong>{state.blinds.sb}/{state.blinds.bb}</strong>
          </div>
          <div className="muted">
            {pendingLevel ? "New blinds next hand" : `Next ${next.sb}/${next.bb} in ${formatClock(clock.remaining)}`}
          </div>
        </div>
        <div className="header-toggles">
          <button type="button" className={`ghost-btn ${inBB ? "on" : ""}`} onClick={() => setInBB((v) => !v)}>
            BB
          </button>
          <button type="button" className={`ghost-btn ${fourColor ? "on" : ""}`} onClick={() => setFourColor((v) => !v)} title="Four-colour deck">
            4♣
          </button>
          <button type="button" className={`ghost-btn ${showLog ? "on" : ""}`} onClick={() => setShowLog((v) => !v)}>
            Log
          </button>
        </div>
      </header>

      <div className="table-stage">
        <div
          className="table-felt"
          data-sb={state.blinds.sb}
          data-bb={state.blinds.bb}
          data-level={state.level}
          data-pot={potTotal(state)}
          data-hand={state.handNumber}
        >
          <div className="felt-inner">
            <div className="felt-logo">{format.id === "nitro" ? "NITRO" : "EXPRESSO"}</div>

            <div className="pot">
              {potTotal(state) > 0 && !state.result && (
                <>
                  <div className="pot-total">Pot: {formatChips(potTotal(state), bb, inBB)}</div>
                  {middle > 0 && (
                    <div className="pot-chips">
                      <ChipStack amount={middle} />
                      <span>{formatChips(middle, bb, inBB)}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="board">
              {state.board.map((c, i) => (
                <PlayingCard key={`${c.rank}${c.suit}`} card={c} size="md" fourColor={fourColor} dealIndex={state.street === "flop" ? i : 0} />
              ))}
              {Array.from({ length: 5 - state.board.length }).map((_, i) => (
                <div key={`slot${i}`} className="board-slot" />
              ))}
            </div>
          </div>

          {state.players.map((p) => {
            const position = POSITIONS[(p.id - heroId + 3) % 3];
            return (
              p.bet > 0 && (
                <div key={`bet${p.id}`} className={`bet bet-${position}`}>
                  <ChipStack amount={p.bet} />
                  <span>{formatChips(p.bet, bb, inBB)}</span>
                </div>
              )
            );
          })}

          {state.players.map((p) => {
            const position = POSITIONS[(p.id - heroId + 3) % 3];
            const pot = state.result?.pots.find((x) => x.winners.includes(p.id));
            return (
              <Seat
                key={p.id}
                player={p}
                position={position}
                showCards={state.cardsExposed && !p.folded}
                isDealer={state.dealer === p.id}
                acting={state.phase === "betting" && state.toAct === p.id}
                turnKey={`${state.handNumber}-${state.street}-${state.currentBet}-${state.toAct}`}
                totalTime={heroTimeMs}
                winner={winners.has(p.id)}
                won={state.result?.won[p.id] ?? 0}
                handName={state.result?.showdown ? (winners.has(p.id) ? (pot?.handName ?? null) : (state.result.hands[p.id] ?? null)) : null}
                bb={bb}
                inBB={inBB}
                fourColor={fourColor}
              />
            );
          })}
        </div>

        {showLog && (
          <aside className="hand-log">
            <div className="hand-log-title">Hand history</div>
            <ol>
              {state.log.slice().reverse().map((line, i) => (
                <li key={state.log.length - i} className={line.startsWith("—") ? "log-hand" : ""}>
                  {line}
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

      <ActionBar
        state={state}
        heroId={heroId}
        heroToAct={heroToAct}
        inBB={inBB}
        preAction={preAction}
        onPreAction={(p) => {
          setPreAction(p);
          setPreActionHand(handNumber);
        }}
        onAct={act}
      />
    </div>
  );
}

const CHIP_VALUES = [
  { v: 500, c: "chip-purple" },
  { v: 100, c: "chip-black" },
  { v: 25, c: "chip-green" },
  { v: 5, c: "chip-red" },
  { v: 1, c: "chip-white" },
];

function ChipStack({ amount }: { amount: number }) {
  const chips: string[] = [];
  let rest = amount;
  for (const { v, c } of CHIP_VALUES) {
    while (rest >= v && chips.length < 8) {
      chips.push(c);
      rest -= v;
    }
  }
  return (
    <span className="chip-stack" aria-hidden>
      {chips.slice(0, 6).map((c, i) => (
        <span key={i} className={`chip ${c}`} style={{ bottom: i * 3 }} />
      ))}
    </span>
  );
}
