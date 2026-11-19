let radarUrl = "https://nimbl-radar-app.onrender.com";
const box = document.getElementById("home");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "settings" });
  radarUrl = s.radarUrl;
  if (!s.hasKey) { box.innerHTML = '<p class="msg err">Not connected yet: add your Radar key in Settings.</p>'; return; }
  box.innerHTML = '<p class="help">Loading your Radar numbers…</p>';
  const r = await chrome.runtime.sendMessage({ type: "api", method: "GET", path: "/home" });
  if (!r || !r.ok) { box.innerHTML = '<p class="msg err">' + esc((r && r.error) || "Couldn't reach Radar.") + "</p>"; return; }
  box.innerHTML = window.RadarHome.render(r.data, { radarUrl: r.radarUrl, popup: true });
}
load();
document.getElementById("reload").addEventListener("click", load);
document.getElementById("open").addEventListener("click", () => { chrome.tabs.create({ url: radarUrl + "/" }); window.close(); });
document.getElementById("settings").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
