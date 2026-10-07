"use client";

import { useEffect, useState } from "react";
import { formatMoney, type MultiplierTier } from "@/lib/poker/expresso";

interface Props {
  reel: number[];
  tier: MultiplierTier;
  buyIn: number;
  onDone: () => void;
}

const ITEM_H = 96;
const SPIN_MS = 4200;

/** Slot-machine reel that lands on the drawn multiplier (the last reel item). */
export function MultiplierWheel({ reel, tier, buyIn, onDone }: Props) {
  const [spinning, setSpinning] = useState(false);
  const [landed, setLanded] = useState(false);

  useEffect(() => {
    const start = requestAnimationFrame(() => requestAnimationFrame(() => setSpinning(true)));
    const land = setTimeout(() => setLanded(true), SPIN_MS + 100);
    const done = setTimeout(onDone, SPIN_MS + 2300);
    return () => {
      cancelAnimationFrame(start);
      clearTimeout(land);
      clearTimeout(done);
    };
  }, [onDone]);

  const offset = spinning ? (reel.length - 1) * ITEM_H : 0;
  const big = tier.multiplier >= 10;

  return (
    <div className="wheel-screen">
      <div className="wheel-title">Drawing the prize pool…</div>
      <div className={`wheel ${landed ? "wheel-landed" : ""} ${landed && big ? "wheel-jackpot" : ""}`}>
        <div className="wheel-window">
          <div
            className="wheel-reel"
            style={{
              transform: `translateY(-${offset}px)`,
              transition: spinning ? `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.65, 0.12, 1)` : "none",
            }}
          >
            {reel.map((m, i) => (
              <div key={i} className={`wheel-item mult-${m}`} style={{ height: ITEM_H }}>
                x{m.toLocaleString("en-GB")}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={`wheel-prize ${landed ? "show" : ""}`}>
        Prize pool <strong>{formatMoney(buyIn * tier.multiplier)}</strong>
        <div className="muted">
          {tier.payouts[1] > 0
            ? `1st ${formatMoney(buyIn * tier.multiplier * tier.payouts[0])} · 2nd & 3rd ${formatMoney(buyIn * tier.multiplier * tier.payouts[1])}`
            : "Winner takes all"}
        </div>
      </div>
      <button type="button" className="ghost-btn wheel-skip" onClick={onDone}>
        Skip
      </button>
    </div>
  );
}
