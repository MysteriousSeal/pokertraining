/**
 * Solve heads-up push/fold (small blind shoves or folds, big blind calls or folds)
 * for stacks of 1–30 big blinds, and write equilibrium charts:
 *   push[hand] = largest stack (BB) at which the small blind shoves it
 *   call[hand] = largest stack (BB) at which the big blind calls a shove with it
 * 99 means "at every stack up to 30 BB".
 *
 *   npx tsx scripts/gen-pushfold.ts
 *
 * Method: class-vs-class equities with card removal (Monte Carlo), then
 * fictitious play on chip EV until both strategies settle.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fullDeck } from "../lib/poker/cards";
import { evaluateScore } from "../lib/poker/evaluator";
import { CLASSES, COMBOS, N_CLASSES, cardId } from "../lib/poker/ranges";

const SAMPLES = Number(process.argv[2] ?? 2500);
const ITERATIONS = 600;
const STACKS = Array.from({ length: 59 }, (_, i) => 1 + i * 0.5); // 1 … 30 BB

// ---- class-vs-class equity and combo weights
const byClass: number[][] = Array.from({ length: N_CLASSES }, () => []);
COMBOS.forEach((c, i) => byClass[c.cls].push(i));

const weight = Array.from({ length: N_CLASSES }, () => new Float64Array(N_CLASSES));
for (let i = 0; i < N_CLASSES; i++)
  for (let j = 0; j < N_CLASSES; j++)
    for (const a of byClass[i])
      for (const b of byClass[j]) {
        const x = COMBOS[a].ids;
        const y = COMBOS[b].ids;
        if (x[0] !== y[0] && x[0] !== y[1] && x[1] !== y[0] && x[1] !== y[1]) weight[i][j]++;
      }

const equity = Array.from({ length: N_CLASSES }, () => new Float64Array(N_CLASSES));
const deck = fullDeck();
const t0 = Date.now();
const handA = new Array(7);
const handB = new Array(7);
for (let i = 0; i < N_CLASSES; i++) {
  for (let j = i; j < N_CLASSES; j++) {
    let won = 0;
    let n = 0;
    for (let s = 0; s < SAMPLES; s++) {
      const a = COMBOS[byClass[i][(Math.random() * byClass[i].length) | 0]];
      const b = COMBOS[byClass[j][(Math.random() * byClass[j].length) | 0]];
      const ids = new Set([...a.ids, ...b.ids]);
      if (ids.size < 4) continue;
      handA[0] = a.cards[0];
      handA[1] = a.cards[1];
      handB[0] = b.cards[0];
      handB[1] = b.cards[1];
      let k = 2;
      while (k < 7) {
        const c = deck[(Math.random() * 52) | 0];
        const id = cardId(c);
        if (ids.has(id)) continue;
        ids.add(id);
        handA[k] = handB[k] = c;
        k++;
      }
      const sa = evaluateScore(handA);
      const sb = evaluateScore(handB);
      won += sa > sb ? 1 : sa === sb ? 0.5 : 0;
      n++;
    }
    equity[i][j] = n ? won / n : 0.5;
    equity[j][i] = 1 - equity[i][j];
  }
  if (i % 20 === 0) console.log(`equity matrix ${i}/${N_CLASSES} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// ---- fictitious play per stack
function solve(S: number) {
  const push = new Float64Array(N_CLASSES).fill(1);
  const call = new Float64Array(N_CLASSES).fill(0.5);
  for (let t = 1; t <= ITERATIONS; t++) {
    const brPush = new Float64Array(N_CLASSES);
    const brCall = new Float64Array(N_CLASSES);
    for (let i = 0; i < N_CLASSES; i++) {
      // Small blind: shove EV vs the big blind's calling strategy (fold = -0.5).
      let w = 0;
      let ev = 0;
      for (let j = 0; j < N_CLASSES; j++) {
        const wij = weight[i][j];
        if (!wij) continue;
        w += wij;
        ev += wij * ((1 - call[j]) * 1 + call[j] * (2 * S * equity[i][j] - S));
      }
      brPush[i] = ev / w > -0.5 ? 1 : 0;
    }
    for (let j = 0; j < N_CLASSES; j++) {
      // Big blind facing a shove: call EV vs the shoving range (fold = -1).
      let w = 0;
      let ev = 0;
      for (let i = 0; i < N_CLASSES; i++) {
        const wji = weight[j][i] * push[i];
        if (!wji) continue;
        w += wji;
        ev += wji * (2 * S * equity[j][i] - S);
      }
      brCall[j] = w && ev / w > -1 ? 1 : 0;
    }
    for (let k = 0; k < N_CLASSES; k++) {
      push[k] += (brPush[k] - push[k]) / (t + 1);
      call[k] += (brCall[k] - call[k]) / (t + 1);
    }
  }
  return { push, call };
}

const pushMax: Record<string, number> = {};
const callMax: Record<string, number> = {};
for (const c of CLASSES) pushMax[c] = callMax[c] = 0;
const share = (strategy: Float64Array) => {
  let n = 0;
  for (let i = 0; i < N_CLASSES; i++) if (strategy[i] >= 0.5) n += byClass[i].length;
  return ((n / COMBOS.length) * 100).toFixed(0);
};
for (const S of STACKS) {
  const { push, call } = solve(S);
  CLASSES.forEach((c, i) => {
    if (push[i] >= 0.5) pushMax[c] = S === STACKS[STACKS.length - 1] ? 99 : S;
    if (call[i] >= 0.5) callMax[c] = S === STACKS[STACKS.length - 1] ? 99 : S;
  });
  if (S % 5 === 0 || S === 1) console.log(`${S} BB: push ${share(push)}% · call ${share(call)}%`);
}

const out = join(__dirname, "../lib/poker/data/pushfold.json");
writeFileSync(out, JSON.stringify({ push: pushMax, call: callMax }));
console.log(`wrote ${out}`);
for (const c of ["AA", "A2o", "K2o", "Q7o", "J5s", "T2o", "72o", "32o"]) console.log(`  ${c}: push ≤ ${pushMax[c]} BB, call ≤ ${callMax[c]} BB`);
