// Toolbar popup: Home (or your profile) on any site.
let radarUrl = "https://nimbl-radar-app.onrender.com";
let view = "home";            // "home" or "profile"
let scope = "team";
let me = null;
const box = document.getElementById("home");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = (method, path) => chrome.runtime.sendMessage({ type: "api", method, path });

function signedOut(msg) {
  me = null; drawChip();
  box.innerHTML = (msg ? '<p class="msg err">' + esc(msg) + "</p>" : "") +
    '<div class="card"><p><strong>Sign in to connect the extension to your Radar account.</strong></p>' +
    '<p class="help">Use your Nimbl Google account, the same as Radar.</p>' +
    '<div class="row"><button class="btn btn-primary" type="button" data-act="signin">Sign in with Google</button></div></div>';
}
function drawChip() {
  document.getElementById("chip").innerHTML = me ? window.RadarHome.chip(me, { photos: true }, view === "profile") : "";
  document.getElementById("title").textContent = view === "profile" ? "Your profile" : "Radar home";
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "settings" });
  radarUrl = s.radarUrl;
  scope = (await chrome.storage.local.get({ homeScope: "team" })).homeScope === "me" ? "me" : "team";
  if (!s.hasKey) { signedOut(); return; }
  box.innerHTML = '<p class="help">Loading…</p>';
  const [m, r] = await Promise.all([api("GET", "/me"), view === "profile" ? api("GET", "/profile") : api("GET", "/home?scope=" + scope)]);
  if (m && m.ok) me = m.data;
  drawChip();
  if (!r || !r.ok) { if (r && r.needsKey) signedOut(r.error); else box.innerHTML = '<p class="msg err">' + esc((r && r.error) || "Couldn't reach Radar.") + "</p>"; return; }
  box.innerHTML = view === "profile"
    ? window.RadarHome.renderProfile(r.data, { radarUrl: r.radarUrl, photos: true })
    : window.RadarHome.render(r.data, { radarUrl: r.radarUrl, popup: true });
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.getAttribute("data-act");
  if (act === "profile") { view = view === "profile" ? "home" : "profile"; load(); return; }
  if (act === "scope") { scope = b.getAttribute("data-scope") === "me" ? "me" : "team"; await chrome.storage.local.set({ homeScope: scope }); load(); return; }
  if (act === "signin") { chrome.runtime.sendMessage({ type: "signIn" }); window.close(); return; }
  if (act === "signout") {
    if (!confirm("Sign this browser out of Radar? You can sign in again any time.")) return;
    await chrome.runtime.sendMessage({ type: "signOut" });
    view = "home"; signedOut();
    return;
  }
  if (act === "key-revoke") {
    const r = await chrome.runtime.sendMessage({ type: "api", method: "DELETE", path: "/keys/" + encodeURIComponent(b.getAttribute("data-id")) });
    if (!r || !r.ok) alert((r && r.error) || "Couldn't disconnect it.");
    load();
  }
});
load();
document.getElementById("reload").addEventListener("click", load);
document.getElementById("open").addEventListener("click", () => { chrome.tabs.create({ url: radarUrl + "/" }); window.close(); });
document.getElementById("settings").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
