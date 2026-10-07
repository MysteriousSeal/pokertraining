export function formatChips(chips: number, bb: number, inBB: boolean): string {
  if (inBB) {
    const v = chips / bb;
    return `${v >= 10 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(1)} BB`;
  }
  return chips.toLocaleString("en-GB");
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
