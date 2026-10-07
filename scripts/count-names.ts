// Enumerate every opponent name the generator can produce: `npx tsx scripts/count-names.ts`
import { CORES, ENDINGS, MAX_NAME_LENGTH, PREFIXES, STYLES, buildName, randomNames } from "../lib/poker/names";

const all = new Set<string>();
let tooLong = 0;
for (const p of PREFIXES)
  for (const c of CORES)
    for (const e of ENDINGS)
      for (const st of STYLES) {
        const name = buildName(p, c, e, st);
        if (name.length > MAX_NAME_LENGTH) tooLong++;
        else all.add(name);
      }
const combos = PREFIXES.length * CORES.length * ENDINGS.length * STYLES.length;
console.log(`${PREFIXES.length} prefixes × ${CORES.length} cores × ${ENDINGS.length} endings × ${STYLES.length} styles = ${combos.toLocaleString("en-GB")} combinations`);
console.log(`${tooLong.toLocaleString("en-GB")} longer than ${MAX_NAME_LENGTH} characters (never used)`);
console.log(`distinct usable names: ${all.size.toLocaleString("en-GB")}`);
console.log(`samples: ${randomNames(12).join(", ")}`);
if (all.size < 1_000_000) process.exit(1);
