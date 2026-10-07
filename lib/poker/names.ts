/**
 * Opponent usernames, built from parts like real online poker pseudonyms:
 * prefix + core word + optional ending, in one of three writing styles.
 * Over a million distinct names (check: `npx tsx scripts/count-names.ts`).
 */
import { randomInt } from "./cards";

export const PREFIXES = [
  "Le", "La", "Big", "Lil", "Mr", "Dr", "King", "Lucky", "Crazy", "Silent",
  "Royal", "Golden", "Dark", "Iron", "Wild", "Cool", "Fast", "Slow", "Grand", "Petit",
  "Super", "Mega", "Ultra", "Old", "Young", "Red", "Blue", "Black", "White", "Sly",
  "Shy", "Mad", "Bad", "Good", "Hot", "Ice", "Sharp", "Smooth", "Lazy", "Happy",
  "Angry", "Sneaky", "Brave", "Bold", "Calm", "Deep", "Easy", "Quick", "Tiny", "Giant",
  "Nice", "Rich", "Poor", "Pure", "Real", "True", "Zen", "Epic", "Loose", "Tight",
];

export const CORES = [
  "Shark", "Fish", "Donk", "Nit", "Whale", "Tiger", "Fox", "Wolf", "Bear", "Eagle",
  "Requin", "Loup", "Renard", "Ace", "Queen", "Jack", "River", "Turn", "Flop", "Bluff",
  "Nuts", "Pot", "Chip", "Stack", "Shove", "Spin", "Cooler", "Grinder", "Reg", "Rookie",
  "Bandit", "Pirate", "Ninja", "Samurai", "Viking", "Cowboy", "Joker", "Dealer", "Gambler", "Hunter",
  "Sniper", "Rocket", "Thunder", "Storm", "Phoenix", "Dragon", "Panther", "Cobra", "Falcon", "Raven",
  "Lion", "Rhino", "Bison", "Otter", "Badger", "Mamba", "Viper", "Hawk", "Owl", "Crab",
  "Octopus", "Squid", "Croco", "Gorilla", "Monkey", "Panda", "Koala", "Lynx", "Puma", "Jaguar",
  "Coyote", "Hyena", "Tortue", "Lapin", "Chat", "Chien", "Coq", "Taureau", "Baron", "Comte",
  "Duc", "Prince", "Chef", "Boss", "Capo", "Parrain", "Barbu", "Toto", "Titi", "Bebert",
  "Dede", "Jojo", "Lulu", "Nono", "Kiki", "Fifou", "Zizou", "Gege", "Momo", "Riri",
  "Fanfan", "Pepito", "Tonton", "Papy", "Bobby", "Johnny", "Freddy", "Jimmy", "Billy", "Danny",
  "Kenny", "Tommy", "Sammy", "Mickey", "Maverick", "Bandido", "Caillou", "Tonnerre", "Eclair", "Volcan",
];

/** "" (no ending), 00–99, and a few word endings. None of the word endings are digits, so names never collide. */
export const ENDINGS = [
  "",
  ...Array.from({ length: 100 }, (_, i) => String(i).padStart(2, "0")),
  "FR", "Pro", "Poker", "KO", "AA", "KK", "QQ", "JJ", "GTO", "OG",
  "Jr", "Sr", "II", "III", "Bzh", "Paris", "Lyon", "Nice", "Lille", "Nantes",
  "Max", "Zero", "One", "Prime", "Elite", "Star", "Live", "Win", "Gg", "Wp",
  "Lol", "Xx", "Yo", "Bro", "Dz", "Mtl", "Ch", "Be", "Lu",
];

export type NameStyle = "camel" | "snake" | "lower";
export const STYLES: NameStyle[] = ["camel", "snake", "lower"];

/** Longest name that fits on a seat plate. */
export const MAX_NAME_LENGTH = 15;

export function buildName(prefix: string, core: string, ending: string, style: NameStyle): string {
  const parts = [prefix, core, ending].filter(Boolean);
  switch (style) {
    case "camel":
      return parts.join("");
    case "snake":
      return parts.join("_").toLowerCase();
    case "lower":
      return parts.join("").toLowerCase();
  }
}

/** One random opponent name (resampled until it fits on a seat). */
export function randomName(): string {
  for (;;) {
    const name = buildName(
      PREFIXES[randomInt(PREFIXES.length)],
      CORES[randomInt(CORES.length)],
      ENDINGS[randomInt(ENDINGS.length)],
      STYLES[randomInt(STYLES.length)],
    );
    if (name.length <= MAX_NAME_LENGTH) return name;
  }
}

/** `count` different names, none equal (ignoring case) to any in `exclude`. */
export function randomNames(count: number, exclude: string[] = []): string[] {
  const taken = new Set(exclude.map((n) => n.toLowerCase()));
  const out: string[] = [];
  while (out.length < count) {
    const name = randomName();
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}
