import { type Card, SUIT_SYMBOL, cardKey, rankLabel } from "@/lib/poker/cards";

interface Props {
  card?: Card;
  faceDown?: boolean;
  size?: "sm" | "md" | "lg";
  fourColor?: boolean;
  dim?: boolean;
  highlight?: boolean;
  /** Stagger index for the deal animation. */
  dealIndex?: number;
}

export function PlayingCard({ card, faceDown, size = "md", fourColor, dim, highlight, dealIndex = 0 }: Props) {
  const style = { animationDelay: `${dealIndex * 90}ms` };
  if (!card || faceDown) {
    return <div className={`pcard pcard-${size} pcard-back`} style={style} aria-label="Face-down card" />;
  }
  const rank = rankLabel(card.rank) === "T" ? "10" : rankLabel(card.rank);
  return (
    <div
      className={`pcard pcard-${size} suit-${card.suit} ${fourColor ? "four-color" : ""} ${dim ? "pcard-dim" : ""} ${highlight ? "pcard-hl" : ""}`}
      style={style}
      aria-label={`${rank}${SUIT_SYMBOL[card.suit]}`}
      data-card={dim ? undefined : cardKey(card)}
    >
      <span className="pcard-rank">{rank}</span>
      <span className="pcard-suit">{SUIT_SYMBOL[card.suit]}</span>
      <span className="pcard-pip">{SUIT_SYMBOL[card.suit]}</span>
    </div>
  );
}
