const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
function show(text, ok) { const o = $("out"); o.className = text ? "msg " + (ok ? "ok" : "err") : ""; o.textContent = text || ""; }

async function refresh() {
  const s = await chrome.storage.sync.get({ radarUrl: "https://nimbl-radar-app.onrender.com", key: "" });
  const sel = $("url");
  if (![...sel.options].some((o) => o.value === s.radarUrl)) { const o = document.createElement("option"); o.value = o.textContent = s.radarUrl; sel.appendChild(o); }
  sel.value = s.radarUrl;
  if (!s.key) { $("signedIn").hidden = true; $("signedOut").hidden = false; return; }
  const r = await chrome.runtime.sendMessage({ type: "api", method: "GET", path: "/me" });
  if (!r || !r.ok) {
    $("signedIn").hidden = true; $("signedOut").hidden = false;
    show((r && r.error) || "Couldn't reach Radar.", false);
    return;
  }
  const u = r.data;
  const photo = await chrome.runtime.sendMessage({ type: "photo", email: u.email });
  $("who").innerHTML = (photo ? '<img src="' + esc(photo) + '" alt="">' : '<span class="ini">' + esc(initials(u.name)) + "</span>") +
    "<div><strong>" + esc(u.name) + (u.isOwner ? '<span class="chip">Owner</span>' : "") + '</strong><span class="help">Signed in as ' + esc(u.email) + "</span></div>";
  $("signedOut").hidden = true; $("signedIn").hidden = false;
}

$("signin").addEventListener("click", () => chrome.runtime.sendMessage({ type: "signIn" }));
$("switch").addEventListener("click", () => chrome.runtime.sendMessage({ type: "signIn" }));
$("signout").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "signOut" });
  show(r && r.revoked ? "Signed out. This browser is disconnected from Radar." : "Signed out on this browser.", true);
  refresh();
});
$("save").addEventListener("click", async () => {
  const key = $("key").value.trim();
  if (!/^rk_[A-Za-z0-9_-]{20,}$/.test(key)) { show("That doesn't look like a Radar key. It starts with rk_.", false); return; }
  await chrome.storage.sync.set({ radarUrl: $("url").value, key });
  $("key").value = "";
  show("Saved.", true);
  refresh();
});
$("url").addEventListener("change", () => chrome.storage.sync.set({ radarUrl: $("url").value }));
// When the Radar tab hands over a key, update straight away.
chrome.storage.onChanged.addListener((ch, area) => { if (area === "sync" && ch.key) { show(ch.key.newValue ? "Connected." : "", true); refresh(); } });
refresh();
