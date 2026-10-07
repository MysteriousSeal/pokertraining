const DEFAULTS = { suggest: true, autoplay: false, minDelayMs: 1000, maxDelayMs: 3000 };

const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS).then((s) => {
  $("suggest").checked = s.suggest;
  $("autoplay").checked = s.autoplay;
  $("minDelayMs").value = s.minDelayMs;
  $("maxDelayMs").value = s.maxDelayMs;
  showDelay();
});

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
function showDelay() {
  $("delayValue").textContent = `${secs($("minDelayMs").value)} – ${secs($("maxDelayMs").value)}`;
}

$("suggest").addEventListener("change", (e) => chrome.storage.local.set({ suggest: e.target.checked }));
$("autoplay").addEventListener("change", (e) => chrome.storage.local.set({ autoplay: e.target.checked }));
// Keep min ≤ max: moving one slider past the other drags it along.
$("minDelayMs").addEventListener("input", () => {
  const min = Number($("minDelayMs").value);
  if (Number($("maxDelayMs").value) < min) $("maxDelayMs").value = min;
  saveDelay();
});
$("maxDelayMs").addEventListener("input", () => {
  const max = Number($("maxDelayMs").value);
  if (Number($("minDelayMs").value) > max) $("minDelayMs").value = max;
  saveDelay();
});
function saveDelay() {
  showDelay();
  chrome.storage.local.set({ minDelayMs: Number($("minDelayMs").value), maxDelayMs: Number($("maxDelayMs").value) });
}

fetch(chrome.runtime.getURL("model.json"))
  .then((r) => r.json())
  .then((m) => {
    $("info").textContent = `Model ${m.checkpoint} · ${m.games.toLocaleString("en-GB")} games · ${(m.win * 100).toFixed(1)}% in training · active on localhost:3000`;
  })
  .catch(() => {
    $("info").textContent = "No model.json yet: run `npm run extension`, then reload the extension.";
  });
