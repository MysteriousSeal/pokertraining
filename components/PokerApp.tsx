"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameState } from "@/lib/poker/engine";
import { ordinal } from "@/lib/poker/engine";
import { BUY_INS, MULTIPLIERS, drawMultiplier, formatMoney, type MultiplierTier } from "@/lib/poker/expresso";
import { randomInt, shuffle } from "@/lib/poker/cards";
import { MultiplierWheel } from "./MultiplierWheel";
import { PokerTable } from "./PokerTable";

const BOT_NAMES = [
  "NitroNico", "LaRiviere", "Fishbowl", "ShoveMcGee", "AceVentura", "BlindThief", "TiltLord",
  "Coolerz", "SpinQueen", "RiverRat", "Donkzilla", "PotOdds", "Snapcall", "SuitedJack",
];

const STORAGE_KEY = "expresso-trainer:v1";
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
  | { kind: "wheel"; buyIn: number; tier: MultiplierTier; reel: number[]; names: string[] }
  | { kind: "table"; buyIn: number; tier: MultiplierTier; names: string[]; gameId: number }
  | { kind: "result"; buyIn: number; tier: MultiplierTier; place: number; prize: number; names: string[] };

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
function buildReel(result: number): number[] {
  const decoys = MULTIPLIERS.map((m) => m.multiplier);
  const reel: number[] = [];
  for (let i = 0; i < 34; i++) reel.push(decoys[randomInt(decoys.length)]);
  reel.push(result);
  return reel;
}

export function PokerApp() {
  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const [loaded, setLoaded] = useState(false);
  const [screen, setScreen] = useState<Screen>({ kind: "lobby" });
  const [buyIn, setBuyIn] = useState(1);

  useEffect(() => {
    // localStorage only exists in the browser, so load after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStats(loadStats());
    setLoaded(true);
  }, []);

  const updateStats = useCallback((fn: (s: Stats) => Stats) => {
    setStats((prev) => {
      const next = fn(prev);
      saveStats(next);
      return next;
    });
  }, []);

  const register = (amount: number) => {
    if (stats.bankroll < amount) return;
    updateStats((s) => ({ ...s, bankroll: +(s.bankroll - amount).toFixed(2), played: s.played + 1, profit: +(s.profit - amount).toFixed(2) }));
    const tier = drawMultiplier();
    const names = [stats.heroName || "You", ...shuffle(BOT_NAMES).slice(0, 2)];
    setScreen({ kind: "wheel", buyIn: amount, tier, reel: buildReel(tier.multiplier), names });
  };

  const onWheelDone = useCallback(() => {
    setScreen((s) => (s.kind === "wheel" ? { kind: "table", buyIn: s.buyIn, tier: s.tier, names: s.names, gameId: Date.now() } : s));
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
      const next: Screen = { kind: "result", buyIn: s.buyIn, tier: s.tier, place, prize, names: s.names };
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
        <div className={`result-card ${won ? "result-win" : ""}`}>
          <div className="result-place">{ordinal(screen.place)}</div>
          <div className="result-title">{won ? "You won the Expresso!" : "Eliminated"}</div>
          <div className="result-prize">{screen.prize > 0 ? `+${formatMoney(screen.prize)}` : formatMoney(0)}</div>
          <div className="muted">
            x{screen.tier.multiplier} · Buy-in {formatMoney(screen.buyIn)} · Bankroll {formatMoney(stats.bankroll)}
          </div>
          <div className="result-actions">
            <button type="button" className="primary-btn" disabled={stats.bankroll < screen.buyIn} onClick={() => register(screen.buyIn)}>
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
            <div className="muted">3-max hyper-turbo · 500 chips · play money</div>
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
          Three players, one winner. The prize pool is drawn before the first hand, from x2 up to x10,000 your buy-in.
        </p>

        <div className="buyins">
          {BUY_INS.map((b) => (
            <button key={b} type="button" className={`buyin ${buyIn === b ? "on" : ""}`} onClick={() => setBuyIn(b)} disabled={loaded && stats.bankroll < b}>
              <span className="buyin-amount">{formatMoney(b)}</span>
              <span className="buyin-max">up to {formatMoney(b * 10000)}</span>
            </button>
          ))}
        </div>

        <button type="button" className="primary-btn play-btn" disabled={!loaded || stats.bankroll < buyIn} onClick={() => register(buyIn)}>
          Play · {formatMoney(buyIn)}
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
            <div className="odds-title">Multipliers</div>
            {MULTIPLIERS.slice().reverse().map((m) => (
              <div key={m.multiplier} className="odds-row">
                <span className={`mult-chip mult-${m.multiplier}`}>x{m.multiplier.toLocaleString("en-GB")}</span>
                <span className="muted">{formatOdds(m.weight)}</span>
              </div>
            ))}
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

function formatOdds(weight: number) {
  const total = MULTIPLIERS.reduce((s, m) => s + m.weight, 0);
  const pct = (weight / total) * 100;
  if (pct >= 1) return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
  return `1 in ${Math.round(total / weight).toLocaleString("en-GB")}`;
}
