const DEFAULTS = { suggest: true, autoplay: false, delayMs: 700 };

const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS).then((s) => {
  $("suggest").checked = s.suggest;
  $("autoplay").checked = s.autoplay;
  $("delayMs").value = s.delayMs;
  $("delayValue").textContent = `${(s.delayMs / 1000).toFixed(1)}s`;
});

$("suggest").addEventListener("change", (e) => chrome.storage.local.set({ suggest: e.target.checked }));
$("autoplay").addEventListener("change", (e) => chrome.storage.local.set({ autoplay: e.target.checked }));
$("delayMs").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  $("delayValue").textContent = `${(v / 1000).toFixed(1)}s`;
  chrome.storage.local.set({ delayMs: v });
});

fetch(chrome.runtime.getURL("model.json"))
  .then((r) => r.json())
  .then((m) => {
    $("info").textContent = `Model ${m.checkpoint} · ${m.games.toLocaleString("en-GB")} games · ${(m.win * 100).toFixed(1)}% in training · active on localhost:3000`;
  })
  .catch(() => {
    $("info").textContent = "No model.json yet: run `npm run extension`, then reload the extension.";
  });
