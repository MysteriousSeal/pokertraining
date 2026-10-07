"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Action, type BotLevel, type GameState, advance, applyAction, createGame, startHand } from "@/lib/poker/engine";
import { decideBotAction } from "@/lib/poker/bot";
import type { Format } from "@/lib/poker/expresso";
import { randomInt } from "@/lib/poker/cards";

export const HERO_TIME_MS = 15_000;

const DELAY = {
  botMin: 700,
  botMax: 1800,
  streetEnd: 650,
  runout: 1300,
  handOverFold: 1400,
  handOverShowdown: 3200,
  gameOver: 2600,
};

export interface ExpressoClock {
  level: number;
  /** ms until the next blind level. */
  remaining: number;
}

/**
 * `speed` > 1 fast-forwards the table (bot thinking, pauses and the blind clock)
 * so automated players can train against the real UI.
 */
export function useExpressoGame(
  names: string[],
  format: Format,
  onGameOver: (final: GameState) => void,
  speed = 1,
  botLevels: (BotLevel | null)[] = [],
) {
  const heroTimeMs = speed > 1 ? Math.max(HERO_TIME_MS / speed, 5_000) : HERO_TIME_MS;
  // This component only mounts after a user action (never prerendered), so the
  // shuffle in the lazy initializer runs in the browser.
  const [state, setState] = useState<GameState>(() => startHand(createGame(names, format.startingStack, { botLevels }), 0));
  const [startedAt] = useState(() => Date.now());
  const [clock, setClock] = useState<ExpressoClock>({ level: 0, remaining: format.levelMs });
  const levelRef = useRef(0);
  const onGameOverRef = useRef(onGameOver);

  useEffect(() => {
    onGameOverRef.current = onGameOver;
  }, [onGameOver]);

  // Blind level clock. New blinds apply from the next hand, like a real tournament.
  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = (Date.now() - startedAt) * speed;
      const level = Math.floor(elapsed / format.levelMs);
      levelRef.current = level;
      setClock({ level, remaining: (format.levelMs - (elapsed % format.levelMs)) / speed });
    }, 250 / Math.min(speed, 10));
    return () => clearInterval(id);
  }, [startedAt, format.levelMs, speed]);

  const heroId = state.players.find((p) => p.isHero)!.id;
  const heroToAct = state.phase === "betting" && state.toAct === heroId;

  // Drive everything that isn't the hero's decision.
  useEffect(() => {
    let delay: number;
    let step: (s: GameState) => GameState;

    switch (state.phase) {
      case "betting":
        if (state.toAct === heroId) return;
        delay = DELAY.botMin + randomInt(DELAY.botMax - DELAY.botMin);
        step = (s) => applyAction(s, decideBotAction(s));
        break;
      case "streetEnd":
        delay = DELAY.streetEnd;
        step = advance;
        break;
      case "runout":
        delay = DELAY.runout;
        step = advance;
        break;
      case "handOver": {
        const hero = state.players[heroId];
        // Hero busted: no point dealing on, end the game for them.
        if (hero.out) {
          const id = setTimeout(() => onGameOverRef.current(state), DELAY.gameOver / speed);
          return () => clearTimeout(id);
        }
        delay = state.result?.showdown ? DELAY.handOverShowdown : DELAY.handOverFold;
        step = (s) => startHand(s, levelRef.current);
        break;
      }
      case "gameOver": {
        const id = setTimeout(() => onGameOverRef.current(state), DELAY.gameOver / speed);
        return () => clearTimeout(id);
      }
    }

    const id = setTimeout(() => {
      // Compute outside the updater: it may run twice in StrictMode and steps are random.
      const next = step(state);
      setState((s) => (s === state ? next : s));
    }, delay / speed);
    return () => clearTimeout(id);
  }, [state, heroId, speed]);

  const act = useCallback(
    (action: Action) => {
      setState((s) => (s.phase === "betting" && s.toAct === heroId ? applyAction(s, action) : s));
    },
    [heroId],
  );

  // Hero shot clock: auto check, otherwise fold.
  useEffect(() => {
    if (!heroToAct) return;
    const id = setTimeout(() => act({ type: "fold" }), heroTimeMs);
    return () => clearTimeout(id);
  }, [heroToAct, state.handNumber, state.street, state.currentBet, act, heroTimeMs]);

  return { state, clock, heroId, heroToAct, heroTimeMs, act };
}
