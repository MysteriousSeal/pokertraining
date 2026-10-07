"use client";

import { useEffect, useMemo, useState } from "react";
import { type Action, type GameState, legalActions, potTotal } from "@/lib/poker/engine";
import { formatChips } from "./format";

export type PreAction = "checkFold" | "callAny" | null;

interface Props {
  state: GameState;
  heroId: number;
  heroToAct: boolean;
  inBB: boolean;
  preAction: PreAction;
  onPreAction: (p: PreAction) => void;
  onAct: (a: Action) => void;
}

export function ActionBar({ state, heroId, heroToAct, inBB, preAction, onPreAction, onAct }: Props) {
  const hero = state.players[heroId];
  const legal = heroToAct ? legalActions(state) : null;
  const bb = state.blinds.bb;

  const presets = useMemo(() => {
    if (!legal || !legal.canRaise) return [];
    const pot = potTotal(state);
    const clamp = (v: number) => Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, v)));
    const potRaise = (f: number) => clamp(state.currentBet + f * (pot + legal.toCall));
    const list =
      state.street === "preflop"
        ? [
            { label: "Min", value: legal.minRaiseTo },
            { label: "2.5x", value: clamp(state.currentBet * 2.5) },
            { label: "3x", value: clamp(state.currentBet * 3) },
            { label: "Pot", value: potRaise(1) },
          ]
        : [
            { label: "⅓", value: potRaise(1 / 3) },
            { label: "½", value: potRaise(1 / 2) },
            { label: "¾", value: potRaise(3 / 4) },
            { label: "Pot", value: potRaise(1) },
          ];
    return [...list, { label: "All-in", value: legal.maxRaiseTo }];
  }, [legal, state]);

  const [raiseTo, setRaiseTo] = useState(0);
  const turnKey = `${state.handNumber}-${state.street}-${state.currentBet}-${heroToAct}`;
  const [lastTurnKey, setLastTurnKey] = useState(turnKey);
  // Reset the slider to the min-raise whenever a new decision starts.
  if (turnKey !== lastTurnKey) {
    setLastTurnKey(turnKey);
    if (legal) setRaiseTo(legal.minRaiseTo);
  }
  const amount = legal ? Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, raiseTo || legal.minRaiseTo)) : 0;

  // Keyboard shortcuts: F fold, C check/call, R raise, A all-in.
  useEffect(() => {
    if (!legal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "number") return;
      const k = e.key.toLowerCase();
      if (k === "f" && legal.canFold) onAct({ type: "fold" });
      else if (k === "c") onAct({ type: legal.canCheck ? "check" : "call" });
      else if (k === "r" && legal.canRaise) onAct({ type: "raise", amount });
      else if (k === "a" && legal.canRaise) onAct({ type: "raise", amount: legal.maxRaiseTo });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [legal, amount, onAct]);

  const fmt = (c: number) => formatChips(c, bb, inBB);

  if (!legal) {
    const canPre = state.phase === "betting" && !hero.folded && !hero.allIn && !hero.out && hero.hole.length > 0;
    return (
      <div className="action-bar action-bar-idle">
        {canPre && (
          <div className="pre-actions">
            <label className={`pre-action ${preAction === "checkFold" ? "on" : ""}`}>
              <input type="checkbox" checked={preAction === "checkFold"} onChange={(e) => onPreAction(e.target.checked ? "checkFold" : null)} />
              Check / Fold
            </label>
            <label className={`pre-action ${preAction === "callAny" ? "on" : ""}`}>
              <input type="checkbox" checked={preAction === "callAny"} onChange={(e) => onPreAction(e.target.checked ? "callAny" : null)} />
              Call any
            </label>
          </div>
        )}
      </div>
    );
  }

  const isAllIn = amount >= legal.maxRaiseTo;
  const raiseLabel = isAllIn ? "All-in" : state.currentBet === 0 ? "Bet" : "Raise to";

  return (
    <div className="action-bar">
      {legal.canRaise && (
        <div className="raise-panel">
          <div className="raise-presets">
            {presets.map((p) => (
              <button key={p.label} type="button" className={`preset ${amount === p.value ? "on" : ""}`} onClick={() => setRaiseTo(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="raise-slider">
            <button type="button" className="step" onClick={() => setRaiseTo(Math.max(legal.minRaiseTo, amount - bb))} aria-label="Decrease">
              −
            </button>
            <input
              type="range"
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              step={1}
              value={amount}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
              aria-label="Raise amount"
            />
            <button type="button" className="step" onClick={() => setRaiseTo(Math.min(legal.maxRaiseTo, amount + bb))} aria-label="Increase">
              +
            </button>
            <input
              className="raise-input"
              type="number"
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              value={amount}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
            />
          </div>
        </div>
      )}
      <div className="action-buttons">
        {legal.canFold && (
          <button type="button" className="act act-fold" onClick={() => onAct({ type: "fold" })}>
            Fold<kbd>F</kbd>
          </button>
        )}
        {legal.canCheck ? (
          <button type="button" className="act act-call" onClick={() => onAct({ type: "check" })}>
            Check<kbd>C</kbd>
          </button>
        ) : (
          <button type="button" className="act act-call" onClick={() => onAct({ type: "call" })}>
            {legal.callAmount >= hero.stack ? "All-in" : "Call"} <strong>{fmt(legal.callAmount)}</strong>
            <kbd>C</kbd>
          </button>
        )}
        {legal.canRaise && (
          <button type="button" className="act act-raise" onClick={() => onAct({ type: "raise", amount })}>
            {raiseLabel} <strong>{fmt(amount)}</strong>
            <kbd>R</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
