/// <reference types="chrome" />
/**
 * Expresso AI coach: runs the trained agent inside the page on http://localhost:3000.
 * Reads the table from the DOM (same as ai/play_browser.py), computes the agent's
 * features with the shared ai/agent.ts code, runs the exported network, then shows
 * the recommended move and, if autoplay is on, clicks it.
 */
import { ACTIONS, EQUITY_FEATURE, EQUITY_ITERATIONS, type ConcreteAction, type Observation, actionTable, featurize } from "../../ai/agent";

interface Layer {
  in: number;
  out: number;
  w: number[];
  b: number[];
}
interface Model {
  checkpoint: string;
  games: number;
  win: number;
  layers: { in: number; out: number; w: Float32Array; b: Float32Array }[];
}
interface Settings {
  suggest: boolean;
  autoplay: boolean;
  /** Autoplay waits a random time in [minDelayMs, maxDelayMs] before acting, like a person thinking. */
  minDelayMs: number;
  maxDelayMs: number;
}

const DEFAULTS: Settings = { suggest: true, autoplay: false, minDelayMs: 1000, maxDelayMs: 3000 };
let settings: Settings = { ...DEFAULTS };
let model: Model | null = null;

/* ------------------------------------------------------------------ model */

async function loadModel(): Promise<Model> {
  const res = await fetch(chrome.runtime.getURL("model.json"));
  const raw = (await res.json()) as { checkpoint: string; games: number; win: number; layers: Layer[] };
  return {
    ...raw,
    layers: raw.layers.map((l) => ({ in: l.in, out: l.out, w: Float32Array.from(l.w), b: Float32Array.from(l.b) })),
  };
}

/** Action probabilities from the network, illegal actions set to 0. */
function policy(m: Model, x: number[], mask: boolean[]): number[] {
  let h = Float32Array.from(x);
  m.layers.forEach((layer, i) => {
    const out = new Float32Array(layer.out);
    for (let o = 0; o < layer.out; o++) {
      let sum = layer.b[o];
      const row = o * layer.in;
      for (let k = 0; k < layer.in; k++) sum += layer.w[row + k] * h[k];
      out[o] = i < m.layers.length - 1 ? Math.tanh(sum) : sum;
    }
    h = out;
  });
  const logits = Array.from(h).map((v, i) => (mask[i] ? v : -Infinity));
  const max = Math.max(...logits);
  const exp = logits.map((v) => (Number.isFinite(v) ? Math.exp(v - max) : 0));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / total);
}

/* ------------------------------------------------------------- table reader */

function readTable(): Observation | null {
  const felt = document.querySelector<HTMLElement>(".table-felt");
  if (!felt || !document.querySelector("[data-action]")) return null;
  const seat = (pos: string) => {
    const d = document.querySelector<HTMLElement>(`.seat[data-position="${pos}"]`)!.dataset;
    return {
      stack: Number(d.stack),
      bet: Number(d.bet),
      out: d.out === "true",
      folded: d.folded === "true",
      allIn: d.allin === "true",
      dealer: d.dealer === "true",
      lastAction: d.lastAction || "",
      level: d.botLevel || "",
    };
  };
  const cards = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((e) => e.dataset.card!);
  const range = document.querySelector<HTMLInputElement>(".raise-slider input[type=range]");
  const obs: Observation = {
    seats: [seat("bottom"), seat("left"), seat("right")],
    hole: cards(".seat-bottom .seat-cards [data-card]"),
    board: cards(".board [data-card]"),
    sb: Number(felt.dataset.sb),
    bb: Number(felt.dataset.bb),
    level: Number(felt.dataset.level),
    pot: Number(felt.dataset.pot),
    canCheck: !!document.querySelector("[data-action=check]"),
    canRaise: !!document.querySelector("[data-action=raise]"),
    minRaiseTo: range ? Number(range.min) : 0,
    maxRaiseTo: range ? Number(range.max) : 0,
  };
  return obs.hole.length === 2 ? obs : null;
}

/* ------------------------------------------------------------------ acting */

function describe(move: ConcreteAction, obs: Observation): string {
  const currentBet = Math.max(...obs.seats.map((s) => s.bet));
  const toCall = currentBet - obs.seats[0].bet;
  switch (move.type) {
    case "fold":
      return "Fold";
    case "check":
      return "Check";
    case "call":
      return `Call ${Math.min(toCall, obs.seats[0].stack).toLocaleString("en-GB")}`;
    case "raise":
      if (move.amount === obs.maxRaiseTo) return `All-in ${move.amount.toLocaleString("en-GB")}`;
      return `${currentBet === 0 ? "Bet" : "Raise to"} ${move.amount!.toLocaleString("en-GB")}`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Type into the React-controlled raise box like a user would. */
function setRaiseAmount(amount: number) {
  const input = document.querySelector<HTMLInputElement>(".raise-input");
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, String(amount));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

async function perform(move: ConcreteAction) {
  if (move.type !== "raise") {
    document.querySelector<HTMLButtonElement>(`[data-action=${move.type}]`)?.click();
    return;
  }
  if (!setRaiseAmount(move.amount!)) return;
  // Wait for React to show the new amount on the button before clicking it.
  for (let i = 0; i < 20; i++) {
    await sleep(25);
    const button = document.querySelector<HTMLButtonElement>("[data-action=raise]");
    if (!button) return;
    if (button.textContent?.replace(/\D/g, "").endsWith(String(move.amount))) {
      button.click();
      return;
    }
  }
}

/* ------------------------------------------------------------------ panel */

const panel = document.createElement("div");
panel.id = "ai-coach";
const style = document.createElement("style");
style.textContent = `
#ai-coach { position: fixed; bottom: 76px; left: 16px; z-index: 2147483647; width: 250px;
  background: rgb(14 14 18 / 0.94); color: #f4f4f6; border: 1px solid #2e2e38; border-radius: 12px;
  padding: 12px; font: 13px/1.35 system-ui, sans-serif; box-shadow: 0 10px 30px rgb(0 0 0 / 0.5); }
#ai-coach.hidden { display: none; }
#ai-coach .t { display: flex; justify-content: space-between; align-items: center; font-weight: 700; margin-bottom: 8px; }
#ai-coach .badge { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 99px; background: #2b2b35; color: #9a9aa8; }
#ai-coach .badge.on { background: #e3001b; color: #fff; }
#ai-coach .move { font-size: 22px; font-weight: 800; margin: 2px 0 2px; letter-spacing: 0.01em; }
#ai-coach .move.fold { color: #bbb; } #ai-coach .move.check, #ai-coach .move.call { color: #4ade80; }
#ai-coach .move.raise { color: #ff4d5e; }
#ai-coach .sub { color: #9a9aa8; font-size: 12px; margin-bottom: 8px; }
#ai-coach .row { display: grid; grid-template-columns: 78px 1fr 38px; gap: 6px; align-items: center; margin: 3px 0; font-size: 12px; }
#ai-coach .row.off { opacity: 0.35; }
#ai-coach .row.best { font-weight: 700; }
#ai-coach .bar { height: 6px; border-radius: 99px; background: #2b2b35; overflow: hidden; }
#ai-coach .bar i { display: block; height: 100%; background: #e3001b; }
#ai-coach .row.best .bar i { background: #f5c542; }
#ai-coach .pct { text-align: right; font-variant-numeric: tabular-nums; }
#ai-coach .foot { margin-top: 8px; color: #6f6f7c; font-size: 11px; }
`;

function render(html: string) {
  panel.innerHTML = html;
  panel.classList.toggle("hidden", !settings.suggest && !settings.autoplay);
}

function header() {
  return `<div class="t"><span>Expresso AI</span><span class="badge ${settings.autoplay ? "on" : ""}">${settings.autoplay ? "AUTOPLAY" : "COACH"}</span></div>`;
}

function footer() {
  return model ? `<div class="foot">${model.checkpoint} · ${model.games.toLocaleString("en-GB")} games · ${(model.win * 100).toFixed(1)}% in training</div>` : "";
}

function renderIdle(text: string) {
  render(`${header()}<div class="sub">${text}</div>${footer()}`);
}

function renderDecision(obs: Observation, probs: number[], moves: ConcreteAction[], mask: boolean[], best: number, equity: number) {
  const rows = ACTIONS.map(
    (name, i) => `<div class="row ${mask[i] ? "" : "off"} ${i === best ? "best" : ""}">
      <span>${name}</span><span class="bar"><i style="width:${(probs[i] * 100).toFixed(1)}%"></i></span>
      <span class="pct">${mask[i] ? (probs[i] * 100).toFixed(0) + "%" : "—"}</span></div>`,
  ).join("");
  const label = describe(moves[best], obs);
  const opponents = obs.seats.slice(1).filter((s) => !s.out && !s.folded).length;
  render(`${header()}
    <div class="move ${moves[best].type}">${label}</div>
    <div class="sub">${obs.hole.join(" ")}${obs.board.length ? " · " + obs.board.join(" ") : ""} · equity ${(equity * 100).toFixed(0)}% vs ${opponents}</div>
    ${rows}${footer()}`);
}

/* ------------------------------------------------------------------- loop */

let lastKey: string | null = null;
let acting = false;

async function tick() {
  if (!model || acting) return;
  const obs = readTable();
  if (!obs) {
    lastKey = null;
    renderIdle(document.querySelector(".table-felt") ? "Waiting for your turn…" : "Open a table to get advice.");
    return;
  }
  const key = JSON.stringify(obs);
  if (key === lastKey) return;
  lastKey = key;

  const x = featurize(obs, EQUITY_ITERATIONS.play);
  const { actions, mask } = actionTable(obs);
  const probs = policy(model, x, mask);
  const best = probs.indexOf(Math.max(...probs));
  renderDecision(obs, probs, actions, mask, best, x[EQUITY_FEATURE]);

  if (settings.autoplay) {
    acting = true;
    try {
      const lo = Math.min(settings.minDelayMs, settings.maxDelayMs);
      const hi = Math.max(settings.minDelayMs, settings.maxDelayMs);
      const delay = lo + Math.random() * (hi - lo);
      panel.querySelector(".move")?.insertAdjacentHTML("afterend", `<div class="sub">Autoplay: playing in ${(delay / 1000).toFixed(1)}s…</div>`);
      await sleep(delay);
      // Only act if the table is still waiting on the same decision.
      if (JSON.stringify(readTable()) === key) await perform(actions[best]);
    } finally {
      acting = false;
    }
  }
}

async function main() {
  document.head.append(style);
  document.body.append(panel);
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  settings = { ...DEFAULTS, ...stored } as Settings;
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, v] of Object.entries(changes)) (settings as unknown as Record<string, unknown>)[k] = v.newValue;
    lastKey = null; // re-render (and act, if autoplay was just enabled)
  });
  renderIdle("Loading model…");
  try {
    model = await loadModel();
  } catch {
    renderIdle("No model found. Run <b>npm run extension</b>, then reload the extension.");
    return;
  }
  setInterval(tick, 120);
}

main();
