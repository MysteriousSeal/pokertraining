"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BotLevel, GameState } from "@/lib/poker/engine";
import { ordinal } from "@/lib/poker/engine";
import {
  BUY_INS,
  FORMATS,
  drawMultiplier,
  formatMoney,
  maxJackpot,
  multiplierClass,
  multiplierTiers,
  type Format,
  type FormatId,
  type MultiplierTier,
} from "@/lib/poker/expresso";
import { randomInt } from "@/lib/poker/cards";
import { randomNames } from "@/lib/poker/names";
import { MultiplierWheel } from "./MultiplierWheel";
import { PokerTable } from "./PokerTable";


const STORAGE_KEY = "expresso-trainer:v1";

/** How opponents of each level play, in words. */
function levelLabel(level: number): string {
  if (level <= 15) return "Total beginner";
  if (level <= 35) return "Recreational";
  if (level <= 55) return "Casual regular";
  if (level <= 75) return "Solid regular";
  if (level <= 90) return "Strong";
  if (level <= 99) return "Expert";
  return "Strongest bot";
}
const START_BANKROLL = 1000;

interface Stats {
  bankroll: number;
  played: number;
  wins: number;
  profit: number;
  heroName: string;
}

const DEFAULT_STATS: Stats = { bankroll: START_BANKROLL, played: 0, wins: 0, profit: 0, heroName: "You" };

type Screen =
  | { kind: "lobby" }
  | { kind: "wheel"; format: Format; buyIn: number; tier: MultiplierTier; reel: number[]; names: string[]; botLevels: (BotLevel | null)[] }
  | { kind: "table"; format: Format; buyIn: number; tier: MultiplierTier; names: string[]; botLevels: (BotLevel | null)[]; gameId: number }
  | { kind: "result"; format: Format; buyIn: number; tier: MultiplierTier; place: number; prize: number };

function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_STATS;
}

function saveStats(s: Stats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

/** Reel of decoy multipliers ending on the real draw. */
function buildReel(buyIn: number, result: number): number[] {
  const decoys = multiplierTiers(buyIn).map((m) => m.multiplier);
  const reel: number[] = [];
  for (let i = 0; i < 34; i++) reel.push(decoys[randomInt(decoys.length)]);
  reel.push(result);
  return reel;
}

export function PokerApp() {
  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const [loaded, setLoaded] = useState(false);
  // `?speed=20` fast-forwards the table, used by the AI trainer.
  const [speed, setSpeed] = useState(1);
  const [screen, setScreen] = useState<Screen>({ kind: "lobby" });
  const [buyIn, setBuyIn] = useState(1);
  const [formatId, setFormatId] = useState<FormatId>("expresso");
  const [botLevel, setBotLevel] = useState(50);
  // Random: each bot gets its own hidden level 1–100 every game, like AI training.
  const [randomLevels, setRandomLevels] = useState(false);

  useEffect(() => {
    // localStorage only exists in the browser, so load after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStats(loadStats());
    setLoaded(true);
    const requested = Number(new URLSearchParams(window.location.search).get("speed"));
    if (requested > 1) setSpeed(Math.min(requested, 100));
  }, []);

  const updateStats = useCallback((fn: (s: Stats) => Stats) => {
    setStats((prev) => {
      const next = fn(prev);
      saveStats(next);
      return next;
    });
  }, []);

  const register = (amount: number, format: Format) => {
    if (stats.bankroll < amount) return;
    updateStats((s) => ({ ...s, bankroll: +(s.bankroll - amount).toFixed(2), played: s.played + 1, profit: +(s.profit - amount).toFixed(2) }));
    const tier = drawMultiplier(amount);
    const hero = stats.heroName || "You";
    const names = [hero, ...randomNames(2, [hero])];
    const level = () => (randomLevels ? 1 + randomInt(100) : botLevel);
    const botLevels: (BotLevel | null)[] = [null, level(), level()];
    setScreen({ kind: "wheel", format, buyIn: amount, tier, reel: buildReel(amount, tier.multiplier), names, botLevels });
  };

  const onWheelDone = useCallback(() => {
    setScreen((s) => (s.kind === "wheel" ? { kind: "table", format: s.format, buyIn: s.buyIn, tier: s.tier, names: s.names, botLevels: s.botLevels, gameId: Date.now() } : s));
  }, []);

  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const onGameOver = useCallback(
    (final: GameState) => {
      const s = screenRef.current;
      if (s.kind !== "table") return;
      const hero = final.players.find((p) => p.isHero)!;
      const place = hero.place ?? 3;
      const prize = +(s.buyIn * s.tier.multiplier * s.tier.payouts[place - 1]).toFixed(2);
      if (prize > 0)
        updateStats((st) => ({
          ...st,
          bankroll: +(st.bankroll + prize).toFixed(2),
          profit: +(st.profit + prize).toFixed(2),
          wins: st.wins + (place === 1 ? 1 : 0),
        }));
      const next: Screen = { kind: "result", format: s.format, buyIn: s.buyIn, tier: s.tier, place, prize };
      screenRef.current = next;
      setScreen(next);
    },
    [updateStats],
  );

  if (screen.kind === "wheel") {
    return <MultiplierWheel reel={screen.reel} tier={screen.tier} buyIn={screen.buyIn} onDone={onWheelDone} />;
  }

  if (screen.kind === "table") {
    return (
      <PokerTable
        key={screen.gameId}
        names={screen.names}
        botLevels={screen.botLevels}
        format={screen.format}
        speed={speed}
        buyIn={screen.buyIn}
        tier={screen.tier}
        onGameOver={onGameOver}
        onQuit={() => {
          if (confirm("Leave the table? Your buy-in is lost.")) setScreen({ kind: "lobby" });
        }}
      />
    );
  }

  if (screen.kind === "result") {
    const won = screen.place === 1;
    return (
      <div className="result-screen">
        <div
          className={`result-card ${won ? "result-win" : ""}`}
          data-place={screen.place}
          data-prize={screen.prize}
          data-buyin={screen.buyIn}
          data-multiplier={screen.tier.multiplier}
        >
          <div className="result-place">{ordinal(screen.place)}</div>
          <div className="result-title">{won ? `You won the ${screen.format.name}!` : screen.prize > 0 ? "In the money" : "Eliminated"}</div>
          <div className="result-prize">{screen.prize > 0 ? `+${formatMoney(screen.prize)}` : formatMoney(0)}</div>
          <div className="muted">
            x{screen.tier.multiplier.toLocaleString("en-GB")} · {screen.format.name} {formatMoney(screen.buyIn)} · Bankroll {formatMoney(stats.bankroll)}
          </div>
          <div className="result-actions">
            <button type="button" className="primary-btn" disabled={stats.bankroll < screen.buyIn} onClick={() => register(screen.buyIn, screen.format)}>
              Play again · {formatMoney(screen.buyIn)}
            </button>
            <button type="button" className="ghost-btn" onClick={() => setScreen({ kind: "lobby" })}>
              Lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lobby">
      <header className="lobby-header">
        <div className="brand">
          <span className="brand-mark">E</span>
          <div>
            <div className="brand-name">Expresso Trainer</div>
            <div className="muted">3-max hyper-turbo · play money</div>
          </div>
        </div>
        <div className="bankroll">
          <span className="muted">Bankroll</span>
          <strong>{loaded ? formatMoney(stats.bankroll) : "—"}</strong>
        </div>
      </header>

      <section className="lobby-main">
        <h1>
          Spin up an <em>Expresso</em>
        </h1>
        <p className="muted">
          Three players, one winner. The prize pool is drawn before the first hand, from x2 up to {formatMoney(maxJackpot(buyIn))}{" "}
          for a {formatMoney(buyIn)} buy-in.
        </p>

        <div className={`level-picker ${randomLevels ? "is-random" : ""}`}>
          <span className="level-head">
            <span className="format-name">{randomLevels ? "Opponents · random levels" : `Opponents · level ${botLevel}`}</span>
            <span className="muted">{randomLevels ? "Each bot 1–100, hidden" : levelLabel(botLevel)}</span>
            <label className="random-toggle">
              <input id="random-levels" type="checkbox" checked={randomLevels} onChange={(e) => setRandomLevels(e.target.checked)} />
              <span className="switch" aria-hidden />
              Random
            </label>
          </span>
          <input
            id="bot-level"
            type="range"
            min={1}
            max={100}
            value={botLevel}
            disabled={randomLevels}
            onChange={(e) => setBotLevel(Number(e.target.value))}
            aria-label="Opponent level"
          />
          <span className="level-scale muted">
            <span>1 · total beginner</span>
            <span>100 · strongest bot</span>
          </span>
        </div>

        <div className="formats" role="radiogroup" aria-label="Format">
          {Object.values(FORMATS).map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={formatId === f.id}
              className={`format ${formatId === f.id ? "on" : ""}`}
              onClick={() => setFormatId(f.id)}
            >
              <span className="format-name">{f.name}</span>
              <span className="muted">
                {f.startingStack} chips · {formatLevel(f.levelMs)} levels · blinds 10/20
              </span>
            </button>
          ))}
        </div>

        <div className="buyins">
          {BUY_INS.map((b) => (
            <button key={b} type="button" className={`buyin ${buyIn === b ? "on" : ""}`} data-buyin={b} onClick={() => setBuyIn(b)} disabled={loaded && stats.bankroll < b}>
              <span className="buyin-amount">{formatMoney(b)}</span>
              <span className="buyin-max">up to {formatMoney(maxJackpot(b))}</span>
            </button>
          ))}
        </div>

        <button type="button" className="primary-btn play-btn" disabled={!loaded || stats.bankroll < buyIn} onClick={() => register(buyIn, FORMATS[formatId])}>
          Play {FORMATS[formatId].name} · {formatMoney(buyIn)}
        </button>

        <div className="lobby-bottom">
          <div className="stats">
            <div>
              <span className="muted">Played</span>
              <strong>{stats.played}</strong>
            </div>
            <div>
              <span className="muted">Wins</span>
              <strong>{stats.played ? `${stats.wins} (${Math.round((stats.wins / stats.played) * 100)}%)` : "0"}</strong>
            </div>
            <div>
              <span className="muted">Profit</span>
              <strong className={stats.profit >= 0 ? "pos" : "neg"}>{formatMoney(stats.profit)}</strong>
            </div>
          </div>

          <div className="odds">
            <div className="odds-title">Jackpots · {formatMoney(buyIn)}</div>
            {multiplierTiers(buyIn).slice().reverse().map((m) => (
              <div key={m.multiplier} className="odds-row">
                <span className={`mult-chip ${multiplierClass(m.multiplier)}`}>x{m.multiplier.toLocaleString("en-GB")}</span>
                <span className="odds-prize">{formatMoney(buyIn * m.multiplier)}</span>
                <span className="muted">{formatOdds(m)}</span>
              </div>
            ))}
            <div className="odds-note muted">From x50 the jackpot is split 80% / 12% / 8%.</div>
          </div>

          <div className="lobby-settings">
            <label>
              <span className="muted">Your name</span>
              <input
                value={stats.heroName}
                maxLength={14}
                onChange={(e) => updateStats((s) => ({ ...s, heroName: e.target.value }))}
              />
            </label>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                if (confirm("Reset bankroll and stats?")) updateStats((s) => ({ ...DEFAULT_STATS, heroName: s.heroName }));
              }}
            >
              Reset bankroll
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatOdds({ weight, outOf }: MultiplierTier) {
  const pct = (weight / outOf) * 100;
  if (pct >= 1) return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`;
  return `1 in ${Math.round(outOf / weight).toLocaleString("en-GB")}`;
}

function formatLevel(ms: number) {
  const min = Math.floor(ms / 60_000);
  const sec = (ms % 60_000) / 1000;
  return sec ? `${min} min ${sec}` : `${min} min`;
}
