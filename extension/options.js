const $ = (id) => document.getElementById(id);
function show(text, ok) { const o = $("out"); o.className = "msg " + (ok ? "ok" : "err"); o.textContent = text; }

chrome.storage.sync.get({ radarUrl: "https://nimbl-radar-app.onrender.com", key: "" }).then((s) => {
  const sel = $("url");
  if (![...sel.options].some((o) => o.value === s.radarUrl)) {
    const o = document.createElement("option"); o.value = o.textContent = s.radarUrl; sel.appendChild(o);
  }
  sel.value = s.radarUrl;
  $("key").value = s.key;
});

$("save").addEventListener("click", async () => {
  const key = $("key").value.trim();
  if (!/^rk_[A-Za-z0-9_-]{20,}$/.test(key)) { show("That doesn't look like a Radar key. It starts with rk_.", false); return; }
  await chrome.storage.sync.set({ radarUrl: $("url").value, key });
  show("Saved. Testing the connection…", true);
  const r = await chrome.runtime.sendMessage({ type: "api", method: "GET", path: "/ping" });
  if (r && r.ok) show("Connected to Radar" + (r.data.user ? " as " + r.data.user : "") + ". Open a LinkedIn profile to try it.", true);
  else show((r && r.error) || "Couldn't reach Radar.", false);
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.sync.set({ key: "" });
  $("key").value = "";
  show("Key removed from this browser.", true);
});
