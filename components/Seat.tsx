"use client";

import { useEffect, useState } from "react";
import type { Player } from "@/lib/poker/engine";
import { PlayingCard } from "./PlayingCard";
import { formatChips } from "./format";

interface Props {
  player: Player;
  position: "bottom" | "left" | "right";
  showCards: boolean;
  isDealer: boolean;
  acting: boolean;
  /** Changes whenever a new decision starts, to restart the shot clock. */
  turnKey: string;
  totalTime: number;
  winner: boolean;
  won: number;
  handName: string | null;
  bb: number;
  inBB: boolean;
  fourColor: boolean;
}

const AVATAR_COLORS = ["#e3001b", "#f5a524", "#3b82f6"];

export function Seat(props: Props) {
  const { player, position, showCards, isDealer, acting, turnKey, totalTime, winner, won, handName, bb, inBB, fourColor } = props;

  if (player.out) {
    return (
      <div className={`seat seat-${position} seat-out`} data-position={position} data-out="true" data-stack={0} data-bet={0}>
        <div className="seat-plate">
          <div className="seat-name">{player.name}</div>
          <div className="seat-stack">{player.place ? `Out · ${placeLabel(player.place)}` : "Out"}</div>
        </div>
      </div>
    );
  }

  const isHero = player.isHero;
  const faceUp = isHero || showCards;
  const hasCards = player.hole.length > 0 && !player.folded;

  return (
    <div
      className={`seat seat-${position} ${acting ? "seat-acting" : ""} ${player.folded ? "seat-folded" : ""} ${winner ? "seat-winner" : ""}`}
      data-position={position}
      data-out="false"
      data-stack={player.stack}
      data-bet={player.bet}
      data-folded={player.folded}
      data-allin={player.allIn}
      data-dealer={isDealer}
      data-last-action={player.lastAction ?? ""}
      data-bot-level={player.botLevel ?? ""}
    >
      <div className={`seat-cards ${isHero ? "seat-cards-hero" : ""}`}>
        {hasCards &&
          player.hole.map((c, i) => (
            <PlayingCard
              key={`${c.rank}${c.suit}`}
              card={c}
              faceDown={!faceUp}
              size={isHero ? "lg" : "md"}
              fourColor={fourColor}
              dealIndex={i}
            />
          ))}
        {isHero && player.folded && player.hole.length > 0 &&
          player.hole.map((c) => <PlayingCard key={`${c.rank}${c.suit}`} card={c} size="lg" fourColor={fourColor} dim />)}
      </div>

      <div className="seat-plate">
        <div className="seat-avatar" style={{ background: AVATAR_COLORS[player.id % AVATAR_COLORS.length] }}>
          {player.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="seat-info">
          <div className="seat-name">
            {player.name}
            {player.botLevel && <span className={`bot-tag bot-${player.botLevel}`}>{player.botLevel}</span>}
          </div>
          <div className="seat-stack">
            {player.allIn && player.stack === 0 ? "All-in" : formatChips(player.stack, bb, inBB)}
          </div>
        </div>
        {acting && <ShotClock key={turnKey} total={totalTime} />}
        {isDealer && <div className="dealer-btn">D</div>}
      </div>

      {player.lastAction && !winner && <div className={`seat-action action-${player.lastAction.toLowerCase().replace(/\W/g, "")}`}>{player.lastAction}</div>}
      {winner && (
        <div className="seat-won">
          +{formatChips(won, bb, inBB)}
          {handName && <span>{handName}</span>}
        </div>
      )}
      {!winner && handName && showCards && <div className="seat-hand">{handName}</div>}
    </div>
  );
}

function placeLabel(n: number) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : "3rd";
}

/** Bar that drains over `total` ms from the moment it mounts. */
function ShotClock({ total }: { total: number }) {
  const [progress, setProgress] = useState(1);
  useEffect(() => {
    const start = Date.now();
    let raf = 0;
    const tick = () => {
      setProgress(Math.max(0, 1 - (Date.now() - start) / total));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total]);
  return (
    <div className="seat-timer">
      <div className="seat-timer-fill" style={{ transform: `scaleX(${progress})` }} data-low={progress < 0.33} />
    </div>
  );
}
