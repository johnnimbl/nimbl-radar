let radarUrl = "https://nimbl-radar-app.onrender.com";
chrome.runtime.sendMessage({ type: "settings" }).then(async (s) => {
  radarUrl = s.radarUrl;
  const el = document.getElementById("state");
  if (!s.hasKey) { el.textContent = "Not connected yet: add your Radar key in Settings."; return; }
  const r = await chrome.runtime.sendMessage({ type: "api", method: "GET", path: "/ping" });
  el.textContent = r && r.ok ? "Connected to Radar" + (r.data.user ? " (" + r.data.user + ")" : "") + "." : (r && r.error) || "Couldn't reach Radar.";
});
document.getElementById("open").addEventListener("click", () => { chrome.tabs.create({ url: radarUrl + "/" }); window.close(); });
document.getElementById("settings").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
